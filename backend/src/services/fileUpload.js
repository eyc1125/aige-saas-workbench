/**
 * 通用文件落盘（MCP 的 `upload_file` 用它）
 * ==================================================================
 * 【为什么需要它】
 *   老的上传入口只服务蒲公英：写死 `.apk / .ipa / .hap`，其余一律
 *   `INVALID_FILE_TYPE`。于是「部署一个项目」这件事在 MCP 侧是断的 ——
 *   代码包（.zip / .tar.gz）、SQL、配置（.json / .env）全都传不上来。
 *
 * 【它做什么】
 *   把收到的字节**原样**落到服务器上的指定目录，并算好 sha256 交回去。
 *   · 扩展名：白名单（可配），至少覆盖 .zip/.tar.gz/.txt/.json/.env/.sql/.whl
 *   · 大小：单文件上限可配（默认 200MB）
 *   · 目录：必须落在 UPLOAD_ROOT（默认 /www）之内，防穿越
 *   · 写入：先写 `.part-xxx` 再 rename —— 半截文件不会以正式文件名出现
 *   · 覆盖：默认不覆盖，显式 overwrite=true 才替换
 *
 * ⚠️ 刻意**不做**「改扩展名绕过」那种兼容：白名单里没有的类型就是不给传，
 *    要传二进制请直接给一个明确的常规扩展名，而不是把它伪装成 .apk。
 */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { AppError, badRequest } = require('../utils/errors');

/** 上传根：所有落盘路径都必须落在它之内（默认 /www，和宝塔的站点根同一层） */
const UPLOAD_ROOT = normalizeRoot(process.env.UPLOAD_ROOT || '/www');
/** 默认目标目录 */
const DEFAULT_DIR = normalizeRoot(process.env.UPLOAD_DEFAULT_DIR || '/www/upload');
/** 单文件上限（MB） */
const MAX_MB = clampInt(process.env.UPLOAD_MAX_MB, 200, 1, 2048);
const MAX_BYTES = MAX_MB * 1024 * 1024;

/**
 * 允许的扩展名（小写、不含点）。
 * ⚠️ 刻意**不含** .php / .phtml / .jsp / .asp / .aspx / .cgi / .pl：
 *    这些是「传上去就能被 Web 直接执行」的类型，不是我们需要的部署产物；
 *    真要执行代码请走 exec_command，那条路有黑名单与审计，比"悄悄放一个 webshell"清楚得多。
 */
const DEFAULT_EXTENSIONS = [
  // 压缩包 / 归档
  'zip',
  'tar',
  'gz',
  'tgz',
  'tar.gz',
  'bz2',
  'xz',
  '7z',
  'rar',
  // 数据与配置
  'txt',
  'json',
  'env',
  'sql',
  'sqlite',
  'sqlite3',
  'db',
  'csv',
  'log',
  'yml',
  'yaml',
  'toml',
  'ini',
  'conf',
  'properties',
  'lock',
  'xml',
  'map',
  'md',
  // 制品
  'whl',
  'jar',
  'war',
  'apk',
  'ipa',
  'hap',
  'bin',
  'node',
  // 源码（A 股前端 / 脚本，作为「部署产物的一层」很常见）
  'js',
  'mjs',
  'cjs',
  'css',
  'html',
  'ts',
  'vue',
  'py',
  'go',
  'java',
  'rs',
  'sh',
  // 图片 / 文档（站点素材、说明文档）
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'svg',
  'ico',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  // 证书（部署 HTTPS 时常一起传）
  'pem',
  'crt',
  'key',
];

/**
 * 实际生效的白名单：环境变量 `UPLOAD_ALLOWED_EXT` 给了就以它为准（逗号分隔）。
 */
const ALLOWED_EXTENSIONS = (() => {
  const raw = String(process.env.UPLOAD_ALLOWED_EXT || '').trim();
  if (!raw) return new Set(DEFAULT_EXTENSIONS);
  const list = raw
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
  return new Set(list.length ? list : DEFAULT_EXTENSIONS);
})();

