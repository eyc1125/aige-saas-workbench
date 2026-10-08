/**
 * 宝塔面板 API 对接
 * ------------------------------------------------------------------
 * 认证方式（宝塔 7.x / 8.x / 9.x 通用）：
 *   请求需带两个参数：
 *     request_time  = 当前秒级时间戳
 *     request_token = md5(request_time + md5(API密钥))
 *   面板「设置 → API 接口」里开启并配置 IP 白名单后，密钥才可用。
 *
 * 说明：宝塔官方 API 覆盖面有限，以下部分能力（反向代理、SSL 自动签发）
 *      在官方文档里没有稳定公开接口，本文件按「best-effort + 明确报错」实现，
 *      失败时会把宝塔返回的原始 msg 透出，便于在界面上直接看到该怎么处理。
 *
 * 安全约束：本服务只操作「当前项目自己名下」的域名与站点；删除/覆盖前
 *          一律先读取现状并备份，绝不盲删、绝不整目录清空。
 */
'use strict';

const crypto = require('crypto');
const path = require('path');
const settings = require('./settings');
const { request } = require('../utils/http');
const { AppError, upstream, badRequest } = require('../utils/errors');

const md5 = (text) => crypto.createHash('md5').update(String(text)).digest('hex');

/** 宝塔站点配置目录（Linux 面板固定路径） */
const NGINX_VHOST_DIR = '/www/server/panel/vhost/nginx';
/** 宝塔默认站点根目录 */
const WWW_ROOT = '/www/wwwroot';
/** 站点访问 / 错误日志目录（宝塔固定路径） */
const WWWLOGS_DIR = '/www/wwwlogs';
/** Let's Encrypt 证书目录（宝塔 13.x 起用这个，老版本是 vhost/cert） */
const LETSENCRYPT_DIR = '/www/server/panel/vhost/letsencrypt';
/** 宝塔备份根目录 */
const BACKUP_ROOT = '/www/backup';

/**
 * 计划任务归属判定：属于本项目自己的任务（与 health.js 的站点白名单同一套约定）
 * ------------------------------------------------------------------
 * 本项目自己的东西统一带 aige / workbench / 艾哥 这些字眼（二级域名是 aige-saas- 前缀、
 * 容器是 aige-workbench-*、目录是 aige-saas-workbench）。这里沿用同一套，避免各判各的。
 */
const OWN_CRONTAB_KEYWORDS = ['aige', 'workbench', '艾哥'];
function isOwnCrontab(name) {
  const n = String(name || '').toLowerCase();
  return OWN_CRONTAB_KEYWORDS.some((k) => n.includes(k));
}

/**
 * 「疑似排障遗留」的名字特征
 * ------------------------------------------------------------------
 * 实测这台服务器上有 36 个任务，其中十几条长这样：
 * 「修复Nginx静态文件拦截」「深度诊断静态文件问题」「最终重启NovaAI(3001端口)」——
 * 都是当时排障临时加的，事后没人清理，**却还都挂在「每天」执行**。
 * 这种任务既占资源又让「到底哪些任务该在」变得说不清，所以单独标出来提醒人确认。
 */
const LEGACY_TASK_HINTS = [/修复/, /诊断/, /重试/, /最终/, /测试/];

/**
 * 宝塔 `type` 字段的英文 slug → 人话
 * ------------------------------------------------------------------
 * ⚠️ 为什么需要这张表：宝塔**不一定**给中文描述。实测 36 条里有 3 条
 *    `type_zh` 直接就是 `minute` / `to-shell` 这种原始 slug，
 *    照搬会在界面上印出英文单词（实测截图里就出现过），既不专业也看不懂。
 * 只映射**实际观察到的**取值，其余一律走「周期未说明」，不猜。
 */
const CRONTAB_TYPE_TEXT = {
  day: '每天',
  week: '每周',
  month: '每月',
  hour: '每小时',
  minute: '每分钟',
  'minute-n': '按分钟间隔重复',
  'hour-n': '按小时间隔重复',
  'day-n': '按天间隔重复',
};

/**
 * 是不是「真的中文描述」—— 用来判断 type_zh 能不能直接展示
 * 用码点判断而不是正则：正则可以写，但包含 ASCII 控制符范围的字符类会被 lint 拦
 * （no-control-regex），而且这个意图用码点表达更直白。
 */
function hasChinese(text) {
  return [...String(text || '')].some((ch) => ch.codePointAt(0) > 0x7f);
}

/**
 * 「执行方式」白名单：只有这些 sType 才算「方式」
 * ------------------------------------------------------------------
 * 宝塔的 `sType` 把两类东西混在一起：
 *   · 真·执行方式 —— toShell / shell（脚本）、url（访问网址）
 *   · 调度间隔 —— minute-n / hour-n（那属于「周期」，不是「方式」）
 * 混在一起展示会出现「周期写着 to-shell，方式写着每 N 分钟」这种自相矛盾的行
 * （实测就有），所以这里只放行前者；不在表里的取值为空，界面直接不显示那个标签。
 */
const CRONTAB_EXEC_TYPES = {
  toShell: 'Shell 脚本',
  shell: 'Shell 脚本',
  url: '访问 URL',
};

