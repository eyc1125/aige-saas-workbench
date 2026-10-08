/**
 * 蒲公英只读客户端（B7 应用分发看板）
 * ------------------------------------------------------------------
 * ⛔ 这里**只做读**：列应用（listMy）、看应用详情（view）。
 *
 * 为什么不在工作台里实现「上传」：
 *   蒲公英官方已经给了完整的上传工具链 —— 官方 MCP（本地 stdio，**能直接读本机 APK**）、
 *   官方 CLI、Jenkins/Fastlane/Action 插件。在服务端再实现一遍是重复造轮子，
 *   而且有三个实打实的麻烦：大文件要过一遍这台 2GB 内存的服务器、要新增 multipart 解析依赖、
 *   要验证腾讯云 COS 的跨域。所以上传交给官方工具链，本工作台只负责「看得见」。
 *
 * 接口约定（来自官方 API 2.0 文档，已核对，不是凭记忆写的）：
 *   · 所有请求 POST + `Content-Type: application/x-www-form-urlencoded`
 *   · 鉴权参数 `_api_key`；返回 `{ code, message, data }`，`code === 0` 才是成功
 *   · 失败时 HTTP 往往仍是 200，**必须看 code**，不能只看状态码
 */
'use strict';

const config = require('../config');
const settings = require('./settings');
const { AppError, notConfigured, upstream } = require('../utils/errors');

/** 缓存有效期：这类数据变化很慢（一次上传才变），没必要每次刷新都打接口 */
const CACHE_TTL = 60 * 1000;
const TIMEOUT_MS = 15000;
/** 列表最多翻几页（正常个人账号一页就够） */
const MAX_PAGES = 5;

/**
 * 单个安装包上限：**100MB**。
 * 这不是随便定的 —— 三处卡的都是这个数，取最小那个：
 *   ① 前端容器 nginx 的 client_max_body_size
 *   ② 宝塔站点 nginx 的 client_max_body_size（100m）
 *   ③ **Cloudflare 免费版单次上传上限就是 100MB**（面板域名挂在 CF 后面）
 * 也就是说即使把 nginx 放宽，超过 100MB 也会被 CF 拦掉。
 */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** 传到对象存储的超时（20MB 的包正常几秒，给足余量） */
const UPLOAD_TIMEOUT_MS = 180000;
/** 轮询发布结果：官方 Node 示例是 1 秒一次、最多 60 次，跟着来 */
const POLL_INTERVAL_MS = 1500;
const POLL_MAX = 40;
/** 蒲公英「正在解析」的业务码（取自官方 Node 示例，不是猜的） */
const CODE_PARSING = 1247;

const cache = new Map();

// ============================================================
// 配置
// ============================================================

function apiKey() {
  return String(settings.get('pgyer_api_key') || '').trim();
}

function isConfigured() {
  return !!apiKey();
}

/** 缺配置时给明确的指引，而不是一个看不懂的 1001 */
function assertConfigured() {
  if (!apiKey()) {
    throw notConfigured('蒲公英尚未配置，请先到「系统设置 → 应用分发」填写 API Key');
  }
}

// ============================================================
// 缓存
// ============================================================

