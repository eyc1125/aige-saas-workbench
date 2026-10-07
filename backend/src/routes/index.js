/**
 * 路由汇总
 * ------------------------------------------------------------------
 * 除 /api/health 与 /api/auth/* 外，其余接口一律要求登录。
 * 所有接口统一挂在 /api 前缀下。
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
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

// 登录相关（内部自行控制鉴权强度）
router.use('/auth', require('./auth'));

// 以下全部需要登录
router.use('/dashboard', requireAuth, require('./dashboard'));
router.use('/websites', requireAuth, require('./websites'));
router.use('/inspect', requireAuth, require('./inspect'));
router.use('/alerts', requireAuth, require('./alerts'));
router.use('/domains', requireAuth, require('./domains'));
router.use('/docker', requireAuth, require('./docker'));
router.use('/apps', requireAuth, require('./apps'));
router.use('/settings', requireAuth, require('./settings'));
router.use('/logs', requireAuth, require('./logs'));

module.exports = router;
