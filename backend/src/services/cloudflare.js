/**
 * Cloudflare API 对接
 * ------------------------------------------------------------------
 * 认证：Bearer Token（API Token，不是 Global API Key）
 *     建议权限：Zone → Zone → Read，Zone → DNS → Edit
 * 文档：https://developers.cloudflare.com/api/
 *
 * 统一封装了「取 zones / 取解析记录 / 增删改解析 / 切换代理」四类操作，
 * 分页统一由本文件处理，上层拿到的是完整列表。
 */
'use strict';

const settings = require('./settings');
const { request } = require('../utils/http');
const { AppError, upstream, badRequest } = require('../utils/errors');

const API_BASE = 'https://api.cloudflare.com/client/v4';

class CloudflareClient {
  /**
   * @param {object} options
   * @param {string} options.apiToken Cloudflare API Token
   */
  constructor({ apiToken }) {
    if (!apiToken) {
      throw new AppError(
        'Cloudflare 尚未配置，请先到「系统设置」填写 API Token',
        428,
        'NOT_CONFIGURED'
      );
    }
    this.apiToken = apiToken;
  }

  /**
   * 调用 Cloudflare API
   * @param {string} endpoint 形如 /zones
   * @param {object} [options] { method, body, query, timeout, serviceName }
   */
  async call(endpoint, options = {}) {
    const { method = 'GET', body, query, timeout = 20000 } = options;
    const url = new URL(`${API_BASE}${endpoint}`);
    if (query) {
      Object.entries(query).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') url.searchParams.append(k, String(v));
      });
    }

    const res = await request(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body,
      timeout,
      serviceName: 'Cloudflare',
    });

    // Cloudflare 统一格式：{ success, errors: [{code,message}], result, result_info }
    if (res && res.success === false) {
      const detail =
        (res.errors || []).map((e) => `${e.code}: ${e.message}`).join('；') || '未知错误';
      throw upstream(`Cloudflare 接口返回失败：${detail}`, { endpoint, errors: res.errors });
    }
    if (!res || res.success !== true) {
      throw upstream('Cloudflare 返回格式异常', { endpoint, response: res });
    }
    return res;
  }

  /**
   * 获取所有域名区域（自动翻页取全量）
   * @param {object} [opts] { pageSize, name }
   */
  async listZones({ pageSize = 50, name = '' } = {}) {
    const all = [];
    let page = 1;

    /* eslint-disable no-await-in-loop */
    for (;;) {
      const res = await this.call('/zones', {
        query: {
          page,
          per_page: pageSize,
          name: name || undefined,
          order: 'name',
          status: 'active',
        },
      });
      const batch = res.result || [];
      all.push(...batch);
      const info = res.result_info || {};
      if (!batch.length || page >= (info.total_pages || 1) || page >= 20) break;
      page += 1;
    }
    /* eslint-enable no-await-in-loop */

    return all.map((z) => ({
      id: z.id,
      name: z.name,
      status: z.status,
      paused: z.paused,
      type: z.type,
      plan: z.plan?.name || '-',
      nameServers: z.name_servers || [],
      accountName: z.account?.name || '-',
      createdOn: z.created_on,
      modifiedOn: z.modified_on,
    }));
  }

  /**
   * 按域名反查 zone
   * @param {string} domain 完整域名或主域名
   */
  async findZoneByDomain(domain) {
    const clean = String(domain || '')
      .trim()
      .toLowerCase();
    if (!clean) throw badRequest('域名不能为空');

    // 直接按完整域名查一次，命中即返回（最快路径）
    const direct = await this.call('/zones', { query: { name: clean, per_page: 1 } });
    if (direct.result?.length) {
      return this._mapZone(direct.result[0]);
    }

    // 逐级去子域再查：a.b.example.com → b.example.com → example.com
    const parts = clean.split('.');
    for (let i = 1; i < parts.length - 1; i += 1) {
      const candidate = parts.slice(i).join('.');
      // eslint-disable-next-line no-await-in-loop -- 逐级向上找 zone，命中即 return，越往后次数越少
      const res = await this.call('/zones', { query: { name: candidate, per_page: 1 } });
      if (res.result?.length) return this._mapZone(res.result[0]);
    }

    throw badRequest(
      `Cloudflare 里找不到域名 ${clean} 所属的区域（zone）。请确认该主域名已托管在 Cloudflare，且 Token 有 Zone:Read 权限。`
    );
  }

  _mapZone(z) {
    return {
      id: z.id,
      name: z.name,
      status: z.status,
      plan: z.plan?.name || '-',
    };
  }

  /**
   * 获取某个 zone 下的全部 DNS 记录
   * @param {string} zoneId
   * @param {object} [opts] { type, search }
   */
  async listDnsRecords(zoneId, { type = '', search = '' } = {}) {
    if (!zoneId) throw badRequest('zone_id 不能为空');

    const all = [];
    let page = 1;

    /* eslint-disable no-await-in-loop */
    for (;;) {
      const res = await this.call(`/zones/${zoneId}/dns_records`, {
        query: {
          page,
          per_page: 100,
          type: type || undefined,
          search: search || undefined,
          order: 'type',
        },
      });
      const batch = res.result || [];
      all.push(...batch);
      const info = res.result_info || {};
      if (!batch.length || page >= (info.total_pages || 1) || page >= 50) break;
      page += 1;
    }
    /* eslint-enable no-await-in-loop */

    return all.map((r) => ({
      id: r.id,
      zoneId: r.zone_id,
      type: r.type,
      name: r.name,
      content: r.content,
      proxied: !!r.proxied,
      proxiable: r.proxiable,
      ttl: r.ttl,
      priority: r.priority,
      comment: r.comment || '',
      createdOn: r.created_on,
      modifiedOn: r.modified_on,
    }));
  }

  /**
   * 新增 DNS 解析记录
   * @param {string} zoneId
   * @param {object} record { type, name, content, proxied, ttl, priority, comment }
   */
  async createDnsRecord(zoneId, record) {
    if (!zoneId) throw badRequest('zone_id 不能为空');
    const { type, name, content } = record || {};
    if (!type || !name || !content) throw badRequest('type、name、content 均为必填');

    const payload = {
      type: String(type).toUpperCase(),
      name: String(name).trim(),
      content: String(content).trim(),
      ttl: record.ttl ?? 1, // 1 = 自动
    };
    // 只有 A / AAAA / CNAME 支持代理开关
    if (['A', 'AAAA', 'CNAME'].includes(payload.type)) {
      payload.proxied = record.proxied !== false;
    }
    if (payload.type === 'MX') payload.priority = record.priority ?? 10;
    if (record.comment) payload.comment = record.comment;

    const res = await this.call(`/zones/${zoneId}/dns_records`, { method: 'POST', body: payload });
    return {
      id: res.result.id,
      type: res.result.type,
      name: res.result.name,
      content: res.result.content,
      proxied: !!res.result.proxied,
    };
  }

  /** 删除 DNS 解析记录 */
  async deleteDnsRecord(zoneId, recordId) {
    if (!zoneId || !recordId) throw badRequest('zone_id 与 record_id 均为必填');
    await this.call(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
    return { id: recordId, deleted: true };
  }

  /**
   * 更新 DNS 解析记录（内容或代理状态）
   * @param {string} zoneId
   * @param {string} recordId
   * @param {object} patch 需要修改的字段
   */
  async updateDnsRecord(zoneId, recordId, patch = {}) {
    if (!zoneId || !recordId) throw badRequest('zone_id 与 record_id 均为必填');

    // Cloudflare 的 PUT 要求提交完整记录，所以先读原记录再合并
    const current = await this.call(`/zones/${zoneId}/dns_records/${recordId}`);
    const r = current.result;
    const payload = {
      type: patch.type ?? r.type,
      name: patch.name ?? r.name,
      content: patch.content ?? r.content,
      ttl: patch.ttl ?? r.ttl,
    };
    const proxied = patch.proxied !== undefined ? patch.proxied : r.proxied;
    if (['A', 'AAAA', 'CNAME'].includes(payload.type)) payload.proxied = !!proxied;
    if (payload.type === 'MX') payload.priority = patch.priority ?? r.priority ?? 10;

    const res = await this.call(`/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'PUT',
      body: payload,
    });
    return {
      id: res.result.id,
      ...recordFields(res.result),
      // B6 审计用：改动**前**的值。
      // 本次更新本来就为了合并字段而读过原记录（见上面的 GET），所以不额外发请求。
      // 调用方写操作日志时用它做 before，业务侧可忽略。
      before: recordFields(r),
    };
  }

  /** 只切换代理开关（橙色云 / 灰色云） */
  async toggleProxy(zoneId, recordId, proxied) {
    return this.updateDnsRecord(zoneId, recordId, { proxied: !!proxied });
  }

  /**
   * 「保证存在」某条解析：已存在同类型同名的记录就复用，否则新建
   * 用于应用部署时自动配域名，避免重复添加产生冲突记录
   * @returns {{ record: object, created: boolean }}
   */
  async ensureDnsRecord(zoneId, record) {
    const existing = await this.listDnsRecords(zoneId);
    const hit = existing.find(
      (r) => r.type.toUpperCase() === String(record.type).toUpperCase() && r.name === record.name
    );
    if (hit) return { record: hit, created: false };
    const created = await this.createDnsRecord(zoneId, record);
    return { record: created, created: true };
  }

  // ============================================================
  // 以下为「让本系统的 MCP 一个就够」补齐的 Cloudflare 能力
  // ============================================================

  /** 获取单个区域详情（状态、套餐、DNS 服务器、SSL 模式） */
  async getZone(zoneId) {
    if (!zoneId) throw badRequest('zone_id 不能为空');
    const res = await this.call(`/zones/${zoneId}`);
    const z = res.result || {};
    return {
      id: z.id,
      name: z.name,
      status: z.status,
      paused: !!z.paused,
      plan: z.plan?.name || '',
      nameServers: z.name_servers || [],
      createdAt: z.created_on || '',
      // SSL 模式不在 zone 对象里，单独查一次；查不到不影响主结果
      sslMode: await this.getSslMode(zoneId).catch(() => null),
    };
  }

  /** 读取区域的 SSL 模式：off / flexible / full / strict */
  async getSslMode(zoneId) {
    if (!zoneId) throw badRequest('zone_id 不能为空');
    const res = await this.call(`/zones/${zoneId}/settings/ssl`);
    return res.result?.value || null;
  }

  /**
   * 修改区域的 SSL 模式
   * 用于自愈：源站已有证书却还是 flexible（回源走明文）时，升级为 full；
   * 反之源站没证书却设了 full/strict 会导致 526，需要降到 flexible。
   * @param {string} zoneId
   * @param {'off'|'flexible'|'full'|'strict'} mode
   */
  async setSslMode(zoneId, mode) {
    if (!zoneId) throw badRequest('zone_id 不能为空');
    const allowed = ['off', 'flexible', 'full', 'strict'];
    if (!allowed.includes(mode)) throw badRequest(`SSL 模式只能是 ${allowed.join(' / ')}`);

    const res = await this.call(`/zones/${zoneId}/settings/ssl`, {
      method: 'PATCH',
      body: { value: mode },
    });
    return { zoneId, sslMode: res.result?.value || mode, changed: true };
  }

  /**
   * 清理边缘缓存
   * 三种模式（按传入参数自动选择）：
   *   · 传 urls → 只清指定 URL
   *   · 传 tags → 按缓存标签清（Enterprise 套餐才有）
   *   · 都不传 → 全量清理
   */
  async purgeCache(zoneId, { urls, tags } = {}) {
    if (!zoneId) throw badRequest('zone_id 不能为空');

    const payload = {};
    if (Array.isArray(urls) && urls.length) payload.files = urls;
    else if (Array.isArray(tags) && tags.length) payload.tags = tags;
    else payload.purge_everything = true;

    const res = await this.call(`/zones/${zoneId}/purge_cache`, { method: 'POST', body: payload });

    return {
      zoneId,
      mode: payload.files ? 'urls' : payload.tags ? 'tags' : 'everything',
      purged: payload.files || payload.tags || '全部',
      message: '缓存清理请求已提交（边缘节点异步生效，通常几秒到几十秒）',
      raw: res.success === false ? res.errors : undefined,
    };
  }

  /** 连通性自检：能列出 zone 即视为 Token 有效 */
  async testConnection() {
    const res = await this.call('/zones', { query: { per_page: 5 } });
    const total = res.result_info?.total_count ?? (res.result || []).length;
    return {
      ok: true,
      message: `连接成功：当前账号下可见 ${total} 个域名区域`,
      zones: (res.result || []).map((z) => z.name),
    };
  }

  /**
   * 兜底：直接调用 Cloudflare API —— **只允许区域级端点**（`/zones...`）
   * ------------------------------------------------------------------
   * 与宝塔的 `call_bt_api` 对应。本工作台只封装了「DNS 解析 / SSL 模式 / 清缓存」，
   * 其余 CF 能力（WAF 规则、Page Rules、缓存规则、Transform Rules、区域设置…）
   * 没封装，得留一个出口 —— 否则「替代 CF 官方 MCP」这句话就会有缺口，
   * 遇到没封装的只能让用户去 CF 面板手工点。
   *
   * ⛔ 三条硬边界：
   *   ① **只允许 `/zones` 或 `/zones/...`** —— 账号级端点（`/accounts`、`/user`、
   *      `/memberships`…）一律拒绝，避免一把 Token 被用来改整个 Cloudflare 账号；
   *   ② 这里对调用方**没有任何额外保护**，删除类操作不可恢复 ——
   *      动线上配置前先用 `GET` 看清现状；
   *   ③ 归「写」工具：只读令牌连它都看不到。
   */
  async callApi(path, { method = 'GET', body, query } = {}) {
    const p = String(path || '').trim();
    if (!/^\/zones(\/|$|\?)/.test(p)) {
      throw badRequest(
        '出于安全，这里只能调用**区域级**端点（路径以 /zones 开头，如 /zones/{zone_id}/settings/ssl）。' +
          '账号级端点（/accounts、/user、/memberships…）不允许 —— 那会影响整个 Cloudflare 账号。'
      );
    }
    const m = String(method || 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) {
      throw badRequest(`不支持的 method：${method}（可用 GET / POST / PUT / PATCH / DELETE）`);
    }

    const res = await this.call(p, {
      method: m,
      query,
      // GET / DELETE 不带 body：CF 部分端点对多余 body 会直接报错
      body: m === 'GET' || m === 'DELETE' ? undefined : body,
      timeout: 30000,
    });

    return {
      method: m,
      path: p,
      result: res.result,
      resultInfo: res.result_info || null,
      messages: (res.messages || []).filter(Boolean),
    };
  }
}

/** 工厂：从系统配置读取 Token 并创建客户端 */
function createClient() {
  const cfg = settings.getCloudflareConfig();
  return new CloudflareClient(cfg);
}

/**
 * 取 DNS 记录里「会被改动」的那几个字段
 * 用于返回体与 B6 审计 diff 的 before / after（只挑有意义的字段，别把整个 API 响应塞进日志）
 */
function recordFields(r) {
  const src = r || {};
  return {
    type: src.type,
    name: src.name,
    content: src.content,
    proxied: !!src.proxied,
  };
}

module.exports = { CloudflareClient, createClient, recordFields, API_BASE };