function readCache(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function writeCache(key, value) {
  cache.set(key, { at: Date.now(), value });
  return value;
}

function clearCache() {
  cache.clear();
}

// ============================================================
// 请求
// ============================================================

/**
 * 蒲公英的错误码 → 人话。
 * 官方文档里 HTTP 常常是 200，错在业务 code 上，所以这张表是唯一能给出
 * 「用户该做什么」的地方 —— 只报「code: 1002」等于没报。
 */
const CODE_HINT = {
  1001: 'API Key 为空，请到「系统设置 → 应用分发」填写',
  1002: 'API Key 不正确，请核对后重新填写',
  1005: '文件上传失败',
  1009: '没有找到该应用（可能已被删除，或被其他账号上传）',
  1012: '该接口需要「用户 KEY」，请到「系统设置 → 应用分发」一并填写',
  1013: '没找到这个蒲公英用户，请核对账号',
  1018: '应用数量已超过当前套餐上限，需要先清理或在蒲公英上升级套餐',
  1022: '文件过大，当前套餐不支持这个体积的安装包',
  1026: '文件类型不对，只支持 .ipa / .apk / .hap',
  1045: '用户 KEY 无效，请重新填写',
  1049: '应用下载次数已用完',
  1054: '今日下载次数已用完，明天再来',
  1055: 'API Key 无效（可能已被重置），请到蒲公英后台重新获取',
  1081: '非法请求（多半是某个必填参数缺失）',
  // 1249 是**实测**拿到的（上传一个假的 .apk 时蒲公英返回的原文是英文，换成人话）
  1249: '这个文件不是有效的安装包（蒲公英解析不了）。请确认它是正常的 .apk / .ipa / .hap，没损坏、后缀没错',
};

/**
 * 「用户自己传错了」这一类业务码。
 * 这类要按 **400** 返回，不能一律当 502 上游错误 —— 502 会让用户以为是服务器的问题，
 * 而这几个码明明是他换个文件就能解决的。
 */
const USER_FAULT_CODES = new Set([1018, 1022, 1026, 1249]);

/**
 * 低层：POST x-www-form-urlencoded，返回原始 { status, json }，**不判 code**
 * ------------------------------------------------------------------
 * 为什么要把「不判 code」这一层单独拆出来：轮询发布结果时，`code === 1247`
 * 表示**还在解析**、不是失败，调用方得自己决定重试。如果底层一见非 0 就抛错，
 * 轮询第一次就会被自己的错误中断。
 *
 * ⚠️ 参数放 body 还是 query 是接口定的：`buildInfo` 官方 Node 示例把参数放在
 * **查询串**（文档写的是 GET，实测/示例是 POST + query），所以这里两种都支持。
 */
async function httpForm(path, { form = {}, query = {}, timeout = TIMEOUT_MS } = {}) {
  const url = new URL(config.pgyer.apiBase + path);
  Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, String(v)));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'aige-saas-workbench',
      },
      body: new URLSearchParams(form),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw upstream(`连蒲公英超时（${Math.round(timeout / 1000)} 秒），请稍后重试`, {
        url: url.toString(),
      });
    }
    throw upstream(`连不上蒲公英：${err.message}`, { url: url.toString() });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw upstream(`蒲公英返回了非 JSON 内容（HTTP ${res.status}）`, {
      url: url.toString(),
      response: text.slice(0, 300),
    });
  }
  return { status: res.status, json };
}

/** 把蒲公英的业务错误转成「用户该做什么」 */
function toApiError(json) {
  const code = json?.code;
  const msg = CODE_HINT[code] || json?.message || `蒲公英返回未知错误（code: ${code}）`;
  const keyInvalid = code === 1002 || code === 1055;
  const userFault = USER_FAULT_CODES.has(code);

  return new AppError(
    `蒲公英接口报错：${msg}`,
    // 密钥不对 / 用户传错文件 → 都不算「上游挂了」，别报 502
    keyInvalid || userFault ? 400 : 502,
    keyInvalid ? 'PGYER_KEY_INVALID' : userFault ? 'PGYER_INVALID_INPUT' : 'PGYER_API_ERROR',
    { code, upstreamMessage: json?.message }
  );
}

async function apiPost(path, params = {}) {
  assertConfigured();
  const { json } = await httpForm(path, { form: { _api_key: apiKey(), ...params } });
  // ⚠️ 只有 code === 0 才算成功。HTTP 常常还是 200，失败藏在业务码里
  if (!json || json.code !== 0) throw toApiError(json);
  return json.data;
}

async function cachedPost(key, path, params) {
  const hit = readCache(key);
  if (hit !== undefined) return hit;
  return writeCache(key, await apiPost(path, params));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// 数据组装
// ============================================================

/** 图标直接由蒲公英 CDN 提供，规则见官方文档（前 5 个字符用 / 连接当路径） */
function iconUrl(buildIcon) {
  if (!buildIcon) return '';
  const s = String(buildIcon);
  const dir = s.slice(0, 5).split('').join('/');
  return `https://cdn-app-icon2.pgyer.com/${dir}/${s}?x-oss-process=image/resize,m_lfit,h_120,w_120/format,jpg`;
}

/** 蒲公英几乎所有数值字段都是**字符串**（文档写 Integer，实测是 String），统一转一下 */
function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function slimBuild(b) {
  const typeNo = toNum(b.buildType);
  return {
    buildKey: b.buildKey,
    appKey: b.appKey,
    name: b.buildName || '',
    version: b.buildVersion || '',
    versionNo: b.buildVersionNo || '',
    // ⚠️ 这个字段实测也是字符串（"1"）。不转数字的话排序比较会退化成 NaN，
    //    「哪个是最新版本」就会算错。
    buildNumber: toNum(b.buildBuildVersion),
    type: typeNo === 1 ? 'iOS' : typeNo === 2 ? 'Android' : '未知',
    fileSize: toNum(b.buildFileSize),
    identifier: b.buildIdentifier || '',
    createdAt: b.buildCreated || '',
    icon: b.iconUrl || iconUrl(b.buildIcon),
    // 短链 listMy 就会带；二维码只有 view / buildInfo 才有
    shortcutUrl: b.buildShortcutUrl || '',
    qrCodeUrl: b.buildQRCodeURL || '',
    downloadPage: b.buildShortcutUrl ? `https://www.pgyer.com/${b.buildShortcutUrl}` : '',
    updateDescription: b.buildUpdateDescription || '',
    // 只有 view 返回。「今日下载」是内测分发最该看的数字之一
    todayDownloads: b.todayDownloadCount === undefined ? null : toNum(b.todayDownloadCount),
  };
}

/**
 * 拉齐所有页。
 *
 * ⛔⛔ 这里踩过一个极其隐蔽的坑，务必别再踩：
 *   官方文档的响应示例把 data 写成**数组** —— `{ code: 0, data: [ {...} ] }`；
 *   但**实测**是 `{ code: 0, data: { list: [...], total: "2", page: 1 } }`，
 *   data 是**对象**、里面才套 `list`。
 *
 *   第一版就是照文档写的 `Array.isArray(data) ? data : []`，结果永远解析成空列表 ——
 *   表现是「我明明传过包，页面上一个都没有」，**而且不报错、code 还是 0**，
 *   属于最难发现的那类 bug。教训：**文档只用来定接口名与参数，返回结构必须以实测为准。**
 *
 *   所以两种形状都兼容（文档万一改回来也能活），并优先用 total 控制翻页。
 */
async function listMyAll() {
  const all = [];
  let total = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const data = await cachedPost(`listMy:${page}`, '/apiv2/app/listMy', { page });

    const isArray = Array.isArray(data);
    const list = isArray ? data : Array.isArray(data?.list) ? data.list : [];
    if (!isArray && data && data.total !== undefined) total = toNum(data.total);

    all.push(...list);
    if (!list.length) break;
    if (total !== null && all.length >= total) break;
  }
  return all;
}

