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
};

async function apiPost(path, params = {}) {
  assertConfigured();

  const body = new URLSearchParams({ _api_key: apiKey(), ...params });
  const url = config.pgyer.apiBase + path;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'aige-saas-workbench',
      },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw upstream(`连蒲公英超时（${TIMEOUT_MS / 1000} 秒），请稍后重试`, { url });
    }
    throw upstream(`连不上蒲公英：${err.message}`, { url });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw upstream(`蒲公英返回了非 JSON 内容（HTTP ${res.status}）`, {
      url,
      response: text.slice(0, 300),
    });
  }

  // ⚠️ 只有 code === 0 才算成功。HTTP 200 也可能是业务失败（官方就是这样设计的）
  if (!json || json.code !== 0) {
    const code = json?.code;
    const hint = CODE_HINT[code];
    const msg = hint || json?.message || `蒲公英返回未知错误（code: ${code}）`;
    throw new AppError(
      `蒲公英接口报错：${msg}`,
      502,
      code === 1002 || code === 1055 ? 'PGYER_KEY_INVALID' : 'PGYER_API_ERROR',
      { code, upstreamMessage: json?.message }
    );
  }

  return json.data;
}

async function cachedPost(key, path, params) {
  const hit = readCache(key);
  if (hit !== undefined) return hit;
  return writeCache(key, await apiPost(path, params));
}

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

function slimBuild(b) {
  return {
    buildKey: b.buildKey,
    appKey: b.appKey,
    name: b.buildName || '',
    version: b.buildVersion || '',
    versionNo: b.buildVersionNo || '',
    buildNumber: b.buildBuildVersion,
    type: b.buildType === 1 ? 'iOS' : b.buildType === 2 ? 'Android' : '未知',
    fileSize: b.buildFileSize || 0,
    identifier: b.buildIdentifier || '',
    createdAt: b.buildCreated || '',
    icon: iconUrl(b.buildIcon),
    // 这两个字段只有 view / buildInfo 才有，listMy 不返回 —— 见 withQr()
    shortcutUrl: b.buildShortcutUrl || '',
    qrCodeUrl: b.buildQRCodeURL || '',
    downloadPage: b.buildShortcutUrl ? `https://www.pgyer.com/${b.buildShortcutUrl}` : '',
    updateDescription: b.buildUpdateDescription || '',
  };
}

/** 拉齐所有页（正常个人账号一页就够，这里只是不要静默丢数据） */
async function listMyAll() {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await cachedPost(`listMy:${page}`, '/apiv2/app/listMy', { page });
    const list = Array.isArray(rows) ? rows : [];
    all.push(...list);
    if (list.length === 0) break;
  }
  return all;
}

/**
 * 补上短链与二维码。
 * listMy 不返回这两个字段，只能逐个 appKey 调 view —— 所以只对**每个应用的当前版本**补，
 * 不是每个历史版本都补（否则 N 个应用 × M 个版本 = N×M 次请求）。
 */
async function withQr(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (item.shortcutUrl || seen.has(item.appKey)) {
      out.push(item);
      continue;
    }
    seen.add(item.appKey);
    try {
      // eslint-disable-next-line no-await-in-loop
      const d = await cachedPost(`view:${item.appKey}:${item.buildKey}`, '/apiv2/app/view', {
        appKey: item.appKey,
        buildKey: item.buildKey,
      });
      out.push({ ...item, ...slimBuild({ ...d, appKey: item.appKey }) });
    } catch {
      // 单个应用取不到二维码不该让整页失败
      out.push(item);
    }
  }
  return out;
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
    // buildBuildVersion 是蒲公英生成的版本序号，最大的是最新
    g.builds.sort((a, b) => (a.buildNumber || 0) - (b.buildNumber || 0));
    const latest = g.builds[g.builds.length - 1];
    // 只给当前版本补二维码
    // eslint-disable-next-line no-await-in-loop
    const [withQrLatest] = await withQr([latest]);
    items.push({
      appKey: g.appKey,
      name: withQrLatest.name || g.name,
      icon: withQrLatest.icon || g.icon,
      type: withQrLatest.type || g.type,
      identifier: withQrLatest.identifier || g.identifier,
      versionCount: g.builds.length,
      latest: withQrLatest,
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
  mine.sort((a, b) => (b.buildNumber || 0) - (a.buildNumber || 0));

  const latest = await apiPost('/apiv2/app/view', { appKey: key, buildKey: mine[0].buildKey });
  return {
    appKey: key,
    latest: slimBuild({ ...latest, appKey: key }),
    history: mine,
  };
}

module.exports = {
  CACHE_TTL,
  isConfigured,
  assertConfigured,
  clearCache,
  listApps,
  appDetail,
  iconUrl,
};
