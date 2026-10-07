/**
 * 请求频率限制
 * ------------------------------------------------------------------
 * 两档：
 *   generalLimiter —— 全站接口的兜底限流，防脚本刷接口
 *   loginLimiter   —— 登录接口单独更严格，防密码爆破
 */
'use strict';

const rateLimit = require('express-rate-limit');
const config = require('../config');

const message = (msg) => ({
  code: 'RATE_LIMITED',
  message: msg,
  data: null,
});

/** 全站限流 */
const generalLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  // 健康检查与静态资源不计入
  skip: (req) => req.path === '/api/health',
  handler: (_req, res) => res.status(429).json(message('请求过于频繁，请稍后再试')),
});

/** 登录限流（只统计失败尝试，避免正常登录被误限） */
const loginLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.loginMax,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (_req, res) => res.status(429).json(message('登录尝试次数过多，请 15 分钟后再试')),
});

module.exports = { generalLimiter, loginLimiter };
