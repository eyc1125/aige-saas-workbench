/**
 * 站点配置快照（变更历史）与一键回滚
 * ------------------------------------------------------------------
 * 背景：`baota.saveNginxConfig()` 每次写配置前都会把原文件备份成
 *      `<域名>.conf.bak.<时间戳>`，但**备份了却没有任何入口能回滚** ——
 *      等于买了保险却没留理赔电话。
 *
 * 这里补上三件事：
 *   1. 列出某站点自己的全部备份（只认 `<站点名>.conf.bak.<数字>`）
 *   2. 任意两份配置做行级差异（备份 ↔ 备份、备份 ↔ 当前线上）
 *   3. 一键回滚：把某份备份写回线上；**回滚前先把当前配置也备份一次**，
 *      所以"回滚"这个动作本身也能被再回滚回去
 *
 * ⚠️ 安全第一：备份目录里躺着**全服务器所有站点**的配置
 *    （koyca / rpoiyc / tito-* … 都不属于本项目）。
 *    一个 `../` 就能读到别的项目的配置 —— 这是本项目最不能出的问题。
 *    所以两道白名单校验，任一不过直接拒绝，不做任何"尽力而为"的路径拼接：
 *      · 站点名：不允许含 `/` `\` NUL，不允许 `..`，不允许以 `.` 开头
 *      · 备份文件名：必须以 `<站点名>.conf.bak.` 开头，且尾部只能是 10~16 位数字
 *    换句话说，即使前端传了恶意站点名，也拼不出这个目录之外的路径。
 *
 * ⚠️ 关于「配置写坏了会怎样」：nginx 遇到语法错误时 `reload` 会失败，
 *    **master 会继续用旧配置跑**，站点不会因此断掉。所以回滚是"覆盖语义错误"
 *    用的（比如 proxy_pass 指错了），不是防语法错误用的。
 */
'use strict';

const baotaService = require('./baota');
const { badRequest, notFound } = require('../utils/errors');
const { request } = require('../utils/http');
const { assertSiteName, assertSnapshotFileName, snapshotTimestamp } = require('../utils/safePath');

const NGINX_VHOST_DIR = baotaService.NGINX_VHOST_DIR;

/** 虚拟条目：代表"当前线上正在生效的配置" */
const CURRENT = '__current__';

/** 差异对比最多看多少行（防止有人拿超长文件把内存和响应打爆） */
const DIFF_MAX_LINES = 1500;

// ============================================================
// 校验（实现放在 utils/safePath.js —— 零依赖，CI 里可直接断言）
// ============================================================

/** 站点名白名单校验：任何可能越出配置目录的字符都不放过 */
const assertSite = assertSiteName;

/** 备份文件名白名单校验：必须是本站点自己的 .conf.bak.<数字> */
const assertBackupFile = assertSnapshotFileName;

/** 允许 `__current__` 或本站点自己的备份文件 */
function resolveTarget(siteName, file) {
  if (file === CURRENT) return { kind: 'current', path: `${NGINX_VHOST_DIR}/${siteName}.conf` };
  assertBackupFile(siteName, file);
  return { kind: 'backup', path: `${NGINX_VHOST_DIR}/${file}` };
}

/** 备份文件名里的时间戳 → 可读时间 */
function tsFromName(file) {
  const ms = snapshotTimestamp(file);
  if (!ms) return null;
  return { ms, text: new Date(ms).toLocaleString('zh-CN') };
}

// ============================================================
// 列表
// ============================================================

/**
 * 列出某站点的配置快照
 * @param {string} siteName
 * @returns {Promise<{siteName:string, dir:string, current:object|null, snapshots:Array}>}
 */
