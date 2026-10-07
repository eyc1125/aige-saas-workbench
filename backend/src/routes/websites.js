/**
 * 网站管理路由（对接宝塔）
 * ------------------------------------------------------------------
 * GET    /api/websites                     网站列表（支持搜索、分页）
 * GET    /api/websites/ssl-certs           SSL 证书台账（含到期倒计时）
 * POST   /api/websites/ssl-certs/renew     批量续签即将到期的证书
 * GET    /api/websites/:name               单个网站详情
 * GET    /api/websites/:name/logs          站点访问 / 错误日志（尾部 N 行）
 * GET    /api/websites/:name/nginx-config  站点 Nginx 配置
 * POST   /api/websites                     一键新建静态网站
 * DELETE /api/websites/:name               删除网站（二次确认在前端做）
 * POST   /api/websites/:name/ssl           为网站申请 / 部署 SSL 证书
 *
 * 安全：所有写操作前先查重（站点是否已存在），删除只删站点与目录，不动数据库与 FTP。
 * 路由顺序：静态段（ssl-certs）必须排在 /:name 之前，否则会被当成站点名匹配。
 */
'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { success, paginated } = require('../utils/response');
const { badRequest, notFound } = require('../utils/errors');
const { writeLog, clientIp } = require('../utils/logger');
const baotaService = require('../services/baota');

const router = express.Router();

/** 校验域名格式（允许通配符 * 前缀，方便泛解析站点） */
function assertDomain(domain) {
  const clean = String(domain || '').trim().toLowerCase();
  if (!clean) throw badRequest('域名不能为空');
  const ok = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(clean);
  if (!ok) throw badRequest(`域名格式不正确：${domain}`);
  return clean;
}

/** 网站列表 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 200);
    const search = String(req.query.search || '').trim();

    const baota = baotaService.createClient();
    const { list, total } = await baota.getSiteList({ page, limit, search });

    // 宝塔接口的搜索是服务端做的；这里再兜一层本地过滤，保证搜索体验
    const filtered = search
      ? list.filter((s) => s.name.includes(search) || s.domain.includes(search) || s.ps.includes(search))
      : list;

    return paginated(res, filtered, search ? filtered.length : total, page, limit);
  })
);

/**
 * SSL 证书台账
 * ------------------------------------------------------------------
 * 把每个站点的证书剩余天数一次算好，供「证书倒计时」展示。
 * 口径与宝塔面板一致：剩余 ≤ 15 天 = 即将到期，已过有效期 = 已过期。
 * 只做只读探测，不触发任何签发动作。
 */
router.get(
  '/ssl-certs',
  asyncHandler(async (_req, res) => {
    const baota = baotaService.createClient();
    const data = await baota.listSslCerts();

    // 按紧急程度排序：已过期 → 即将到期 → 正常 → 无证书
    const weight = { expired: 0, expiring: 1, ok: 2 };
    data.certs.sort((a, b) => {
      const wa = a.hasCert ? weight[a.status] ?? 2 : 3;
      const wb = b.hasCert ? weight[b.status] ?? 2 : 3;
      if (wa !== wb) return wa - wb;
      return (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999);
    });

    return success(res, data);
  })
);

/**
 * 批量续签即将到期的证书
 * body: { sites: string[] }  站点名数组，最多 10 个（逐个串行签发，避免把面板打满）
 * 只对「即将到期 / 已过期」的证书有意义；逐个执行并返回每站结果，单个失败不影响其余。
 */
router.post(
  '/ssl-certs/renew',
  asyncHandler(async (req, res) => {
    const sites = Array.isArray(req.body?.sites) ? req.body.sites.map((s) => String(s).trim()).filter(Boolean) : [];
    if (!sites.length) throw badRequest('请提供要续签的站点列表');
    if (sites.length > 10) throw badRequest('一次最多续签 10 个站点，请分批执行');

    const baota = baotaService.createClient();
    const results = [];

    for (const siteName of sites) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await baota.applyLetsEncrypt({ siteName });
        results.push({ siteName, ok: true, message: r.message || '证书已重新签发' });
      } catch (err) {
        results.push({ siteName, ok: false, message: err.message });
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    writeLog({
      userId: req.user.id,
      username: req.user.username,
      module: 'website',
      action: 'renew_ssl',
      target: sites.join(', '),
      source: 'web',
      status: okCount === results.length ? 'success' : 'failed',
      detail: results,
      message: `续签 ${okCount}/${results.length} 成功`,
      ip: clientIp(req),
    });

    return success(
      res,
      { results, okCount, total: results.length },
      `续签完成：成功 ${okCount} 个，失败 ${results.length - okCount} 个`
    );
  })
);

