/**
 * GitHub 只读客户端（B4 代码仓库页）
 * ------------------------------------------------------------------
 * 只做「读」：仓库信息 / 提交 / Actions 运行 / Issue / PR。
 * 刻意不引 octokit —— 我们要的只有 5 个 GET 接口，多一个依赖不如少一个。
 *
 * ⛔ 三条必须守住的规则（改这个文件前先读）：
 *
 *   1. **配额是这个功能最大的敌人**。匿名访问只有 60 次/小时，而且是**按服务器出口 IP**
 *      算的 —— 也就是全服务器共用。所以这里做了两层保护：
 *        · 60 秒内存缓存（同一份数据不重复打接口）
 *        · 把响应的 x-ratelimit-* 头记下来，配额见底时给**说人话的提示**，
 *          而不是让前端看到一片空白或一个 403
 *      加接口时务必走 cachedGet()，不要直接 apiGet()。
 *
 *   2. **不要用 utils/http.js 的 request()**。它在 !res.ok 时直接抛错，
 *      拿不到响应头 —— 而配额信息恰恰只在响应头里（包括 403 的响应）。
 *      这里自己包一层 fetch，就是为了把 header 留下。
 *
 *   3. **失败要说清是哪一种失败**。令牌无效 / 仓库不存在 / 配额用完 / 网络不通，
 *      这四种用户要做的事完全不同，不能都报「请求失败」。
 */
'use strict';

const config = require('../config');
const settings = require('./settings');
const { AppError, badRequest, notFound, upstream } = require('../utils/errors');

/** 缓存有效期：保护 GitHub 配额，别为了「实时」把额度烧光 */
const CACHE_TTL = 60 * 1000;
/** 单请求超时 */
const TIMEOUT_MS = 12000;
/** 每类数据默认取多少条 */
const DEFAULT_LIMIT = 20;

/** key → { at, value } */
const cache = new Map();
/** 最近一次响应里的配额信息，供界面展示「还剩多少」 */
let lastRateLimit = null;

// ============================================================
// 配置读取
// ============================================================

/** 当前令牌（每次现读数据库，界面上改完立即生效，不用重启） */
function token() {
  return String(settings.get('github_token') || '').trim();
}

/** 有没有配令牌 —— 没配也能用（匿名），只是配额低 */
function isConfigured() {
  return !!token();
}

/** 把各种写法统一成 owner/repo */
function normalize(input) {
  const full = String(input || '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  const m = full.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m) {
    throw badRequest(
      `「${input}」不是合法的仓库名，格式应为 owner/repo（如 eyc1125/aige-saas-workbench）`
    );
  }
  return { owner: m[1], repo: m[2], full: `${m[1]}/${m[2]}` };
}