/** 从 view 补当前版本的二维码与今日下载（listMy 不带二维码） */
async function enrichFromView(item) {
  try {
    const d = await cachedPost(`view:${item.appKey}:${item.buildKey}`, '/apiv2/app/view', {
      appKey: item.appKey,
      buildKey: item.buildKey,
    });
    return slimBuild({ ...d, appKey: item.appKey });
  } catch {
    // 单个应用取不到二维码不该让整页失败：短链 listMy 就有，下载页照样能显示
    return item;
  }
}

// ============================================================
// 上传（把安装包送到蒲公英，**不落我们服务器**）
// ============================================================

/** 扩展名 → 蒲公英的 buildType（取值以官方 Node 示例为准） */
function buildTypeOf(fileName) {
  const ext = String(fileName || '')
    .toLowerCase()
    .split('.')
    .pop();
  if (ext === 'apk') return 'android';
  if (ext === 'ipa') return 'ios';
  if (ext === 'hap') return 'harmony';
  throw new AppError('只支持 .apk / .ipa / .hap 三种安装包', 400, 'INVALID_FILE_TYPE');
}

/** 查一次发布结果（官方示例是 POST + 参数放查询串 + 空请求体） */
async function buildInfoOnce(buildKey) {
  return httpForm('/apiv2/app/buildInfo', { query: { _api_key: apiKey(), buildKey } });
}

/**
 * 上传安装包到蒲公英（只读模块里唯一的写操作，仅此一处）
 * ------------------------------------------------------------------
 * 三步，严格照官方 Node 示例（`PGYER/upload-app-api-example`）来，不凭文档猜：
 *   ① getCOSToken 取上传凭证
 *   ② multipart 传到腾讯云 COS（**成功是 HTTP 204**）
 *   ③ 轮询 buildInfo 等发布结果（**code 1247 = 正在解析，要继续等**）
 *
 * 两条关键实现约束：
 *   · **`file` 字段必须放在最后**（COS 的 POST Object 规范），其余字段顺序照官方示例
 *   · `buildUpdateDescription` 是传给 **getCOSToken** 的，不是传给 COS
 *
 * 用 Node 内置的 FormData + Blob，**没有引入任何新依赖**（官方示例要 npm 包 form-data）。
 * 文件在内存里过一遍（上限 100MB）后就送走，**不落盘、不留在我们服务器上**。
 *
 * @param {Buffer} buffer      安装包字节
 * @param {string} fileName    原始文件名（决定 buildType 与展示名）
 * @returns {Promise<object>}  成功时返回裁好的版本信息；蒲公英还在解析时返回 { buildKey, pending: true }
 */
