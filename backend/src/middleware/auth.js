/**
 * 鉴权中间件（JWT）
 * ------------------------------------------------------------------
 * - /api/auth/login 等白名单接口不校验
 * - 其余接口必须带 Authorization: Bearer <token>
 * - 令牌解析出的用户信息挂到 req.user，供后续业务与日志使用
 * - requireAuth / optionalAuth 两种强度：前者强制，后者有则解析无则放行
 */
'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const { unauthorized } = require('../utils/errors');

/** 生成令牌 */
function signToken(user) {
  return jwt.sign({ uid: user.id, username: user.username, role: user.role }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

/** 从请求头里取出令牌 */
function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  // 兼容 SSE / EventSource 场景：允许用 query 传 token
  if (req.query && req.query.token) return String(req.query.token);
  return null;
}

/** 解析令牌，失败返回 null（不抛错） */
function parseToken(req) {
  const token = extractToken(req);
  if (!token) return null;
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

/** 有令牌就解析，没有也放行 */
function optionalAuth(req, _res, next) {
  const payload = parseToken(req);
  if (payload) {
    req.user = { id: payload.uid, username: payload.username, role: payload.role };
  }
  next();
}

/** 必须登录 */
function requireAuth(req, _res, next) {
  const payload = parseToken(req);
  if (!payload) return next(unauthorized());
  req.user = { id: payload.uid, username: payload.username, role: payload.role };
  next();
}

/** 必须是管理员角色（预留只读角色扩展） */
function requireAdmin(req, _res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== 'admin') {
    const { forbidden } = require('../utils/errors');
    return next(forbidden('仅管理员可执行该操作'));
  }
  next();
}

module.exports = { signToken, requireAuth, optionalAuth, requireAdmin, parseToken, extractToken };
