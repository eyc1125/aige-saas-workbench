/**
 * 鉴权中间件（JWT）
 * ------------------------------------------------------------------
 * - /api/auth/login 等白名单接口不校验
 * - 其余接口必须带 Authorization: Bearer <token>
 * - 令牌解析出的用户信息挂到 req.user，供后续业务与日志使用
 * - requireAuth / optionalAuth 两种强度：前者强制，后者有则解析无则放行
 *
 * ⛔ 角色（role）**每次都从数据库读**，不使用 JWT 里那一份：
 *    令牌是自包含的，签发时是什么角色，里面就一直是那个角色。
 *    如果信它，把某人降级为只读之后，他手上的旧令牌仍然是管理员，
 *    要一直等到令牌自然过期才生效 ——「以为锁了、其实没锁」比没有权限体系更危险。
 *    多出来的一次 SQLite 查询是本地读、微秒级，不值一提。
 */
'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');
const { unauthorized, forbidden } = require('../utils/errors');
const { allows, ROLE_TEXT } = require('./permissions');

/** 取用户当前角色（鉴权与权限判定的唯一数据来源） */
const getUserRow = db.prepare('SELECT id, username, role FROM users WHERE id = ?');

/**
 * 生成令牌
 * 说明：payload 里只放「是谁」，**不放角色** —— 角色由 requireAuth 每次现查，
 *      免得将来有人顺手用了 payload.role，把上面那条保证悄悄破坏掉。
 */
function signToken(user) {
  return jwt.sign({ uid: user.id, username: user.username }, config.jwtSecret, {
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

/**
 * 解析令牌 → 现查数据库拿最新角色
 * @returns {object|null} { id, username, role }；令牌无效或账号已删除时返回 null
 */
function resolveUser(req) {
  const payload = parseToken(req);
  if (!payload) return null;
  const row = getUserRow.get(payload.uid);
  if (!row) return null; // 账号被删了，旧令牌立即失效
  return { id: row.id, username: row.username, role: row.role };
}

/** 有令牌就解析，没有也放行 */
function optionalAuth(req, _res, next) {
  const user = resolveUser(req);
  if (user) req.user = user;
  next();
}

/** 必须登录 */
function requireAuth(req, _res, next) {
  const user = resolveUser(req);
  if (!user) return next(unauthorized('登录状态已失效，请重新登录'));
  req.user = user;
  next();
}

/**
 * 必须是管理员
 * 说明：常规的角色校验请用 middleware/permissions.js 的 requirePermission（集中规则表），
 *      这个只用于「明确只给管理员、且不适合进规则表」的零散场景。
 */
function requireAdmin(req, _res, next) {
  if (!req.user) return next(unauthorized());
  if (!allows(req.user.role, 'admin')) {
    return next(
      forbidden(
        `该操作需要「${ROLE_TEXT.admin}」权限，当前身份是「${ROLE_TEXT[req.user.role] || '未知身份'}」。`
      )
    );
  }
  next();
}

module.exports = {
  signToken,
  requireAuth,
  optionalAuth,
  requireAdmin,
  parseToken,
  extractToken,
  resolveUser,
};
