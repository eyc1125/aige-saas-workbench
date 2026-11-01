/**
 * 宿主机命令执行（MCP 的 `exec_command` 用的就是它）
 * ==================================================================
 * 【为什么不直接 `child_process.exec`】
 *   后端跑在 Alpine 容器里（node:20-alpine），容器里**没有宿主机那套工具**：
 *   没有 nginx / pm2 / 宿主机的 node，`/www/wwwroot` 也不在容器里（除非显式挂载）。
 *   在容器内执行 `unzip`、`docker compose up` 这类部署命令，基本都跑不通 ——
 *   看着像「命令执行」，实际是在一个空壳环境里空转，比没有更误导人。
 *
 * 【怎么做到「真的在宿主机上执行」】
 *   借 Docker Engine 起一个**一次性容器**，让它
 *   `nsenter -t 1 -m -u -i -n -p -- /bin/sh -c '<cmd>'`
 *   进入宿主机的 mount / uts / ipc / net / pid 命名空间再执行 ——
 *   等价于在宿主机终端里敲命令（PATH、工具链、目录、环境变量全是宿主机的）。
 *   容器用完即删，名字统一 `aige-exec-<随机串>`，便于审计与残留清理。
 *
 * 【安全边界（按主人要求做实，不是"意思一下"）】
 *   ① `cwd` 必须落在 EXEC_ROOT（默认 `/www/wwwroot`）之内 —— 纯字符串规范化后校验，
 *      `..` 穿越直接拒；
 *   ② 高危命令黑名单：删根、格盘、关机、fork bomb、`curl | sh` … 命中即拒，
 *      不做「部分执行」，也不静默降级；
 *   ③ 超时可配（默认 120 秒，上限 600 秒）；到点 `kill` 容器并**显式**回 TIMEOUT，
 *      绝不让调用方把「被掐断」误读成「命令执行失败」；
 *   ④ 每次执行都写审计日志（命令、目录、退出码、耗时、是否超时）。
 *
 *   ⚠️ 它本身就是**全权能力**：能执行命令 = 能改服务器上任何东西。
 *      所以它归入 `WRITE_TOOLS` —— 只读令牌的连接里连清单都不会出现。
 */
'use strict';

const crypto = require('node:crypto');
const { DockerClient } = require('./docker');
const { AppError, badRequest, upstream } = require('../utils/errors');

/** 允许执行的工作目录根（解析后必须落在它之内） */
const EXEC_ROOT = normalizeRoot(process.env.EXEC_ROOT || '/www/wwwroot');
/** 超时上限（秒）：再长就该拆成「起任务 + 轮询」了，而不是让一个 HTTP 请求挂着 */
const MAX_TIMEOUT_SEC = clampInt(process.env.EXEC_MAX_TIMEOUT_SECONDS, 600, 10, 600);
/** 默认超时（秒） */
const DEFAULT_TIMEOUT_SEC = Math.min(120, MAX_TIMEOUT_SEC);
/** 运行时镜像：默认自动挑（见 pickRuntimeImage），可用 EXEC_IMAGE 强制指定 */
const IMAGE_OVERRIDE = String(process.env.EXEC_IMAGE || '').trim();
/** stdout / stderr 各自最多回多少字节（保留**尾部**，报错通常在末尾） */
const OUTPUT_LIMIT = 64 * 1024;
/** 一次性容器名前缀：既方便在 docker ps 里认出来，也方便残留清理 */
const CONTAINER_PREFIX = 'aige-exec-';

/**
 * 高危命令黑名单。
 * ⚠️ 原则：**宁可错拦一条，也不放过一条**。命中就明确告诉调用方「被哪条规则拦了、
 *    确需执行请走服务器终端」，而不是含糊地说"命令不合法"。
 */