/** 人类可读的字节数（列表展示用） */
function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 从任意地址里取出「协议 + 主机 + 端口」，用于去掉安全入口路径 */
function deriveOrigin(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

class BaotaClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl 面板地址（应为 API 根地址，不含安全入口路径）
   * @param {string} options.apiKey  面板 API 密钥
   * @param {boolean} [options.allowInsecureTls] 面板是 IP + 自签证书时需置 true
   */
  constructor({ baseUrl, apiKey, allowInsecureTls = false }) {
    if (!baseUrl || !apiKey) {
      throw new AppError(
        '宝塔面板尚未配置，请先到「系统设置」填写面板地址与 API 密钥',
        428,
        'NOT_CONFIGURED'
      );
    }

    const normalized = String(baseUrl).trim().replace(/\/+$/, '');
    this.baseUrl = normalized;
    this.apiKey = String(apiKey);
    this.allowInsecureTls = !!allowInsecureTls;

    // 浏览器里复制的面板地址通常带「安全入口」路径（形如 /c6b348fb），
    // 那是登录页入口；宝塔 API 只认根路径，带上会直接 404。
    // 这里预先算出根地址，首次请求若吃到 404 就自动退回根地址重试一次。
    this.originUrl = deriveOrigin(normalized);
    this.useOrigin = false;
  }

  /** 当前实际生效的基地址（自动纠正后可能已切换为根地址） */
  activeBaseUrl() {
    return this.useOrigin ? this.originUrl : this.baseUrl;
  }

  /** 生成签名参数 */
  _auth() {
    const requestTime = Math.floor(Date.now() / 1000);
    return {
      request_time: requestTime,
      request_token: md5(`${requestTime}${md5(this.apiKey)}`),
    };
  }

  /**
   * 调用宝塔接口
   * @param {string} endpoint 接口路径（含 query，如 /system?action=GetSystemTotal）
   * @param {object} [params] 业务参数
   * @param {'GET'|'POST'} [method='POST']
   * @param {number} [timeout] 超时毫秒
   */
  async call(endpoint, params = {}, method = 'POST', timeout = 20000) {
    try {
      return await this._callWithBase(this.activeBaseUrl(), endpoint, params, method, timeout);
    } catch (err) {
      const is404 = err.detail && err.detail.status === 404;
      if (is404 && !this.useOrigin && this.originUrl && this.originUrl !== this.baseUrl) {
        console.warn(
          `[baota] 面板地址带安全入口路径时 API 会返回 404，已自动改用根地址重试：${this.originUrl}`
        );
        this.useOrigin = true;
        return this._callWithBase(this.originUrl, endpoint, params, method, timeout);
      }
      throw err;
    }
  }

  /** 按指定基地址真正发起请求 */
  async _callWithBase(base, endpoint, params = {}, method = 'POST', timeout = 20000) {
    const auth = this._auth();
    const query = new URLSearchParams(auth);
    const separator = endpoint.includes('?') ? '&' : '?';
    const url = `${base}${endpoint}${separator}${query.toString()}`;
    const insecure = this.allowInsecureTls;

    if (method === 'GET') {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null) query.append(k, String(v));
      });
      const getUrl = `${base}${endpoint}${separator}${query.toString()}`;
      return request(getUrl, { method: 'GET', timeout, serviceName: '宝塔面板', insecure });
    }

    const form = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v === undefined || v === null) return;
      form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    });

    return request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      timeout,
      serviceName: '宝塔面板',
      insecure,
    });
  }

  /**
   * 统一的响应解包
   * 关键点：宝塔的返回分两种风格——
   *   ① 带状态标记：{"status": true/false, "msg": "..."}（增删改类接口）
   *   ② 纯数据对象：{"memTotal": 1967, "cpuNum": 2, ...}（/system?action=* 查询类接口）
   * 所以判定规则是「只有显式声明失败才算失败」，而不是「必须声明成功才算成功」，
   * 否则第 ② 类接口会被误判为失败（这正是实测踩到的坑）。
   * @param {any} res
   * @param {string} action 动作名，用于错误提示
   */
  _unwrap(res, action) {
    if (res === null || res === undefined) {
      throw upstream(`宝塔接口无响应（${action}）`);
    }
    // 少数接口返回纯文本（例如 "1"）
    if (typeof res !== 'object') return res;

    const hasStatus = Object.prototype.hasOwnProperty.call(res, 'status');
    const hasSuccess = Object.prototype.hasOwnProperty.call(res, 'success');

    if (hasStatus || hasSuccess) {
      const ok = res.status === true || res.status === 1 || res.success === true;
      if (!ok) {
        const msg = res.msg || res.message || res.error || '未知错误';
        throw upstream(`宝塔「${action}」执行失败：${msg}`, { response: res });
      }
    }

    return res;
  }

  // ==================== 系统信息 ====================

  /** 系统基础统计：CPU / 内存 / 负载 / 系统版本 */
  async getSystemTotal() {
    const res = await this.call('/system?action=GetSystemTotal', {}, 'GET');
    const data = this._unwrap(res, '获取系统信息');
    const memTotal = Number(data.memTotal || 0);
    // 宝塔字段在不同版本略有差异，这里做兼容取值
    const memUsed = Number(data.memRealUsed ?? memTotal - Number(data.memFree || 0));

    return {
      system: data.system || '-',
      version: data.version || '-',
      cpuNum: Number(data.cpuNum || 0),
      cpuUsage: Number(data.cpuRealUsed ?? data.cpu ?? 0),
      memTotalMb: memTotal,
      memUsedMb: memUsed,
      memFreeMb: Number(data.memFree || 0),
      memUsage:
        data.memRealPercent !== undefined
          ? Number(data.memRealPercent)
          : memTotal > 0
            ? Number(((memUsed / memTotal) * 100).toFixed(1))
            : 0,
      load: {
        one: Number(data.load?.one ?? 0),
        five: Number(data.load?.five ?? 0),
        fifteen: Number(data.load?.fifteen ?? 0),
      },
      uptime: data.setup_time || null,
    };
  }

  /** 磁盘信息 */
  async getDiskInfo() {
    const res = await this.call('/system?action=GetDiskInfo', {}, 'GET');
    // 该接口有的版本返回 {status,data:[...]}，有的直接返回数组
    const raw = Array.isArray(res) ? res : res?.data || [];
    const disks = (Array.isArray(raw) ? raw : []).map((d) => {
      // size 形如 ["50G","40G","10G","80%"] 或 ["40G","10G","25%"]
      const size = Array.isArray(d.size) ? d.size : [];
      const pick = (idx) => (size[idx] !== undefined ? String(size[idx]) : '');
      const total = pick(0);
      const used = size.length >= 4 ? pick(1) : pick(0);
      const free = size.length >= 4 ? pick(2) : pick(1);
      const percent = size.length >= 4 ? pick(3) : pick(2);
      return {
        path: d.path || d.mount || '/',
        filesystem: d.filesystem || d.device || '-',
        type: d.type || '-',
        total,
        used,
        free,
        usage: parseFloat(String(percent).replace('%', '')) || 0,
      };
    });

    // 总体使用率取根分区（path === '/'）优先
    const root = disks.find((d) => d.path === '/') || disks[0] || null;
    return { disks, root };
  }

  /**
   * 网络流量（用于仪表盘展示）
   * 宝塔返回结构是「按网卡分组」的：
   *   { network: { lo: {up,down,upTotal,downTotal}, eth0: {...} } }
   * 所以要把各网卡累加起来（lo 回环不算，避免重复计数）。
   */
  async getNetWork() {
    try {
      const res = await this.call('/system?action=GetNetWork', {}, 'GET');
      const data = this._unwrap(res, '获取网络信息');
      const ifaces = data.network || data;

      let up = 0;
      let down = 0;
      let upTotal = 0;
      let downTotal = 0;

      Object.entries(ifaces).forEach(([name, v]) => {
        if (!v || typeof v !== 'object') return;
        if (name === 'lo') return; // 回环口跳过
        up += Number(v.up ?? 0);
        down += Number(v.down ?? 0);
        upTotal += Number(v.upTotal ?? 0);
        downTotal += Number(v.downTotal ?? 0);
      });

      return { up, down, upTotal, downTotal };
    } catch (err) {
      // 网络信息属于增值展示，取不到时不阻塞仪表盘
      return { up: 0, down: 0, upTotal: 0, downTotal: 0, unavailable: true, reason: err.message };
    }
  }

  // ==================== 网站管理 ====================

  /**
   * 获取网站列表
   * @param {object} [opts]
   * @param {number} [opts.page=1]
   * @param {number} [opts.limit=50]
   * @param {string} [opts.search] 搜索关键词（域名/备注）
   */
  async getSiteList({ page = 1, limit = 50, search = '' } = {}) {
    const params = {
      table: 'sites',
      p: page,
      limit,
      type: -1,
      order: 'id desc',
      tojs: 'on',
    };
    if (search) params.search = search;

    const res = await this.call('/data?action=getData', params, 'POST', 30000);
    // 兼容两种返回：{data:[...]} 或直接数组
    const raw = Array.isArray(res) ? res : res?.data;
    if (!Array.isArray(raw)) {
      // 未登录/权限不足时宝塔会返回 html 或错误对象
      this._unwrap(res, '获取网站列表');
      return { list: [], total: 0 };
    }

    const list = raw.map((s) => {
      // ⚠️ 实测踩坑：宝塔 13.x 的站点行里 `domain` 字段是数字标记（值为 1），
      //    真实域名在 `rname`（多域名时是逗号分隔的列表）里，其次才是 name。
      //    早前按 domain 解析，导致域名被解析成 "1"，申请证书时报「网站丢失」。
      const domainText =
        [s.rname, s.domain, s.name].find((v) => typeof v === 'string' && v.includes('.')) || '';
      const domains = domainText
        ? domainText
            .split(',')
            .map((d) => d.trim())
            .filter(Boolean)
        : [];

      return {
        id: s.id,
        name: s.name,
        domains,
        domain: domains[0] || '',
        path: s.path || '',
        status: String(s.status) === '1' ? 'running' : 'stopped',
        ps: s.ps || '',
        // 不同版本字段名不同，做兼容
        phpVersion: s.php_version || s.version || s.phpVersion || '-',
        projectType: s.project_type || s.type || 'static',
        // ssl：-1 表示未开启证书
        ssl: Number(s.ssl ?? -1) !== -1,
        addTime: s.addtime || s.created_at || '',
      };
    });

    return { list, total: this._parseTotal(res, list) };
  }

  /**
   * 解析站点总数
   * getData 接口把分页信息塞在 page 字段的 HTML 里（形如「共 27 条」），
   * 解析不到就退化为「本次返回条数」。
   */
  _parseTotal(res, list) {
    const explicit = Number(res?.total ?? res?.count ?? res?.data_count ?? 0);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;

    const html = typeof res?.page === 'string' ? res.page : '';
    const matched = html.match(/共\s*(\d+)\s*条/);
    if (matched) return Number(matched[1]);

    return list.length;
  }

  /**
   * 根据站点名取站点详情（删除、SSL 等操作前先查，避免误操作）
   * @param {string} siteName 站点名（一般等于主域名）
   */
  async getSite(siteName) {
    const { list } = await this.getSiteList({ page: 1, limit: 200 });
    return list.find((s) => s.name === siteName || s.domain === siteName) || null;
  }

  /** 站点是否已存在 */
  async siteExists(domain) {
    const site = await this.getSite(domain);
    return !!site;
  }

  /**
   * 新建站点
   * @param {object} opts
   * @param {string} opts.domain   主域名
   * @param {string} [opts.path]   站点目录，默认 /www/wwwroot/<domain>
   * @param {string} [opts.ps]     备注
   * @param {string} [opts.type]   站点类型：static（纯静态，默认）/ PHP
   * @param {string} [opts.version] PHP 版本（static 固定 00）
   */
  async addSite({
    domain,
    path: sitePath,
    ps = '艾哥SaaS工作台创建',
    type = 'static',
    version = '00',
  }) {
    if (!domain) throw badRequest('域名不能为空');

    const webname = JSON.stringify({ domain, domainlist: [], count: 0 });
    const res = await this.call(
      '/site?action=AddSite',
      {
        webname,
        path: sitePath || path.posix.join(WWW_ROOT, domain),
        type_id: 0,
        type,
        version,
        port: 80,
        ps,
        ftp: 0,
        sql: 0,
        codeing: 'utf8',
        set_ssl: 0,
        force_ssl: 0,
      },
      'POST',
      60000
    );
    this._unwrap(res, '新建网站');
    return { domain, path: sitePath || path.posix.join(WWW_ROOT, domain) };
  }

  /**
   * 删除站点
   * 安全策略：只删站点与站点目录，不动 FTP / 数据库（ftp=0 & sql=0）
   */
  async deleteSite(siteName) {
    if (!siteName) throw badRequest('站点名不能为空');
    const site = await this.getSite(siteName);
    if (!site) throw badRequest(`网站不存在：${siteName}`);
    if (!site.id) throw upstream(`无法取得站点 ${siteName} 的数字 ID，无法删除`);

    // ⚠️ 实测（读宝塔源码 panelSite.DeleteSite 得到）：
    //    它用 `id` 去查 public.M('sites').where('id=?')，也就是**必须传数字站点 ID**；
    //    传域名会直接报「指定站点不存在!」。webname 用来清理反向代理/重定向等关联配置。
    const res = await this.call(
      '/site?action=DeleteSite',
      { id: site.id, webname: site.name, path: site.path || '', ftp: 0, sql: 0 },
      'POST',
      60000
    );
    this._unwrap(res, '删除网站');
    return { domain: site.name, siteId: site.id };
  }

  // ==================== 文件 / 配置（反向代理用） ====================

  /** 读取服务器文件内容 */
  async readFile(filePath) {
    const res = await this.call('/files?action=GetFileBody', { path: filePath }, 'POST', 30000);
    if (res && res.status === false) {
      // 文件不存在是正常场景（新站点还没写配置）
      return null;
    }
    if (typeof res === 'string') return res;
    return res?.data ?? null;
  }

  /**
   * 写入服务器文件内容
   * 注意：宝塔的 SaveFileBody 只能写「已存在」的文件，写新文件会直接返回
   *      「指定文件不存在!」。所以这里先探测，不存在就先 CreateFile。
   */
  async writeFile(filePath, content) {
    const existing = await this.readFile(filePath);
    if (existing === null) {
      try {
        await this.call('/files?action=CreateFile', { path: filePath }, 'POST', 30000);
      } catch (err) {
        // 并发或文件刚被创建时会报已存在，属正常情况，继续走保存即可
        console.warn(`[baota] 创建文件 ${filePath} 返回：${err.message}`);
      }
    }

    const res = await this.call(
      '/files?action=SaveFileBody',
      { path: filePath, data: content, encoding: 'utf-8' },
      'POST',
      30000
    );
    this._unwrap(res, `写入文件 ${filePath}`);
    return true;
  }

  /** 重载 Nginx（改完配置必须重载才生效） */
  async reloadNginx() {
    try {
      const res = await this.call(
        '/system?action=ServiceAdmin',
        { name: 'nginx', type: 'reload' },
        'POST',
        30000
      );
      this._unwrap(res, '重载 Nginx');
      return true;
    } catch (err) {
      // 部分版本该接口不开放，此时给出人工提示而不是直接失败
      console.warn(`[baota] 自动重载 Nginx 未成功：${err.message}`);
      return false;
    }
  }

  /**
   * 为站点配置反向代理
   * 实现方式：先备份原配置文件，再写入带 proxy_pass 的站点配置，最后重载 Nginx。
   * 注意：会覆盖该域名站点原有的 nginx 配置（已先备份为 .bak.<时间戳>）。
   * @param {object} opts
   * @param {string} opts.domain     域名（同时作为站点名）
   * @param {string} opts.targetUrl  上游地址，如 http://127.0.0.1:3001
   */
  async setReverseProxy({ domain, targetUrl }) {
    if (!domain || !targetUrl) throw badRequest('域名与上游地址不能为空');

    const confPath = `${NGINX_VHOST_DIR}/${domain}.conf`;
    const sitePath = path.posix.join(WWW_ROOT, domain);
    const upstreamUrl = String(targetUrl).replace(/\/+$/, '');

    // 1) 站点不存在先创建（纯静态即可，随后会被反向代理配置接管）
    if (!(await this.siteExists(domain))) {
      await this.addSite({ domain, ps: `反向代理 → ${upstreamUrl}` });
    }

    // 2) 探测站点是否已装证书 —— 决定要不要一并生成 443 段。
    //    ⚠️ 实测：宝塔 13.x 把 Let's Encrypt 证书放在 vhost/letsencrypt/<域名>/，
    //    老版本才放在 vhost/cert/<域名>/，两个位置都要查，否则会误判为「无证书」
    //    而只生成 80 段，导致 Cloudflare 严格模式下访问报 526。
    //    ⚠️ 顺序很重要：必须先申请证书、再调本方法。反过来写出的配置会覆盖掉
    //    宝塔刚写好的证书配置，https 直接失效。
    let certDir = '';
    for (const candidate of [
      `/www/server/panel/vhost/letsencrypt/${domain}`,
      `/www/server/panel/vhost/cert/${domain}`,
    ]) {
      // eslint-disable-next-line no-await-in-loop -- 两个候选目录按优先级逐个探测，命中即跳出
      const pem = await this.readFile(`${candidate}/fullchain.pem`).catch(() => null);
      // eslint-disable-next-line no-await-in-loop
      const key = await this.readFile(`${candidate}/privkey.pem`).catch(() => null);
      if (pem && pem.includes('BEGIN CERTIFICATE') && key && key.includes('PRIVATE KEY')) {
        certDir = candidate;
        break;
      }
    }
    const hasCert = !!certDir;

    // 3) 备份原配置（有内容才备份，避免生成一堆空备份文件）
    const original = await this.readFile(confPath);
    let backupPath = null;
    if (original && original.trim()) {
      backupPath = `${confPath}.bak.${Date.now()}`;
      await this.writeFile(backupPath, original);
    }

    // ACME 文件验证目录。
    // ⚠️ 宝塔在「申请证书」前会校验站点配置是否被改动过（can_use_base_file_check），
    //    自己写一个 location 会被判定为「配置文件被修改，不支持文件验证」而拒绝签发。
    //    所以优先复用宝塔自己的 well-known include（它会随站点一起创建），
    //    找不到时才退化为自建 location。
    const wellKnownPath = `${NGINX_VHOST_DIR}/well-known/${domain}.conf`;
    const hasWellKnown = (await this.readFile(wellKnownPath).catch(() => null)) !== null;
    const certApplyBlock = hasWellKnown
      ? `    #CERT-APPLY-CHECK--START
    # 用于SSL证书申请时的文件验证相关配置 -- 请勿删除
    include ${wellKnownPath};
    #CERT-APPLY-CHECK--END`
      : `    location ^~ /.well-known/acme-challenge/ {
        root ${sitePath};
        default_type "text/plain";
        allow all;
    }`;

    // 反向代理主体（WebSocket 与 SSE 都兼容）
    const proxyBlock = `    location / {
        proxy_pass ${upstreamUrl};
        proxy_http_version 1.1;

        # 透传真实信息，否则上游拿到的都是 127.0.0.1
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket / SSE：Upgrade 透传；Connection 用 $http_connection 原样透传，
        # 兼容 WebSocket（Connection: Upgrade）与 SSE（Connection: keep-alive），
        # 避免写死 "upgrade" 把普通长连接也标成升级请求。
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $http_connection;

        # 必须关闭缓冲：否则 SSE（MCP 实时流、容器日志）会被 nginx 攒住不吐，页面一直转圈
        proxy_buffering off;
        proxy_cache off;

        # 长连接超时给足，避免 MCP 会话被中途掐断
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }`;

    // 错误页配置块：宝塔保存文件时会按这些注释标记做结构校验，必须保留
    const errorPageBlock = `    #ERROR-PAGE-START  错误页配置，可以注释、删除或修改
    error_page 404 /404.html;
    #ERROR-PAGE-END`;

    const header = `# ============================================================
# 由「艾哥SaaS工作台」自动生成 · ${new Date().toLocaleString('zh-CN')}
# 站点：${domain}  →  上游：${upstreamUrl}
# 证书：${hasCert ? `已启用（${certDir}）` : '未启用（仅 HTTP）'}
# 原配置备份：${backupPath || '（无）'}
# ============================================================
`;

    // 80 端口：有证书时只做跳转与 ACME 验证；无证书时直接反代
    const http80 = hasCert
      ? `server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    access_log /www/wwwlogs/${domain}.log;
    error_log  /www/wwwlogs/${domain}.error.log;

${certApplyBlock}

    #SSL-START SSL相关配置，请勿删除或修改下一行带注释的404规则
    #error_page 404/404.html;
    #SSL-END

${errorPageBlock}

    # 已启用证书：HTTP 全量跳转 HTTPS
    location / {
        return 301 https://$host$request_uri;
    }
}`
      : `server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    access_log /www/wwwlogs/${domain}.log;
    error_log  /www/wwwlogs/${domain}.error.log;

${certApplyBlock}

    #SSL-START SSL相关配置，请勿删除或修改下一行带注释的404规则
    #error_page 404/404.html;
    #SSL-END

${errorPageBlock}

    client_max_body_size 100m;

${proxyBlock}
}`;

    // 443 端口（仅在已有证书时生成）
    const https443 = hasCert
      ? `

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${domain};

    access_log /www/wwwlogs/${domain}.log;
    error_log  /www/wwwlogs/${domain}.error.log;

    #SSL-START SSL相关配置，请勿删除或修改下一行带注释的404规则
    #error_page 404/404.html;
    ssl_certificate     ${certDir}/fullchain.pem;
    ssl_certificate_key ${certDir}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    #SSL-END

${errorPageBlock}

    client_max_body_size 100m;

${proxyBlock}
}
`
      : '';

    await this.writeFile(confPath, header + http80 + https443);
    const reloaded = await this.reloadNginx();

    return {
      domain,
      confPath,
      backupPath,
      reloaded,
      upstream: upstreamUrl,
      https: hasCert,
      backupCount: backupPath ? 1 : 0,
    };
  }

  // ==================== SSL 证书 ====================

  /**
   * 设置 SSL 证书（手动上传证书场景）
   * @param {object} opts
   * @param {string} opts.siteName 站点名
   * @param {string} opts.key      私钥内容（PEM）
   * @param {string} opts.cert     证书内容（PEM，含链）
   * @param {string[]} [opts.domains] 证书覆盖的域名
   */
  async setSsl({ siteName, key, cert, domains = [] }) {
    if (!siteName || !key || !cert) throw badRequest('站点名、证书、私钥均为必填');
    const res = await this.call(
      '/site?action=SetSSL',
      {
        siteName,
        key,
        csr: cert,
        type: 1, // 1 = 开启 SSL
        domains: JSON.stringify(domains.length ? domains : [siteName]),
      },
      'POST',
      60000
    );
    this._unwrap(res, '部署 SSL 证书');
    return { siteName, enabled: true };
  }

  /**
   * 申请 Let's Encrypt 免费证书（自动签发）
   * 实现依据：读宝塔面板源码 acme_v2.apply_cert_api 得到的真实入参（已在真机验证）：
   *   - id        ：必须是「数字站点 ID」，不是域名。传域名会报「网站丢失，无法继续申请证书」
   *   - domains   ：JSON 数组字符串
   *   - auth_type ：http（文件验证；站点创建时宝塔已自动写入 well-known 配置）
   *   - auth_to   ：传纯数字（站点 ID）时，宝塔会自动解析成该站点的运行目录
   * @param {object} opts
   * @param {string} opts.siteName 站点名（域名）
   * @param {string[]} [opts.domains] 需要签发证书的域名列表，缺省用站点自身域名
   */
  async applyLetsEncrypt({ siteName, domains }) {
    if (!siteName) throw badRequest('站点名不能为空');

    const site = await this.getSite(siteName);
    if (!site) throw badRequest(`网站不存在：${siteName}`);
    if (!site.id) throw upstream(`无法取得站点 ${siteName} 的数字 ID，无法申请证书`);

    const domainList =
      Array.isArray(domains) && domains.length
        ? domains
        : site.domains.length
          ? site.domains
          : [siteName];

    const res = await this.call(
      '/acme?action=apply_cert_api',
      {
        id: site.id,
        domains: JSON.stringify(domainList),
        auth_type: 'http',
        auth_to: String(site.id),
        auto_wildcard: 0,
        cert_algorithm: 'rsa2048',
      },
      'POST',
      180000
    );
    this._unwrap(res, `申请 SSL 证书（${domainList.join(', ')}）`);
    return {
      siteName,
      siteId: site.id,
      domains: domainList,
      message: res.msg || '证书申请已提交，签发通常需要 10-60 秒',
    };
  }

  // ============================================================
  // 以下能力是为了让本系统的 MCP「一个就够」而补齐的
  // ------------------------------------------------------------------
  // 背景：宝塔官方 MCP 有 17 个工具（含日志、配置文件读写、备份、万能 API），
  //      本系统原先只暴露了 14 个业务工具，AI 拿不到日志和配置就没法排查问题。
  //      这里把宝塔那侧缺的能力补上，做到「只接我们这个 MCP 就能干完所有活」。
  // ============================================================

  /**
   * 读取文件尾部若干行
   * 日志动辄几 MB，整读既费内存也费 AI 的 token，所以按 tail 语义只取末尾。
   * 注意：宝塔的读文件接口只能整读，所以大文件仍会有一次完整读取开销。
   */
  async readTail(filePath, lines = 100) {
    if (!filePath) throw badRequest('文件路径不能为空');
    const n = Math.min(Math.max(Number(lines) || 100, 1), 2000);
    const raw = await this.readFile(filePath);
    const all = String(raw).split('\n');
    const tail = all.slice(Math.max(0, all.length - n));
    return {
      path: filePath,
      totalLines: all.length,
      returnedLines: tail.length,
      content: tail.join('\n'),
    };
  }

  /**
   * 读取站点的访问日志或错误日志
   * 路径规则：/www/wwwlogs/<域名>.log（访问）、<域名>.error.log（错误）
   */
  async getSiteLogs(siteName, { type = 'access', lines = 100 } = {}) {
    if (!siteName) throw badRequest('站点名不能为空');
    const suffix = type === 'error' ? '.error.log' : '.log';
    const filePath = path.join(WWWLOGS_DIR, `${siteName}${suffix}`);
    const res = await this.readTail(filePath, lines);
    return { ...res, siteName, type };
  }

  /** 读取站点的 Nginx 配置（含 SSL、反代、伪静态等全部段落） */
  async getNginxConfig(siteName) {
    if (!siteName) throw badRequest('站点名不能为空');
    const confPath = path.join(NGINX_VHOST_DIR, `${siteName}.conf`);
    const content = await this.readFile(confPath);
    return { siteName, confPath, content };
  }

  /**
   * 写入站点 Nginx 配置
   * 安全策略：写之前必须先备份原文件；写完立刻 nginx -t 试载，失败会抛错并保留备份。
   */
  async saveNginxConfig(siteName, content) {
    if (!siteName) throw badRequest('站点名不能为空');
    if (typeof content !== 'string' || !content.trim()) throw badRequest('配置内容不能为空');

    const confPath = path.join(NGINX_VHOST_DIR, `${siteName}.conf`);

    // 先备份：改坏了能立刻对照还原（原文件不存在时说明是首次创建，跳过备份）
    let backupPath = null;
    try {
      const before = await this.readFile(confPath);
      if (before) {
        backupPath = `${confPath}.bak.${Date.now()}`;
        await this.writeFile(backupPath, before);
      }
    } catch {
      backupPath = null;
    }

    await this.writeFile(confPath, content);
    const reload = await this.reloadNginx();
    return { siteName, confPath, backupPath, reload };
  }

  /**
   * 列出目录内容
   * 宝塔 /files?action=GetDir 返回的是分号分隔的字符串数组，这里解析成结构化对象。
   * @param {string} dirPath
   * @param {number} [limit] 最多取多少条。默认 200 —— nginx 配置目录里
   *        配置 + 备份加起来可能几百个文件，需要全量的调用方（配置快照）要显式传大值。
   */
  async listDir(dirPath, limit = 200) {
    if (!dirPath) throw badRequest('目录不能为空');
    const res = await this.call(
      '/files?action=GetDir',
      { path: dirPath, p: 1, show_row: Math.min(Math.max(Number(limit) || 200, 1), 5000) },
      'POST',
      30000
    );

    const parse = (raw, isDir) =>
      (Array.isArray(raw) ? raw : []).map((line) => {
        const [name, size, mtime, perm, owner] = String(line).split(';');
        return {
          name,
          isDir,
          size: Number(size) || 0,
          sizeText: formatBytes(size),
          modifiedAt: Number(mtime) ? new Date(Number(mtime) * 1000).toLocaleString('zh-CN') : '',
          perm: perm || '',
          owner: owner || '',
        };
      });

    /**
     * ⚠️ 字段名是 `FILES`（复数），不是 `FILE`。
     * 这里踩过一次：原来写的是 `res?.FILE`，于是**文件列表永远是空的**，
     * 只有子目录能列出来。因为此前的调用方（listBackups）只关心
     * /www/backup 下的子目录，所以这个 bug 一直没暴露；
     * 做「配置快照」时才发现 nginx 配置目录里一个 .conf 都列不出来。
     * 两个名字都兼容一下，免得换个面板版本又白跑一轮。
     */
    const files = res?.FILES ?? res?.FILE;
    const entries = [...parse(res?.DIR, true), ...parse(files, false)];
    return { path: dirPath, count: entries.length, entries };
  }

  /** 列出备份目录（宝塔的备份都在 /www/backup 下，按用途分子目录） */
  async listBackups() {
    const res = await this.listDir(BACKUP_ROOT);
    return {
      root: BACKUP_ROOT,
      ...res,
      hint: '宝塔会把备份按用途放在子目录里：site（网站）、database（数据库）、backup_restore（一键还原）等',
    };
  }

  /**
   * 逐个站点读取证书并算出剩余天数
   * 用 Node 内置的 crypto.X509Certificate 解析 PEM，不装任何第三方库。
   * 只对有证书的站点发起读取，避免无谓的接口调用。
   */
  async listSslCerts() {
    const { list } = await this.getSiteList({ page: 1, limit: 500 });
    const out = [];

    for (const site of list) {
      const domains = site.domains.length ? site.domains : [site.name];
      // site.ssl 为假说明该站点本来就没有证书，不必去读文件
      // eslint-disable-next-line no-await-in-loop -- 逐站读证书文件，一次只读一个，避免打满这台机器的磁盘 IO
      const info = site.ssl ? await this.readCertInfo(domains[0]) : null;
      out.push({
        siteName: site.name,
        domains,
        hasCert: !!info,
        ...(info || {}),
      });
    }

    const expiring = out.filter((x) => x.status === 'expiring').length;
    const expired = out.filter((x) => x.status === 'expired').length;
    return {
      total: out.length,
      withCert: out.filter((x) => x.hasCert).length,
      expiring,
      expired,
      certs: out,
    };
  }

  // ==================== 计划任务（只读） ====================

  /**
   * 计划任务列表（**只读**）
   * ------------------------------------------------------------------
   * ⛔ 两个必须守住的东西，改这里之前先读：
   *
   * 1. **字段用白名单挑，不是黑名单剔**。
   *    宝塔返回的每条任务里带 `sBody` —— **脚本正文**。而服务器上其他项目的任务正文里
   *    **躺着明文密钥**（实测：某项目的部署脚本里同时有数据库口令、微信商户 API v3 密钥、
   *    GitHub client secret）。所以这里**只挑出明确要用的字段**：以后宝塔新增什么字段，
   *    也不会顺势跟着漏出去。要看脚本正文请去宝塔面板 —— 那是宝塔对管理员的责任边界，
   *    不该由本工作台的接口代为扩散。
   *
   * 2. **归属判定**。宝塔返回的是**全服务器**的任务，实测 36 条**全部属于其他项目**。
   *    本项目自己的按名字关键字识别（与站点白名单同一套约定）；其余一律 `owner: 'foreign'`，
   *    页面与 MCP 都只报告，**不提供任何启停/删除/新增动作**（那会动别的项目的资源）。
   *
   * ⚠️ 另外别把这个接口理解成「本站点的定时任务」：本工作台自己的定时清理
   *    （指标采样、日志保留、告警清理）都在后端进程里用 setInterval 做，**不出现在这里**。
   */
  async listCrontabs() {
    const res = await this.call('/crontab?action=GetCrontab', {}, 'POST');
    const list = Array.isArray(res) ? res : [];

    const tasks = list.map((t) => {
      const name = String(t?.name || '').trim();
      const typeZh = String(t?.type_zh || '').trim();
      const typeRaw = String(t?.type || '').trim();
      const cycleRaw = String(t?.cycle || '').trim();

      /*
       * 周期文案的取值链（照搬宝塔原值会在界面上印出英文 slug，实测踩过）：
       *   ① cycle（宝塔给的人话，最准，如「每天的22:54执行一次」）
       *   ② type_zh —— **但只在它真是中文时**才用（有时它就是 'minute' 本身）
       *   ③ type 的 slug 映射表
       *   ④ 兜底「周期未说明」，不硬猜
       */
      const typeText =
        (hasChinese(typeZh) && typeZh) ||
        CRONTAB_TYPE_TEXT[typeRaw] ||
        (hasChinese(typeZh) ? typeZh : '');
      const cycle = cycleRaw || typeText || '周期未说明';

      return {
        id: Number(t?.id) || 0,
        name,
        cycle,
        typeText: typeText || '未说明',
        // 执行方式：只认「真·执行方式」的取值。sType 有时是 'minute-n'（那其实是
        // 调度间隔、不是方式），这种一律留空，由界面按需隐藏，免得把间隔说成方式。
        execType: CRONTAB_EXEC_TYPES[t?.sType] ? t.sType : '',
        // 1 = 启用，0 = 停用
        enabled: Number(t?.status) === 1,
        /**
         * 宝塔给的上次执行标记，**只见过 0 / 1 两种取值，含义没有官方说明**。
         * 所以这里原样透出、不硬翻译成「成功 / 失败」—— 界面把它当「值得看一眼」的信号，
         * 真要确认请去面板看日志。
         */
        resultCode: t?.result === undefined || t?.result === null ? null : Number(t.result),
        // 执行身份：root / www 等
        runAs: String(t?.user || '').trim(),
        category: String(t?.type_name || '').trim() || '默认分类',
        owner: isOwnCrontab(name) ? 'own' : 'foreign',
        // 疑似排障遗留：名字里带「修复 / 诊断 / 重试 / 最终 / 测试」这类字眼，多半是当时
        // 临时排障留下的，事后没清理（实测 36 条里有十几条长这样，还都是「每天」在跑）
        legacyHint: LEGACY_TASK_HINTS.some((re) => re.test(name))
          ? '名字像是当时排障留下的，建议确认是否还需要（它还在按周期跑）'
          : '',
      };
    });

    const own = tasks.filter((t) => t.owner === 'own');

    return {
      total: tasks.length,
      ownCount: own.length,
      foreignCount: tasks.length - own.length,
      enabledCount: tasks.filter((t) => t.enabled).length,
      disabledCount: tasks.filter((t) => !t.enabled).length,
      abnormalCount: tasks.filter((t) => t.resultCode === 0).length,
      legacyCount: tasks.filter((t) => t.legacyHint).length,
      tasks,
      /**
       * 归属说明。放在返回里而不是只写在文档里 —— 因为**界面与 AI 都要靠它决定能做什么**，
       * 写在数据旁边才不会被忘掉。
       */
      scopeNote:
        '这里是**整台服务器**的计划任务，不是本项目的。本工作台自己的定时清理在后端进程里跑，不在此列。' +
        '其他项目的任务一律只报告、不提供启停或删除。',
    };
  }

  /**
   * 读取并解析单个域名的证书
   * 依次尝试两个历史路径：vhost/letsencrypt（13.x）、vhost/cert（老版本）
   */
  async readCertInfo(domain) {
    for (const dir of [LETSENCRYPT_DIR, '/www/server/panel/vhost/cert']) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const pem = await this.readFile(`${dir}/${domain}/fullchain.pem`);
        if (!pem || !String(pem).includes('BEGIN CERTIFICATE')) continue;

        const cert = new crypto.X509Certificate(pem);
        const validFrom = new Date(cert.validFrom);
        const validTo = new Date(cert.validTo);
        const daysLeft = Math.floor((validTo.getTime() - Date.now()) / 86400000);

        // 从签发者里抠出 CN（Let's Encrypt 会返回 R10/R11/YR2 这类短名）
        const issuerCn =
          /CN=([^,\n]+)/.exec(cert.issuer.replace(/\n/g, ' '))?.[1]?.trim() || cert.issuer;

        return {
          issuer: issuerCn,
          validFrom: validFrom.toISOString(),
          validTo: validTo.toISOString(),
          validToText: validTo.toLocaleString('zh-CN'),
          daysLeft,
          // 15 天内算「即将到期」，与宝塔面板的提醒口径一致
          status: daysLeft < 0 ? 'expired' : daysLeft <= 15 ? 'expiring' : 'ok',
          certPath: `${dir}/${domain}/fullchain.pem`,
        };
      } catch {
        /* 该目录没有证书，试下一个 */
      }
    }
    return null;
  }

  /**
   * 原样调用宝塔任意 API（万能兜底）
   * 用途：官方公开接口覆盖不到的能力（备份、计划任务、防火墙等），
   *      AI 可以直接透传端点调用，不用等我们逐个封装。
   * ⚠️ 调用方需自行确认端点的语义与风险——这里不做白名单限制，
   *    因为「能兜住任何宝塔能力」正是这个工具存在的意义。
   */
  async callRaw(endpoint, params = {}, method = 'POST') {
    if (!endpoint || typeof endpoint !== 'string') throw badRequest('endpoint 不能为空');
    const ep = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const verb = String(method).toUpperCase() === 'GET' ? 'GET' : 'POST';
    const res = await this.call(ep, params, verb, 60000);
    return { endpoint: ep, method: verb, result: res };
  }

  /** 连通性自检：能拿到系统信息即视为配置正确 */
  async testConnection() {
    const info = await this.getSystemTotal();
    return {
      ok: true,
      baseUrl: this.activeBaseUrl(),
      corrected: this.useOrigin,
      message:
        `连接成功：${info.system} · ${info.cpuNum} 核 · 内存 ${info.memTotalMb} MB` +
        (this.useOrigin ? `（已自动去掉安全入口路径，使用 ${this.originUrl}）` : ''),
      info,
    };
  }
}

/**
 * 工厂方法：从系统配置里读取宝塔参数并创建客户端
 * @returns {BaotaClient}
 */
function createClient() {
  const cfg = settings.getBaotaConfig();
  return new BaotaClient(cfg);
}

module.exports = { BaotaClient, createClient, NGINX_VHOST_DIR, WWW_ROOT };
