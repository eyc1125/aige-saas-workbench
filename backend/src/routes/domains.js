/**
 * 域名管理路由（对接 Cloudflare）
 * ------------------------------------------------------------------
 * GET    /api/domains/zones                        所有域名区域
 * GET    /api/domains/zones/:zoneId/records        DNS 解析记录
 * POST   /api/domains/zones/:zoneId/records        新增解析
 * PUT    /api/domains/zones/:zoneId/records/:id    修改解析 / 切换代理
 * DELETE /api/domains/zones/:zoneId/records/:id    删除解析
 * POST   /api/domains/quick-add                    按完整域名一键添加（自动定位 zone）
 *
 * quick-add 是给 AI（MCP）与快捷操作准备的：调用方只需要给域名和值，
 * 不用先查 zone_id、不用先看列表，最贴合「帮我加一个 test.xxx.com」这种指令。
 */
'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const { badRequest } = require('../utils/errors');
const { writeLog, clientIp } = require('../utils/logger');
const cloudflareService = require('../services/cloudflare');
// recordFields 用来给审计日志构造「改成了什么」（与 service 返回的 before 字段对齐）
const { recordFields } = cloudflareService;

const router = express.Router();

/** Cloudflare 支持的记录类型（MVP 允许的集合） */
const ALLOWED_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA'];

/** 获取所有 zone */
router.get(
  '/zones',
  asyncHandler(async (_req, res) => {
    const cf = cloudflareService.createClient();
    const zones = await cf.listZones();
    return success(res, { list: zones, total: zones.length });
  })
);

/** 获取 DNS 记录 */
router.get(
  '/zones/:zoneId/records',
  asyncHandler(async (req, res) => {
    const cf = cloudflareService.createClient();
    const records = await cf.listDnsRecords(req.params.zoneId, {
      type: String(req.query.type || '').toUpperCase(),
      search: String(req.query.search || '').trim(),
    });
    return success(res, { list: records, total: records.length });
  })
);

/** 新增 DNS 记录 */
router.post(
  '/zones/:zoneId/records',
  asyncHandler(async (req, res) => {
    const { type, name, content, proxied = true, ttl, priority, comment } = req.body || {};
    const recordType = String(type || '').toUpperCase();
    if (!ALLOWED_TYPES.includes(recordType)) {
      throw badRequest(`记录类型不支持：${type}。可用类型：${ALLOWED_TYPES.join(' / ')}`);
    }

    const cf = cloudflareService.createClient();
    const record = await cf.createDnsRecord(req.params.zoneId, {
      type: recordType,
      name,
      content,
      proxied,
      ttl,
      priority,
      comment,
    });

    writeLog({
      userId: req.user.id,
      username: req.user.username,
      module: 'domain',
      action: 'add_dns_record',
      target: record.name,
      source: 'web',
      status: 'success',
      detail: record,
      ip: clientIp(req),
    });

    return success(res, record, `解析已添加：${record.name} → ${record.content}`);
  })
);

/** 修改 DNS 记录（含代理开关切换） */
router.put(
  '/zones/:zoneId/records/:recordId',
  asyncHandler(async (req, res) => {
    const { type, name, content, proxied, ttl, priority } = req.body || {};
    const cf = cloudflareService.createClient();
    const patch = {};
    if (type !== undefined) patch.type = String(type).toUpperCase();
    if (name !== undefined) patch.name = name;
    if (content !== undefined) patch.content = content;
    if (proxied !== undefined) patch.proxied = !!proxied;
    if (ttl !== undefined) patch.ttl = ttl;
    if (priority !== undefined) patch.priority = priority;

    const record = await cf.updateDnsRecord(req.params.zoneId, req.params.recordId, patch);

    writeLog({
      userId: req.user.id,
      username: req.user.username,
      module: 'domain',
      action: proxied !== undefined ? 'toggle_dns_proxy' : 'update_dns_record',
      target: record.name,
      source: 'web',
      status: 'success',
      detail: { patch },
      // B6 审计：记录这条解析改成了什么（before 由 service 返回，本次更新本来就读过原记录）
      before: record.before,
      after: recordFields(record),
      ip: clientIp(req),
    });

    return success(res, record, '解析已更新');
  })
);

/** 删除 DNS 记录 */
router.delete(
  '/zones/:zoneId/records/:recordId',
  asyncHandler(async (req, res) => {
    const cf = cloudflareService.createClient();
    const result = await cf.deleteDnsRecord(req.params.zoneId, req.params.recordId);

    writeLog({
      userId: req.user.id,
      username: req.user.username,
      module: 'domain',
      action: 'delete_dns_record',
      target: req.params.recordId,
      source: 'web',
      status: 'success',
      detail: result,
      ip: clientIp(req),
    });

    return success(res, result, '解析已删除');
  })
);

/**
 * 快捷添加解析：只给域名 + 值，自动定位 zone
 * body: { domain: 'test.example.com', type: 'A', content: '1.2.3.4', proxied: true }
 * 若 domain 为空，则自动使用 zone 名（即添加主域名记录）
 */
router.post(
  '/quick-add',
  asyncHandler(async (req, res) => {
    const { domain, type = 'A', content, proxied = true, ttl, priority, comment } = req.body || {};
    const recordType = String(type).toUpperCase();
    if (!ALLOWED_TYPES.includes(recordType)) {
      throw badRequest(`记录类型不支持：${type}。可用类型：${ALLOWED_TYPES.join(' / ')}`);
    }
    if (!domain) throw badRequest('domain 不能为空');

    const cf = cloudflareService.createClient();
    const zone = await cf.findZoneByDomain(domain);
    const name = String(domain).trim().toLowerCase();

    const { record, created } = await cf.ensureDnsRecord(zone.id, {
      type: recordType,
      name,
      content,
      proxied,
      ttl,
      priority,
      comment: comment || '艾哥SaaS工作台添加',
    });

    writeLog({
      userId: req.user.id,
      username: req.user.username,
      module: 'domain',
      action: created ? 'add_dns_record' : 'reuse_dns_record',
      target: name,
      source: 'web',
      status: 'success',
      detail: record,
      ip: clientIp(req),
    });

    return success(
      res,
      { zoneId: zone.id, zoneName: zone.name, created, record },
      created
        ? `解析已添加：${record.name} → ${record.content}`
        : `解析已存在，直接复用：${record.name} → ${record.content}`
    );
  })
);

module.exports = router;