const DANGEROUS_PATTERNS = [
  { re: /\brm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*[rf][a-zA-Z]*\s+\/(\s|$)/, why: '递归删除根目录' },
  { re: /\brm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*[rf][a-zA-Z]*\s+\/\*/, why: '递归删除根目录下全部文件' },
  { re: /\bmkfs(\.[a-z0-9]+)?\b/i, why: '格式化磁盘' },
  { re: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|vd|hd|xvd)/i, why: '直接写裸磁盘设备' },
  { re: /:\s*\(\s*\)\s*\{[^}]*\}\s*;\s*:/, why: 'fork bomb' },
  { re: /\b(shutdown|poweroff|halt)\b/i, why: '关机' },
  { re: /\breboot\b/i, why: '重启服务器' },
  { re: /\binit\s+[06]\b/, why: '切换运行级别（会关机 / 重启）' },
  { re: /\bkill\s+(-[A-Z0-9]+\s+)*-?9\s+1\b/, why: '杀 PID 1（会带走整台机器的进程树）' },
  { re: /\bkillall5\b/, why: '向全部进程发信号' },
  { re: />\s*\/dev\/(sd|nvme|vd|hd|xvd)/i, why: '重定向写裸磁盘设备' },
  { re: /\bchmod\s+(-[a-zA-Z]+\s+)*[0-7]*777\s+\/(\s|$)/, why: '把根目录改成 777' },
  { re: /\bchown\s+(-[a-zA-Z]+\s+)*\S+\s+\/(\s|$)/, why: '改根目录属主' },
  { re: /\bchattr\s+-[a-zA-Z]*i[a-zA-Z]*\s+\//, why: '给根目录加不可变属性' },
  {
    re: /\b(curl|wget)\b[^\n|]*\|\s*(ba|z|da)?sh\b/,
    why: '下载后直接管道执行（请先下载、看清内容再执行）',
  },
  { re: /\/dev\/tcp\//, why: '反弹 shell' },
  { re: /\bnc\b[^\n]*\s-[a-zA-Z]*e\b/, why: 'netcat 反弹 shell' },
  { re: /\bhistory\s+-c\b/, why: '清空历史（会破坏审计线索）' },
  { re: />\s*\/etc\/(passwd|shadow|sudoers)\b/, why: '覆写系统账户文件' },
  { re: /\buserdel\s+(-[a-zA-Z]+\s+)*root\b/, why: '删除 root 账号' },
  { re: /\biptables\s+-F\b/, why: '清空防火墙规则（可能把自己锁在门外）' },
  {
    re: /\brm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*[rf][a-zA-Z]*\s+\/etc(\s|\/|$)/,
    why: '删除 /etc',
  },
  {
    re: /\brm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*[rf][a-zA-Z]*\s+\/root(\s|\/|$)/,
    why: '删除 /root',
  },
  {
    re: /\brm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*[rf][a-zA-Z]*\s+\/var(\s|\/|$)/,
    why: '删除 /var',
  },
];

/** 进程内缓存的运行时镜像（探测一次，后续复用） */
let runtimeImage = '';
/** 探测过程中的 Promise（并发调用只探测一次） */
let probing = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 去掉末尾斜杠；空值回退到 /www/wwwroot */
function normalizeRoot(value) {
  const raw = String(value || '').trim() || '/www/wwwroot';
  const noTail = raw.replace(/\/+$/, '') || '/';
  return noTail.startsWith('/') ? noTail : `/${noTail}`;
}

/**
 * 把 cwd 规范成**绝对路径**并校验落在 EXEC_ROOT 内。
 * 不依赖宿主机的 realpath（后端容器不一定看得到 /www 的真实结构），
 * 所以先做纯字符串规范化：拆段、消掉 `.` 与 `..`。
 */
function resolveCwd(input) {
  const raw = String(input || '').trim();
  const base = raw || EXEC_ROOT;
  if (!base.startsWith('/')) {
    throw badRequest(
      `cwd 必须是绝对路径（当前收到「${base}」）。默认是 ${EXEC_ROOT}，例如 ${EXEC_ROOT}/my-site`
    );
  }

  const segments = [];
  for (const part of base.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  const abs = `/${segments.join('/')}`;

  const inside = abs === EXEC_ROOT || abs.startsWith(`${EXEC_ROOT}/`);
  if (!inside) {
    throw badRequest(
      `cwd「${abs}」不在允许的根目录 ${EXEC_ROOT} 之内。` +
        '这是刻意的限制：命令只在站点根下开工；其他位置请改用 read_file / 宝塔面板或服务器终端。'
    );
  }
  return abs;
}

/** 校验命令本身：非空 + 黑名单 */
function assertCommand(command) {
  const cmd = String(command || '').trim();
  if (!cmd) throw badRequest('command 不能为空');

  // 压掉多余空白只用于匹配，不影响真正执行的原文
  const flat = cmd.replace(/\s+/g, ' ');
  for (const rule of DANGEROUS_PATTERNS) {
    if (rule.re.test(flat) || rule.re.test(cmd)) {
      throw new AppError(
        `命令被安全黑名单拦下了（${rule.why}）。如果确实需要在服务器上做这件事，` +
          '请直接登录服务器终端执行 —— 这个工具刻意不提供这类操作。',
        403,
        'COMMAND_BLOCKED',
        { rule: rule.why, command: cmd }
      );
    }
  }
  return cmd;
}

/** 单引号安全包裹（用于把路径拼进 sh -c 字符串） */
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** 截断输出：超出上限时保留尾部并标注 */
function clip(text) {
  const s = String(text || '');
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= OUTPUT_LIMIT) return { text: s, truncated: false, bytes: buf.length };
  const tail = buf.subarray(buf.length - OUTPUT_LIMIT).toString('utf8');
  return {
    text: `…（前面 ${buf.length - OUTPUT_LIMIT} 字节已截断，以下为尾部）\n${tail}`,
    truncated: true,
    bytes: buf.length,
  };
}

/**
 * 解 Docker 日志流（8 字节头 + 负载，多路复用）。
 * 头里第 1 个字节区分来源：1 = stdout，2 = stderr —— 分开收集，
 * 这样返回给调用方的 stdout / stderr 才是真的两路，而不是"混在一起再猜"。
 */
function demux(buffer) {
  const empty = { stdout: '', stderr: '' };
  if (!Buffer.isBuffer(buffer) || !buffer.length) return empty;

  const out = [];
  const err = [];
  let offset = 0;
  let guard = 0;
  let framed = false;

  while (offset + 8 <= buffer.length && guard < 200000) {
    guard += 1;
    const stream = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);
    if ((stream !== 0 && stream !== 1 && stream !== 2) || size < 0) break;
    if (offset + 8 + size > buffer.length) break;
    const payload = buffer.subarray(offset + 8, offset + 8 + size).toString('utf8');
    if (stream === 2) err.push(payload);
    else out.push(payload);
    offset += 8 + size;
    framed = true;
  }

  // 没解出标准帧（某些后端 / TTY 模式会给纯文本）→ 原样当 stdout，不要凭空丢内容
  if (!framed) return { stdout: buffer.toString('utf8'), stderr: '' };
  return { stdout: out.join(''), stderr: err.join('') };
}