async function listSnapshots(siteName) {
  const site = assertSite(siteName);

  // 一次把配置目录列出来，本地过滤（宝塔没有"按前缀列文件"的接口）。
  // 上限放到 2000：这台机器上同时有多个项目，配置 + 备份加起来可能几百个文件，
  // 用默认的 200 会把部分站点的备份截掉。
  const dir = await baotaService.createClient().listDir(NGINX_VHOST_DIR, 2000);
  const entries = Array.isArray(dir.entries) ? dir.entries : [];

  const prefix = `${site}.conf.bak.`;
  const snapshots = entries
    .filter((e) => !e.isDir && String(e.name).startsWith(prefix))
    .map((e) => {
      const ts = tsFromName(e.name);
      return {
        file: e.name,
        size: e.size,
        sizeText: e.sizeText,
        createdAt: ts ? ts.text : e.modifiedAt || '',
        ts: ts ? ts.ms : 0,
      };
    })
    .sort((a, b) => b.ts - a.ts);

  // 当前线上的配置：单独读一次拿大小（宝塔的目录列表里没有内容长度以外的信息，
  // 而我们需要"当前是否存在"这个判断来给前端一个明确的对照）
  const currentEntry = entries.find((e) => !e.isDir && e.name === `${site}.conf`);
  let current = null;
  if (currentEntry) {
    current = {
      file: CURRENT,
      size: currentEntry.size,
      sizeText: currentEntry.sizeText,
      createdAt: currentEntry.modifiedAt || '',
      ts: 0,
      isCurrent: true,
    };
  }

  return {
    siteName: site,
    dir: NGINX_VHOST_DIR,
    current,
    snapshots,
    // 备份文件名带时间戳，但时间是"写入时刻"，不是"这份配置从什么时候开始生效" ——
    // 这点在界面上容易误解，所以这里直接返回一句提示给前端用
    hint: '每份备份是本系统上一次改动前的原配置。时间戳为备份创建时刻，即该配置被替换下来的时刻。',
  };
}

// ============================================================
// 读取与差异
// ============================================================

/** 读取指定目标（当前线上 / 某份备份）的内容 */
async function readTarget(siteName, file) {
  const site = assertSite(siteName);
  const target = resolveTarget(site, file);
  const content = await baotaService.createClient().readFile(target.path);
  if (content === null || content === undefined) {
    throw notFound(
      target.kind === 'current' ? '该站点还没有 Nginx 配置文件' : '备份文件不存在或已被清理'
    );
  }
  return { siteName: site, file, path: target.path, content };
}

/**
 * 行级差异（Myers 简化版：先算 LCS 长度表，再回溯生成操作序列）
 * 只返回"有改动的地方 + 前后各 4 行上下文"，未改动的整段折叠成一行提示 ——
 * 几百行的配置全量返回会让响应和渲染都变得很重，而人其实只看改动。
 */
function lineDiff(aText, bText, context = 4) {
  const a = String(aText ?? '')
    .split('\n')
    .slice(0, DIFF_MAX_LINES);
  const b = String(bText ?? '')
    .split('\n')
    .slice(0, DIFF_MAX_LINES);
  const n = a.length;
  const m = b.length;

  // LCS 长度表。用 Uint16 而不是普通数组：行数上限 1500，长度不会溢出，
  // 内存从 O(n*m) 个 JS 数字（每个 ~8 字节）降到 2 字节。
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: 'same', text: a[i], aNo: i + 1, bNo: j + 1 });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: 'del', text: a[i], aNo: i + 1, bNo: null });
      i += 1;
    } else {
      ops.push({ t: 'add', text: b[j], aNo: null, bNo: j + 1 });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ t: 'del', text: a[i], aNo: i + 1, bNo: null });
    i += 1;
  }
  while (j < m) {
    ops.push({ t: 'add', text: b[j], aNo: null, bNo: j + 1 });
    j += 1;
  }

  // 只保留改动附近的行
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.t === 'same') return;
    const from = Math.max(0, idx - context);
    const to = Math.min(ops.length - 1, idx + context);
    for (let k = from; k <= to; k += 1) keep[k] = true;
  });

  const lines = [];
  let skipped = 0;
  ops.forEach((op, idx) => {
    if (keep[idx]) {
      if (skipped) {
        lines.push({ t: 'skip', text: `…… 略过 ${skipped} 行未改动 ……`, skipped });
        skipped = 0;
      }
      lines.push(op);
    } else {
      skipped += 1;
    }
  });
  if (skipped) lines.push({ t: 'skip', text: `…… 略过 ${skipped} 行未改动 ……`, skipped });

  return {
    lines,
    added: ops.filter((o) => o.t === 'add').length,
    removed: ops.filter((o) => o.t === 'del').length,
    truncated:
      String(aText ?? '').split('\n').length > DIFF_MAX_LINES ||
      String(bText ?? '').split('\n').length > DIFF_MAX_LINES,
  };
}

