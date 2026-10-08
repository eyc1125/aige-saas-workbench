/**
 * 路由汇总
 * ------------------------------------------------------------------
 * 除 /api/health 与 /api/auth/* 外，其余接口一律要求登录。
 * 所有接口统一挂在 /api 前缀下。
 *
 * 权限（B5）：除登录外，每个模块都挂 `requirePermission` ——
 * 它按「模块路径 + 请求方法」在 middleware/permissions.js 的规则表里查最低角色。
 * ⛔ 不要在各自的路由文件里手写角色判断：那样一定会有漏的，
 *    而漏掉的那个接口就是「所有人都能全权操作」。
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const db = require('../db');

const router = express.Router();

/** 健康检查（供 Docker healthcheck 与宝塔探活使用，无需登录） */
router.get('/health', (_req, res) => {
  let dbOk = true;
  try {
    db.prepare('SELECT 1').get();
  } catch {
    dbOk = false;
  }
  res.json({
    code: dbOk ? 0 : 1,
    message: dbOk ? 'ok' : 'database unavailable',
    data: {
      status: dbOk ? 'healthy' : 'degraded',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    },
  });
});

// 登录相关（内部自行控制鉴权强度：login 公开，profile/password/logout 要登录）
router.use('/auth', require('./auth'));

// 以下全部需要登录 + 角色校验
router.use('/dashboard', requireAuth, requirePermission, require('./dashboard'));
router.use('/websites', requireAuth, requirePermission, require('./websites'));
router.use('/inspect', requireAuth, requirePermission, require('./inspect'));
router.use('/alerts', requireAuth, requirePermission, require('./alerts'));
router.use('/domains', requireAuth, requirePermission, require('./domains'));
router.use('/docker', requireAuth, requirePermission, require('./docker'));
router.use('/apps', requireAuth, requirePermission, require('./apps'));
router.use('/settings', requireAuth, requirePermission, require('./settings'));
router.use('/logs', requireAuth, requirePermission, require('./logs'));
router.use('/users', requireAuth, requirePermission, require('./users'));

module.exports = router;