/** Docker 客户端（本机 socket）。复用同一个实例，避免每次执行都重新探测 API 版本 */
let sharedClient = null;
function client() {
  if (!sharedClient) {
    sharedClient = new DockerClient({ host: 'unix:///var/run/docker.sock' });
  }
  return sharedClient;
}

/** 本地镜像名列表（形如 alpine:3.20 / nginx:1.31-alpine） */
async function localImageTags(c) {
  try {
    const raw = await c.request('/images/json?all=false');
    const tags = [];
    for (const img of Array.isArray(raw) ? raw : []) {
      for (const t of img.RepoTags || []) {
        if (t && t !== '<none>:<none>') tags.push(t);
      }
    }
    return tags;
  } catch {
    return [];
  }
}

/**
 * 挑一个**能跑 nsenter** 的运行时镜像。
 * 优先级：显式指定 > 纯 alpine > 任意 alpine 基础镜像。
 * 一个都没有就拉 alpine:3.20（busybox 自带 nsenter，体积也最小）。
 */
async function pickRuntimeImage(c) {
  if (IMAGE_OVERRIDE) return IMAGE_OVERRIDE;

  const tags = await localImageTags(c);
  const prefer = [
    (t) => /^alpine:/.test(t),
    (t) => /(^|\/)alpine:/.test(t),
    (t) => /alpine/.test(t),
    (t) => /^nginx:.*alpine/.test(t),
    (t) => /^node:.*alpine/.test(t),
  ];
  for (const test of prefer) {
    const hit = tags.find(test);
    if (hit) return hit;
  }

  const fallback = 'alpine:3.20';
  try {
    console.log(`[exec] 本地没有 alpine 镜像，尝试拉取 ${fallback} …`);
    await c.pullImage(fallback);
  } catch (err) {
    throw upstream(
      `没有可用的运行时镜像，拉取 ${fallback} 也失败了：${err.message}。` +
        '可以在 .env 里设置 EXEC_IMAGE 指定一个本地已有的 alpine 基础镜像。'
    );
  }
  return fallback;
}