/** 单个网站详情 */
router.get(
  '/:name',
  asyncHandler(async (req, res) => {
    const baota = baotaService.createClient();
    const site = await baota.getSite(decodeURIComponent(req.params.name));
    if (!site) throw notFound(`未找到网站：${req.params.name}`);
    return success(res, site);
  })
);

/** 站点日志（访问 / 错误），只取尾部 N 行，避免把大日志整读进内存 */
router.get(
  '/:name/logs',
  asyncHandler(async (req, res) => {
    const siteName = decodeURIComponent(req.params.name);
    const type = req.query.type === 'error' ? 'error' : 'access';
    const lines = Math.min(Math.max(Number(req.query.lines) || 200, 10), 1000);

    const baota = baotaService.createClient();
    const data = await baota.getSiteLogs(siteName, { type, lines });
    return success(res, data);
  })
);

/** 站点 Nginx 配置（只读展示，改配置请走 MCP 的 save_nginx_config） */
router.get(
  '/:name/nginx-config',
  asyncHandler(async (req, res) => {
    const siteName = decodeURIComponent(req.params.name);
    const baota = baotaService.createClient();
    const data = await baota.getNginxConfig(siteName);
    return success(res, data);
  })
);

/** 新建静态网站 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { domain, path: sitePath, ps } = req.body || {};
    const clean = assertDomain(domain);

    const baota = baotaService.createClient();

    // 查重：同名站点已存在则直接拦下，避免覆盖（项目查重规则）
    const exists = await baota.siteExists(clean);
    if (exists) {
      throw badRequest(`网站已存在：${clean}。请勿重复创建，如需修改请到宝塔面板操作。`);
    }

    const result = await baota.addSite({ domain: clean, path: sitePath, ps });

    writeLog({
      userId: req.user.id,
      username: req.user.username,
      module: 'website',
      action: 'create_website',
      target: clean,
      source: 'web',
      status: 'success',
      detail: result,
      ip: clientIp(req),
    });

    return success(res, result, `网站创建成功：${clean}`);
  })
);

/** 删除网站 */
router.delete(
  '/:name',
  asyncHandler(async (req, res) => {
    const name = decodeURIComponent(req.params.name);
    const baota = baotaService.createClient();
    const result = await baota.deleteSite(name);

    writeLog({
      userId: req.user.id,
      username: req.user.username,
      module: 'website',
      action: 'delete_website',
      target: name,
      source: 'web',
      status: 'success',
      detail: result,
      ip: clientIp(req),
    });

    return success(res, result, `网站已删除：${name}`);
  })
);

/**
 * 申请 / 部署 SSL 证书
 * body: { mode: 'letsencrypt' | 'manual', key?, cert?, domains? }
 *   letsencrypt —— 调用宝塔自动申请 Let's Encrypt 免费证书
 *   manual      —— 使用传入的证书内容部署（用户自有证书）
 */
router.post(
  '/:name/ssl',
  asyncHandler(async (req, res) => {
    const siteName = decodeURIComponent(req.params.name);
    const { mode = 'letsencrypt', key, cert, domains } = req.body || {};

    const baota = baotaService.createClient();
    const site = await baota.getSite(siteName);
    if (!site) throw notFound(`未找到网站：${siteName}`);

    let result;
    if (mode === 'manual') {
      if (!key || !cert) throw badRequest('手动部署证书时，证书内容与私钥均为必填');
      result = await baota.setSsl({
        siteName,
        key,
        cert,
        domains: Array.isArray(domains) ? domains : site.domains,
      });
    } else {
      const domainList = Array.isArray(domains) && domains.length ? domains : (site.domains.length ? site.domains : [siteName]);
      result = await baota.applyLetsEncrypt({ siteName, domains: domainList });
    }

    writeLog({
      userId: req.user.id,
      username: req.user.username,
      module: 'website',
      action: 'apply_ssl',
      target: siteName,
      source: 'web',
      status: 'success',
      detail: { mode, result },
      ip: clientIp(req),
    });

    return success(
      res,
      { mode, ...result },
      mode === 'manual' ? '证书已部署' : '证书申请已提交，签发通常需要 10-60 秒'
    );
  })
);

module.exports = router;