/** 去掉末尾斜杠；不以 / 开头时补上 */
function normalizeRoot(value) {
  const raw = String(value || '').trim();
  const noTail = raw.replace(/\/+$/, '');
  if (!noTail) return '/';
  return noTail.startsWith('/') ? noTail : `/${noTail}`;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 取文件名的扩展名（支持 .tar.gz 这种双段）。
 * 返回不含点的小写字符串；取不到返回 ''。
 */
function extensionOf(fileName) {
  const name = String(fileName || '').toLowerCase();
  // 从最长的组合往短里试，优先命中 .tar.gz 而不是 .gz
  const parts = name.split('.');
  if (parts.length < 2) return '';
  for (let take = Math.min(3, parts.length - 1); take >= 1; take -= 1) {
    const ext = parts.slice(-take).join('.');
    if (ALLOWED_EXTENSIONS.has(ext)) return ext;
  }
  return parts.slice(1).join('.');
}

/** 校验并规范化文件名（不含目录） */
function assertFileName(input) {
  const name = String(input || '').trim();
  if (!name) throw badRequest('fileName 不能为空');
  if (name.length > 255) throw badRequest('文件名过长（最多 255 个字符）');
  if (/[/\\\0]/.test(name)) {
    throw badRequest('fileName 只能是文件名，不能带路径分隔符（目录请用 targetDir）');
  }
  if (name === '.' || name === '..' || name.startsWith('..')) {
    throw badRequest('fileName 不合法（不允许 .. 之类的相对路径片段）');
  }
  // 只拦「一定会出事」的字符：控制字符（含 NUL）与路径分隔符。
  // 中文、空格、括号这些都放行 —— 真实项目里中文名的资料文件很常见，没必要逼人改名。
  if (/[/\\]/.test(name)) {
    throw badRequest('fileName 不能包含路径分隔符（目录请用 targetDir）');
  }
  if ([...name].some((ch) => ch.codePointAt(0) < 0x20 || ch.codePointAt(0) === 0x7f)) {
    throw badRequest('fileName 不能包含控制字符');
  }

  const ext = extensionOf(name);
  if (!ext) {
    throw badRequest(
      `fileName「${name}」没有扩展名，无法判断类型。请带上扩展名（如 .zip / .tar.gz）`
    );
  }
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new AppError(
      `不支持 .${ext} 类型。允许的类型：${[...ALLOWED_EXTENSIONS].sort().join(', ')}。` +
        '（这个白名单可用环境变量 UPLOAD_ALLOWED_EXT 调整）',
      400,
      'INVALID_FILE_TYPE',
      { extension: ext }
    );
  }
  return name;
}

/**
 * 校验并规范化目标目录。
 * 必须在 UPLOAD_ROOT 之内 —— `..` 穿越会在这里被消掉后再判。
 */
function resolveDir(input) {
  const raw = String(input || '').trim() || DEFAULT_DIR;
  if (!raw.startsWith('/')) {
    throw badRequest(`targetDir 必须是绝对路径（当前收到「${raw}」）。默认是 ${DEFAULT_DIR}`);
  }

  const segments = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  const abs = `/${segments.join('/')}`;

  const inside = UPLOAD_ROOT === '/' || abs === UPLOAD_ROOT || abs.startsWith(`${UPLOAD_ROOT}/`);
  if (!inside) {
    throw badRequest(
      `targetDir「${abs}」不在允许的上传根 ${UPLOAD_ROOT} 之内。` +
        '这是刻意的限制：上传只能落在站点/数据目录下，不能往 /etc、/root 这类系统目录写。'
    );
  }
  return abs;
}

/** 组装最终的落盘计划（不碰磁盘，纯校验） */
function prepare({ fileName, targetDir }) {
  const name = assertFileName(fileName);
  const dir = resolveDir(targetDir);
  const finalPath = path.posix.join(dir, name);
  return { dir, name, finalPath, ext: extensionOf(name) };
}

/** 文件是否已存在 */
async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把流写到目标文件（边写边算 sha256，并强制大小上限）。
 * @param {import('node:stream').Readable} stream
 * @param {object} opts { fileName, targetDir, overwrite }
 * @returns {Promise<{path:string, size:number, sha256:string, overwritten:boolean, dir:string, fileName:string}>}
 */