/** 取（并在必要时探测）运行时镜像 */
async function ensureRuntimeImage() {
  if (runtimeImage) return runtimeImage;
  if (!probing) {
    probing = (async () => {
      const image = await pickRuntimeImage(client());
      runtimeImage = image;
      console.log(`[exec] 宿主机命令执行使用镜像：${image}`);
      return image;
    })();
  }
  try {
    return await probing;
  } finally {
    probing = null;
  }
}

/** 启动时预热：日志里能早点看到用的是哪个镜像，出问题不必等第一次调用才发现 */
async function warmUp() {
  try {
    await ensureRuntimeImage();
  } catch (err) {
    console.warn(`[exec] 运行时准备失败（首次调用时会再试）：${err.message}`);
  }
}

/**
 * 在宿主机上执行一条命令。
 * @param {object} args
 * @param {string} args.command 要执行的命令（交给宿主机 /bin/sh -c）
 * @param {string} [args.cwd]  工作目录，必须在 EXEC_ROOT 之内
 * @param {number} [args.timeoutSeconds] 超时秒数（默认 120，上限 600）
 * @returns {Promise<{
 *   exitCode:number|null, stdout:string, stderr:string, durationMs:number,
 *   timedOut:boolean, timeoutSeconds:number, cwd:string, command:string,
 *   image:string, container:string, truncated:{stdout:boolean,stderr:boolean}
 * }>}
 */