/**
 * 对比两份配置
 * @param {string} siteName
 * @param {string} a 左（通常是"当前线上"）
 * @param {string} b 右（通常是"要回滚到的那份备份"）
 */
async function compare(siteName, a, b) {
  const left = await readTarget(siteName, a);
  const right = await readTarget(siteName, b);
  const diff = lineDiff(left.content, right.content);
  return {
    siteName,
    left: { file: a, path: left.path, lines: String(left.content).split('\n').length },
    right: { file: b, path: right.path, lines: String(right.content).split('\n').length },
    ...diff,
  };
}

// ============================================================
// 回滚
// ============================================================

/**
 * 一键回滚到指定备份
 * ------------------------------------------------------------------
 * 走的就是 `saveNginxConfig()` —— 它内部会**先把当前配置备份一次**，
 * 所以回滚之后想反悔，再回滚一次即可（整条链路是可逆的）。
 *
 * 回滚后额外做一次 HTTP 探活：这是唯一能真正回答"站点恢复了没有"的检查。
 * 探活失败**不算操作失败**（可能是 Cloudflare 缓存、也可能是站点本来就是 403），
 * 只把状态码如实报出来给用户判断。
 */
async function restore(siteName, file) {
  const site = assertSite(siteName);
  const target = resolveTarget(site, file);
  if (target.kind === 'current') throw badRequest('不能把"当前配置"回滚到它自己');

  const snapshot = await readTarget(site, file);
  if (!String(snapshot.content).trim())
    throw badRequest('该备份内容为空，已拒绝回滚（避免写入空配置）');

  const result = await baotaService.createClient().saveNginxConfig(site, snapshot.content);
  const probe = await probeSite(site);

  return {
    siteName: site,
    restoredFrom: file,
    // 回滚时又产生了一份新备份（内容 = 回滚前的配置），出问题可以再回滚回去
    backupOfRolledBack: result.backupPath,
    reloadOk: result.reload,
    probe,
  };
}

/**
 * 探活：请求站点自己的域名，返回状态码
 * 这是回滚后唯一有说服力的"是否恢复"证据，所以如实报，不做美化。
 *
 * 注意 `utils/http.js` 的 request 在非 2xx 时会**抛错**（不是返回 Response），
 * 真实的上游状态码藏在 `err.detail.status` 里。所以这里要分三种情况：
 *   成功 → 200；抛错但带 detail.status → 站点其实有响应（403/404/5xx）；
 *   抛错且没有状态码 → 真的连不上（DNS / 超时 / TLS）。
 */
async function probeSite(domain) {
  try {
    await request(`https://${domain}/`, {
      method: 'GET',
      timeout: 8000,
      raw: true,
      serviceName: '站点探活',
    });
    return { ok: true, status: 200, text: 'HTTP 200' };
  } catch (err) {
    const status = err?.detail?.status;
    if (status) {
      // 能拿到状态码 = 站点活着，只是这个路径返回了 3xx/4xx/5xx
      return { ok: status < 400, status, text: `HTTP ${status}` };
    }
    return { ok: false, status: null, text: `探活未成功：${err.message}` };
  }
}

module.exports = {
  listSnapshots,
  compare,
  restore,
  readTarget,
  probeSite,
  CURRENT,
  // 导出给测试/CI 用，便于验证路径校验真的挡得住
  assertSite,
  assertBackupFile,
};