async function uploadApp(buffer, fileName, { updateDescription = '' } = {}) {
  assertConfigured();

  const name = String(fileName || '').trim() || 'app.apk';
  const buildType = buildTypeOf(name);
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new AppError('没有收到文件内容', 400, 'INVALID_PARAM');
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new AppError(
      `安装包 ${(buffer.length / 1024 / 1024).toFixed(1)}MB 超过上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`,
      413,
      'FILE_TOO_LARGE'
    );
  }

  // ① 取上传凭证
  const token = await apiPost('/apiv2/app/getCOSToken', {
    buildType,
    ...(updateDescription ? { buildUpdateDescription: updateDescription } : {}),
  });
  const params = token?.params || {};
  if (!token?.endpoint || !params.key) {
    throw upstream('蒲公英没有返回上传凭证（endpoint / key 为空）');
  }

  // ② 传到对象存储。字段顺序照官方示例，file 放最后
  const fd = new FormData();
  fd.append('signature', params.signature);
  fd.append('x-cos-security-token', params['x-cos-security-token']);
  fd.append('key', params.key);
  fd.append('x-cos-meta-file-name', name);
  fd.append('file', new Blob([buffer], { type: 'application/octet-stream' }), name);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(token.endpoint, { method: 'POST', body: fd, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw upstream(`上传超时（${UPLOAD_TIMEOUT_MS / 1000} 秒），文件可能过大或网络不稳`);
    }
    throw upstream(`上传失败：${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  // ⚠️ 官方示例：**只有 204 算上传成功**（不是 200）
  if (res.status !== 204) {
    const text = await res.text().catch(() => '');
    throw upstream(`上传到蒲公英存储失败（HTTP ${res.status}）`, {
      response: String(text).slice(0, 300),
    });
  }

  // ③ 等发布结果
  for (let i = 0; i < POLL_MAX; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(POLL_INTERVAL_MS);
    // eslint-disable-next-line no-await-in-loop
    const { json } = await buildInfoOnce(params.key);
    const code = json?.code;

    if (code === CODE_PARSING) continue; // 还在解析，继续等
    if (code !== 0) throw toApiError(json); // 真失败（如文件不是有效 APK）
    if (json?.data?.buildKey) {
      clearCache(); // 列表要能立刻看到新版本
      return slimBuild(json.data);
    }
    // code 0 但 data 还没齐：继续等
  }

  // 上传成功、但解析超时：把 buildKey 交出去，让界面提示「稍后刷新」
  clearCache();
  return { buildKey: params.key, pending: true, fileName: name };
}

// ============================================================
// 对外能力
// ============================================================

/** 应用清单：按 appKey 归组，每组给「当前版本」+ 历史版本数 */
async function listApps() {
  const raw = await listMyAll();
  const builds = raw.map(slimBuild);

  const groups = new Map();
  builds.forEach((b) => {
    const key = b.appKey || b.buildKey;
    if (!groups.has(key)) {
      groups.set(key, {
        appKey: b.appKey,
        name: b.name,
        icon: b.icon,
        type: b.type,
        identifier: b.identifier,
        builds: [],
      });
    }
    const g = groups.get(key);
    g.builds.push(b);
  });

  const items = [];
  for (const g of groups.values()) {
    // buildBuildVersion 是蒲公英生成的版本序号，**最大的是最新**（注意它是字符串）
    g.builds.sort((a, b) => b.buildNumber - a.buildNumber);
    // 只给当前版本补二维码 / 今日下载（view 只调这一次，不是每个历史版本都调）
    // eslint-disable-next-line no-await-in-loop
    const latest = await enrichFromView(g.builds[0]);
    items.push({
      appKey: g.appKey,
      name: latest.name || g.name,
      icon: latest.icon || g.icon,
      type: latest.type || g.type,
      identifier: latest.identifier || g.identifier,
      versionCount: g.builds.length,
      latest,
    });
  }

  items.sort((a, b) => String(b.latest.createdAt).localeCompare(String(a.latest.createdAt)));
  return { items, totalApps: items.length, totalBuilds: builds.length };
}

/** 单个应用详情（含历史版本，最新的在前） */
async function appDetail(appKey) {
  const key = String(appKey || '').trim();
  if (!key) throw new AppError('需要提供 appKey', 400, 'INVALID_PARAM');

  const all = await listMyAll();
  const mine = all.map(slimBuild).filter((b) => b.appKey === key);
  if (!mine.length) {
    throw new AppError('在蒲公英账号下找不到这个应用', 404, 'NOT_FOUND');
  }
  mine.sort((a, b) => b.buildNumber - a.buildNumber);

  const latest = await apiPost('/apiv2/app/view', { appKey: key, buildKey: mine[0].buildKey });
  return {
    appKey: key,
    latest: slimBuild({ ...latest, appKey: key }),
    history: mine,
  };
}

module.exports = {
  CACHE_TTL,
  MAX_UPLOAD_BYTES,
  isConfigured,
  assertConfigured,
  clearCache,
  listApps,
  appDetail,
  uploadApp,
  iconUrl,
};