async function run({ command, cwd, timeoutSeconds } = {}) {
  const cmd = assertCommand(command);
  const workdir = resolveCwd(cwd);
  const timeoutSec = clampInt(timeoutSeconds, DEFAULT_TIMEOUT_SEC, 1, MAX_TIMEOUT_SEC);

  const c = client();
  const image = await ensureRuntimeImage();

  const containerName = `${CONTAINER_PREFIX}${Date.now().toString(36)}-${crypto
    .randomBytes(3)
    .toString('hex')}`;

  // 进入宿主机命名空间后：
  //   ① 先把「宝塔装的 Node 工具链」补进 PATH（实测 `pnpm` 只在
  //      /www/server/nodejs/vXX/bin 下，系统 /usr/bin 里没有 → 用 pnpm 的项目必然
  //      `pnpm: command not found`，这是很典型的一种「部署不了」）；
  //   ② 再 cd 到目标目录执行 —— 与「在终端里先 cd 再敲命令」等价。
  const pathFix =
    'for d in /www/server/nodejs/*/bin /www/server/nvm/versions/node/*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done; export PATH;';
  const wrapped = `${pathFix} cd ${shQuote(workdir)} && ${cmd}`;

  const createBody = {
    Image: image,
    Cmd: ['nsenter', '-t', '1', '-m', '-u', '-i', '-n', '-p', '--', '/bin/sh', '-c', wrapped],
    WorkingDir: '/',
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    // ⛔ 刻意**不打** aige.managed 标签：那个标签会让自愈巡检把它当成本项目的常驻容器，
    //    它一退出就触发一次「容器挂了」的处理 —— 而它本来就是执行完即删的一次性容器。
    Labels: { 'aige.exec': 'true' },
    HostConfig: {
      // 进宿主机命名空间必须有这些；权限因此是全权的 —— 边界靠 cwd / 黑名单 / 审计来守
      Privileged: true,
      PidMode: 'host',
      NetworkMode: 'host',
      IpcMode: 'host',
      UtsMode: 'host',
      // 不自动删除：超时被 kill 之后还要读日志，最后由这里统一删
      AutoRemove: false,
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '1' } },
    },
  };

  let created;
  try {
    created = await c.request(`/containers/create?name=${encodeURIComponent(containerName)}`, {
      method: 'POST',
      body: createBody,
      timeout: 60000,
    });
  } catch (err) {
    throw upstream(
      `创建执行容器失败：${err.message}。若提示镜像不存在，请检查 .env 里的 EXEC_IMAGE。`
    );
  }

  const id = created?.Id;
  if (!id) throw upstream('创建执行容器失败：Docker 没有返回容器 ID');

  const startedAt = Date.now();
  let exitCode = null;
  let timedOut = false;
  let failure = null;

  try {
    await c.request(`/containers/${encodeURIComponent(id)}/start`, { method: 'POST' });

    const waitOnce = (timeoutMs) =>
      c.request(`/containers/${encodeURIComponent(id)}/wait?condition=not-running`, {
        method: 'POST',
        timeout: timeoutMs,
      });

    const raced = await Promise.race([
      waitOnce(timeoutSec * 1000 + 15000).then((r) => ({ done: true, r })),
      sleep(timeoutSec * 1000).then(() => ({ done: false })),
    ]);

    if (raced.done) {
      exitCode = Number(raced.r?.StatusCode ?? 0);
    } else {
      // 超时：显式标记 + 立刻杀容器，再等一次拿退出码（137 = SIGKILL）
      timedOut = true;
      try {
        await c.request(`/containers/${encodeURIComponent(id)}/kill?signal=SIGKILL`, {
          method: 'POST',
          timeout: 15000,
        });
      } catch {
        /* 容器可能刚好自己退出了，忽略 */
      }
      try {
        const r = await waitOnce(20000);
        exitCode = Number(r?.StatusCode ?? 137);
      } catch {
        exitCode = 137;
      }
    }
  } catch (err) {
    failure = err;
  }

  const durationMs = Date.now() - startedAt;

  // 日志必须在删除容器之前读
  let rawLogs = Buffer.alloc(0);
  try {
    rawLogs = await c.request(
      `/containers/${encodeURIComponent(id)}/logs?stdout=true&stderr=true&timestamps=false`,
      { raw: true, timeout: 20000 }
    );
  } catch {
    /* 读不到日志不影响「命令已经执行过」这个事实 */
  }

  // 清理：无论成功失败都不留容器
  try {
    await c.request(`/containers/${encodeURIComponent(id)}?force=true&v=true`, {
      method: 'DELETE',
      timeout: 20000,
    });
  } catch {
    /* 删不掉就留着下次清理，不阻塞本次返回 */
  }

  const split = demux(rawLogs);
  const out = clip(split.stdout);
  const err = clip(split.stderr);

  // 镜像里没有 nsenter 是个很具体的环境问题，值得单独给一句人话提示
  if (exitCode === 127 && /nsenter.*not found|not found.*nsenter/i.test(out.text + err.text)) {
    failure = upstream(
      `运行时镜像 ${image} 里没有 nsenter，无法进入宿主机命名空间。` +
        '请在 .env 里把 EXEC_IMAGE 换成任意 alpine 基础镜像（busybox 自带 nsenter）。'
    );
  }

  if (failure) throw failure;

  return {
    exitCode,
    stdout: out.text,
    stderr: err.text,
    durationMs,
    timedOut,
    timeoutSeconds: timeoutSec,
    cwd: workdir,
    command: cmd,
    image,
    container: containerName,
    truncated: { stdout: out.truncated, stderr: err.truncated },
  };
}

module.exports = {
  run,
  warmUp,
  EXEC_ROOT,
  MAX_TIMEOUT_SEC,
  DEFAULT_TIMEOUT_SEC,
  // 供自检使用
  resolveCwd,
  assertCommand,
  DANGEROUS_PATTERNS,
};
