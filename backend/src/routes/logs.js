/**
 * 操作日志路由
 * ------------------------------------------------------------------
 * GET /api/logs  分页查询操作日志（支持模块 / 状态 / 来源 / 关键词过滤）
 */
'use strict';

const express = require('express');
const db = require('../db');
const asyncHandler = require('../utils/asyncHandler');
const { paginated } = require('../utils/response');
// before_value / after_value 存的是 JSON 字符串，统一在查询侧还原成对象再给前端
const { parseAuditFields } = require('../utils/logger');

const router = express.Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const pageSize = Math.min(Math.max(Number(req.query.limit) || 20, 1), 200);
    const offset = (page - 1) * pageSize;
    const moduleName = String(req.query.module || '').trim();
    const status = String(req.query.status || '').trim();
    const source = String(req.query.source || '').trim();
    const keyword = String(req.query.keyword || '').trim();

    const where = [];
    const params = {};
    if (moduleName) {
      where.push('module = @module');
      params.module = moduleName;
    }
    if (status) {
      where.push('status = @status');
      params.status = status;
    }
    if (source) {
      where.push('source = @source');
      params.source = source;
    }
    if (keyword) {
      where.push('(target LIKE @kw OR action LIKE @kw OR message LIKE @kw OR username LIKE @kw)');
      params.kw = `%${keyword}%`;
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db
      .prepare(`SELECT COUNT(*) AS count FROM operation_logs ${whereSql}`)
      .get(params).count;
    const list = db
      .prepare(
        `SELECT id, username, module, action, target, detail, before_value, after_value,
                source, status, message, ip, duration_ms, created_at
         FROM operation_logs ${whereSql}
         ORDER BY id DESC LIMIT @limit OFFSET @offset`
      )
      .all({ ...params, limit: pageSize, offset })
      .map(parseAuditFields);

    return paginated(res, list, total, page, pageSize);
  })
);

module.exports = router;