async function saveStream(stream, { fileName, targetDir, overwrite = false } = {}) {
  const plan = prepare({ fileName, targetDir });

  await fsp.mkdir(plan.dir, { recursive: true });

  const already = await exists(plan.finalPath);
  if (already && !overwrite) {
    throw new AppError(
      `目标文件已存在：${plan.finalPath}。要替换请显式传 overwrite=true（或换一个文件名）。`,
      409,
      'FILE_EXISTS',
      { path: plan.finalPath }
    );
  }

  const tmpPath = `${plan.finalPath}.part-${crypto.randomBytes(4).toString('hex')}`;
  const hash = crypto.createHash('sha256');
  let size = 0;
  let tooLarge = false;

  const meter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > MAX_BYTES) {
        tooLarge = true;
        cb(
          new AppError(
            `文件超过单文件上限 ${MAX_MB}MB（已收到 ${Math.round(size / 1024 / 1024)}MB 就断了）。` +
              '可以换更小的包，或用环境变量 UPLOAD_MAX_MB 调大上限。',
            413,
            'FILE_TOO_LARGE'
          )
        );
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });

  try {
    await pipeline(stream, meter, fs.createWriteStream(tmpPath, { mode: 0o644 }));
    if (tooLarge) throw new AppError(`文件超过单文件上限 ${MAX_MB}MB`, 413, 'FILE_TOO_LARGE');
    await fsp.rename(tmpPath, plan.finalPath);
  } catch (err) {
    // 半截文件绝不以正式文件名留着；.part 也要清掉
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    if (err instanceof AppError) throw err;
    throw new AppError(`写入文件失败：${err.message}`, 500, 'WRITE_FAILED');
  }

  return {
    path: plan.finalPath,
    dir: plan.dir,
    fileName: plan.name,
    size,
    sha256: hash.digest('hex'),
    overwritten: already,
    extension: plan.ext,
  };
}

/**
 * 把一段 Buffer 写到目标文件（服务器自己从 URL 下载下来时用）。
 * @param {Buffer} buffer
 * @param {object} opts { fileName, targetDir, overwrite }
 */
async function saveBuffer(buffer, opts = {}) {
  const { Readable } = require('node:stream');
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw badRequest('没有收到文件内容');
  }
  if (buffer.length > MAX_BYTES) {
    throw new AppError(`文件超过单文件上限 ${MAX_MB}MB`, 413, 'FILE_TOO_LARGE');
  }
  return saveStream(Readable.from(buffer), opts);
}

/**
 * `/www` 是不是**从宿主机挂进来的**。
 * ⛔ 很重要：如果 compose 忘了挂载，上传会悄悄写进容器内层的 /www ——
 *    接口返回的路径看着完全正常，但宿主机上根本找不到这个文件。
 *    所以启动时就要把这件事喊出来，而不是等使用者去 ls 一个不存在的文件。
 */
function rootMounted() {
  try {
    const mountinfo = fs.readFileSync('/proc/self/mountinfo', 'utf8');
    return mountinfo.split('\n').some((line) => {
      const fields = line.split(' ');
      // mountinfo 第 5 个字段（下标 4）是挂载点
      return fields[4] === UPLOAD_ROOT;
    });
  } catch {
    return false;
  }
}

/** 启动自检：把「上传根是否真的通到宿主机」打到日志里 */
function selfCheck() {
  const mounted = rootMounted();
  if (mounted) {
    console.log(`[upload] 上传根 ${UPLOAD_ROOT} 已从宿主机挂载（写进去就是宿主机上的文件）`);
  } else {
    console.warn(
      `[upload] ⚠️ 上传根 ${UPLOAD_ROOT} 看起来**没有**从宿主机挂载：` +
        '上传的文件会落在容器内层，宿主机上看不到。请在 docker-compose.yml 的 backend.volumes 里加 "- /www:/www"。'
    );
  }
  return { root: UPLOAD_ROOT, defaultDir: DEFAULT_DIR, maxBytes: MAX_BYTES, mounted };
}

module.exports = {
  saveStream,
  saveBuffer,
  prepare,
  extensionOf,
  assertFileName,
  resolveDir,
  selfCheck,
  rootMounted,
  UPLOAD_ROOT,
  DEFAULT_DIR,
  MAX_BYTES,
  MAX_MB,
  ALLOWED_EXTENSIONS,
};