/** 界面上配置的「关注的仓库」列表（已去重、已规范） */
function configuredRepos() {
  const raw = String(settings.get('github_repos') || '');
  const seen = new Set();
  const out = [];
  raw.split(/[,，\n]/).forEach((piece) => {
    const item = piece.trim();
    if (!item) return;
    try {
      const { full } = normalize(item);
      if (!seen.has(full)) {
        seen.add(full);
        out.push(full);
      }
    } catch {
      // 配置里写错一行不该让整页打不开，忽略它，由界面提示「格式不对」
    }
  });
  return out;
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

/** 设置改完后清一次，免得看到的还是旧仓库的数据 */
function clearCache() {
  cache.clear();
}

/** 缓存的年龄（秒），给界面标「数据是多久以前的」 */
function cacheAge(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  return Math.round((Date.now() - hit.at) / 1000);
}

// ============================================================
// 请求
// ============================================================

/** 记下配额 —— 这里可能就是「配额用完」的唯一证据 */
function noteRateLimit(headers) {
  const remaining = headers.get('x-ratelimit-remaining');
  if (remaining === null) return;
  const limit = Number(headers.get('x-ratelimit-limit')) || 0;
  const reset = Number(headers.get('x-ratelimit-reset')) || 0;
  const resetInSeconds = reset ? Math.max(0, Math.round(reset - Date.now() / 1000)) : null;
  lastRateLimit = {
    limit,
    remaining: Number(remaining),
    resetAt: reset ? new Date(reset * 1000).toISOString() : null,
    resetInSeconds,
    authenticated: !!token(),
  };
}

/** 只有 GET —— 这个模块是只读的 */
async function apiGet(path, query = {}) {
  const url = new URL(config.github.apiBase + path);
  Object.entries(query).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  });

  const tk = token();
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'aige-saas-workbench',
  };
  if (tk) headers.Authorization = `Bearer ${tk}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { headers, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw upstream(
        `连 GitHub 超时（${TIMEOUT_MS / 1000} 秒）。国内服务器直连 api.github.com 偶尔会不稳。`,
        {
          url: url.toString(),
        }
      );
    }
    throw upstream(`连不上 GitHub：${err.message}`, { url: url.toString() });
  } finally {
    clearTimeout(timer);
  }

  noteRateLimit(res.headers);

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (res.ok) return data;

  const ghMessage = (data && data.message) || '';

  // ---- 失败分流：这四种，用户要做的事完全不同 ----
  if (res.status === 401) {
    throw new AppError(
      'GitHub 令牌无效或已过期，请到「系统设置 → 代码仓库」重新填写',
      401,
      'GITHUB_TOKEN_INVALID'
    );
  }
  if (res.status === 404) {
    throw notFound(
      `GitHub 上找不到 ${path}。可能是仓库名写错、仓库是私有的，或者令牌没有这个仓库的权限。`
    );
  }
  if ((res.status === 403 || res.status === 429) && lastRateLimit?.remaining === 0) {
    const minutes = lastRateLimit.resetInSeconds
      ? Math.ceil(lastRateLimit.resetInSeconds / 60)
      : null;
    const tip = tk ? '' : ' 配置令牌后可提升到 5000 次/小时。';
    throw new AppError(
      `GitHub 接口配额已用完（${lastRateLimit.limit} 次/小时）${minutes ? `，约 ${minutes} 分钟后恢复` : ''}。${tip}`,
      429,
      'GITHUB_RATE_LIMITED',
      { rateLimit: lastRateLimit }
    );
  }
  throw upstream(`GitHub 返回错误（HTTP ${res.status}）${ghMessage ? `：${ghMessage}` : ''}`, {
    url: url.toString(),
    status: res.status,
  });
}

/** 带缓存的 GET —— 新加接口一律走它 */
async function cachedGet(key, path, query) {
  const hit = readCache(key);
  if (hit !== undefined) return hit;
  const value = await apiGet(path, query);
  return writeCache(key, value);
}

// ============================================================
// 数据裁剪（只把界面/AI 要用的字段传出去，别原样透传 GitHub 的巨型对象）
// ============================================================

function slimRepo(r) {
  return {
    fullName: r.full_name,
    name: r.name,
    owner: r.owner?.login || '',
    description: r.description || '',
    private: !!r.private,
    defaultBranch: r.default_branch || 'main',
    stars: r.stargazers_count || 0,
    forks: r.forks_count || 0,
    openIssues: r.open_issues_count || 0,
    language: r.language || '',
    pushedAt: r.pushed_at || null,
    htmlUrl: r.html_url,
  };
}

function slimCommit(c) {
  return {
    sha: c.sha,
    shortSha: String(c.sha || '').slice(0, 7),
    // 提交信息只取首行 —— 正文可能有几十行，列表里显示不下
    message: String(c.commit?.message || '').split('\n')[0],
    author: c.commit?.author?.name || c.author?.login || '未知',
    avatar: c.author?.avatar_url || '',
    date: c.commit?.author?.date || null,
    htmlUrl: c.html_url,
  };
}

function slimRun(r) {
  return {
    id: r.id,
    name: r.name,
    title: r.display_title || '',
    status: r.status || '', // queued / in_progress / completed
    conclusion: r.conclusion || '', // success / failure / cancelled / ''
    branch: r.head_branch || '',
    event: r.event || '',
    runNumber: r.run_number,
    attempt: r.run_attempt,
    createdAt: r.created_at || null,
    updatedAt: r.updated_at || null,
    htmlUrl: r.html_url,
    // 跑一次多久 —— 比 updated_at 更直观
    durationSeconds:
      r.run_started_at && r.updated_at
        ? Math.max(0, Math.round((new Date(r.updated_at) - new Date(r.run_started_at)) / 1000))
        : null,
  };
}

function slimIssue(i) {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    kind: 'issue',
    user: i.user?.login || '',
    avatar: i.user?.avatar_url || '',
    labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
    comments: i.comments || 0,
    createdAt: i.created_at || null,
    updatedAt: i.updated_at || null,
    htmlUrl: i.html_url,
  };
}

function slimPull(p) {
  return {
    number: p.number,
    title: p.title,
    state: p.state,
    kind: 'pull',
    user: p.user?.login || '',
    avatar: p.user?.avatar_url || '',
    labels: (p.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
    draft: p.draft === true,
    from: p.head?.ref || '',
    to: p.base?.ref || '',
    createdAt: p.created_at || null,
    updatedAt: p.updated_at || null,
    htmlUrl: p.html_url,
  };
}

// ============================================================
// 对外能力
// ============================================================

/** 单个仓库的基本信息 */
async function repoInfo(full) {
  const { full: f } = normalize(full);
  const data = await cachedGet(`info:${f}`, `/repos/${f}`);
  return slimRepo(data);
}

/** 最近提交 */
async function listCommits(full, { perPage = DEFAULT_LIMIT } = {}) {
  const { full: f } = normalize(full);
  const data = await cachedGet(`commits:${f}:${perPage}`, `/repos/${f}/commits`, {
    per_page: perPage,
  });
  return (Array.isArray(data) ? data : []).map(slimCommit);
}

/** Actions 运行记录（新的在前） */
async function listRuns(full, { perPage = DEFAULT_LIMIT } = {}) {
  const { full: f } = normalize(full);
  const data = await cachedGet(`runs:${f}:${perPage}`, `/repos/${f}/actions/runs`, {
    per_page: perPage,
  });
  const runs = (data && data.workflow_runs) || [];
  return runs.map(slimRun);
}

/** 开放中的 Issue（**不含** PR —— GitHub 的 issues 接口会把 PR 混进来） */
async function listIssues(full, { state = 'open', perPage = DEFAULT_LIMIT } = {}) {
  const { full: f } = normalize(full);
  const data = await cachedGet(`issues:${f}:${state}:${perPage}`, `/repos/${f}/issues`, {
    state,
    per_page: perPage,
    sort: 'updated',
    direction: 'desc',
  });
  return (Array.isArray(data) ? data : []).filter((i) => !i.pull_request).map(slimIssue);
}

/** 开放中的 PR */
async function listPulls(full, { state = 'open', perPage = DEFAULT_LIMIT } = {}) {
  const { full: f } = normalize(full);
  const data = await cachedGet(`pulls:${f}:${state}:${perPage}`, `/repos/${f}/pulls`, {
    state,
    per_page: perPage,
    sort: 'updated',
    direction: 'desc',
  });
  return (Array.isArray(data) ? data : []).map(slimPull);
}

/** 仓库页一次性要的全部数据（前端一次请求，少几个来回） */
async function repoDetail(full) {
  const { full: f } = normalize(full);
  const [repo, commits, runs, issues, pulls] = await Promise.all([
    repoInfo(f),
    listCommits(f),
    listRuns(f),
    listIssues(f),
    listPulls(f),
  ]);
  return {
    repo,
    commits,
    runs,
    issues,
    pulls,
    rateLimit: lastRateLimit,
    cacheTtlSeconds: CACHE_TTL / 1000,
  };
}

/** 配置里所有仓库的概览（某个仓库挂了不影响其它仓库展示） */
async function listRepos() {
  const names = configuredRepos();
  const items = [];
  // 刻意串行：并发会把 GitHub 的配额在几百毫秒内打满（匿名只有 60 次/小时），
  // 而多等几百毫秒对使用者来说毫无感知
  /* eslint-disable no-await-in-loop */
  for (const full of names) {
    try {
      items.push(await repoInfo(full));
    } catch (err) {
      // ⛔ 「令牌无效」和「配额用完」是**全局**问题，不是这个仓库自己的问题。
      //    这里必须让整次请求失败 —— 否则前端会拿到一个 200 + 一条条带 error 的列表，
      //    看起来像"页面上有几个仓库读不到"，实际是"谁都读不到，去改令牌"。
      if (err.code === 'GITHUB_TOKEN_INVALID' || err.code === 'GITHUB_RATE_LIMITED') throw err;
      // 其余（仓库被删/改名、私有、单次网络抖动）只标记它自己，别让整页失败
      items.push({ fullName: full, error: err.message });
    }
  }
  /* eslint-enable no-await-in-loop */
  return { items, rateLimit: lastRateLimit, authenticated: isConfigured() };
}

/** CI 状态摘要：给 AI 用的「现在绿不绿」 */
async function ciStatus(full, { perPage = 10 } = {}) {
  const { full: f } = normalize(full);
  const [repo, runs] = await Promise.all([repoInfo(f), listRuns(f, { perPage })]);
  return {
    repo: f,
    defaultBranch: repo.defaultBranch,
    latest: runs[0] || null,
    recent: runs,
    rateLimit: lastRateLimit,
  };
}

module.exports = {
  CACHE_TTL,
  isConfigured,
  configuredRepos,
  normalize,
  cacheAge,
  clearCache,
  rateLimit: () => lastRateLimit,
  repoInfo,
  repoDetail,
  listRepos,
  listCommits,
  listRuns,
  listIssues,
  listPulls,
  ciStatus,
};
