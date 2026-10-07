/**
 * 登录鉴权路由
 * ------------------------------------------------------------------
 * POST /api/auth/login     登录换取 JWT
 * GET  /api/auth/profile   获取当前登录信息
 * PUT  /api/auth/password  修改自己的密码
 * POST /api/auth/logout    退出（前端丢弃令牌即可，这里只做日志）
 */
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken } = require('../middleware/auth');
const { requireAuth } = require('../middleware/auth');
const { loginLimiter } = require('../middleware/rateLimit');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const { badRequest, unauthorized } = require('../utils/errors');
const { writeLog, clientIp } = require('../utils/logger');

const router = express.Router();

const findUser = db.prepare('SELECT * FROM users WHERE username = ?');
const touchLogin = db.prepare("UPDATE users SET last_login_at = datetime('now','localtime') WHERE id = ?");
const findById = db.prepare('SELECT id, username, nickname, role, last_login_at, created_at FROM users WHERE id = ?');
const updatePassword = db.prepare("UPDATE users SET password = ?, updated_at = datetime('now','localtime') WHERE id = ?");

/** 用户信息脱敏输出 */
const publicUser = (u) => ({
  id: u.id,
  username: u.username,
  nickname: u.nickname || u.username,
  role: u.role,
  lastLoginAt: u.last_login_at || null,
  createdAt: u.created_at || null,
});

/** 登录 */
router.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) throw badRequest('请输入用户名和密码');

    const user = findUser.get(String(username).trim());
    const ip = clientIp(req);

    // 用户不存在与密码错误返回同一提示，避免被用来枚举账号
    if (!user || !bcrypt.compareSync(String(password), user.password)) {
      writeLog({
        module: 'auth',
        action: 'login',
        target: String(username),
        source: 'web',
        status: 'failed',
        message: '用户名或密码错误',
        ip,
      });
      throw unauthorized('用户名或密码错误');
    }

    touchLogin.run(user.id);
    const token = signToken(user);

    writeLog({
      userId: user.id,
      username: user.username,
      module: 'auth',
      action: 'login',
      target: user.username,
      source: 'web',
      status: 'success',
      message: '登录成功',
      ip,
    });

    return success(res, { token, user: publicUser({ ...user, last_login_at: new Date().toLocaleString('zh-CN') }) }, '登录成功');
  })
);

/** 当前登录信息 */
router.get(
  '/profile',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = findById.get(req.user.id);
    if (!user) throw unauthorized('账号不存在或已被删除');
    return success(res, publicUser(user));
  })
);

/** 修改自己的密码 */
router.put(
  '/password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) throw badRequest('原密码与新密码均为必填');
    if (String(newPassword).length < 6) throw badRequest('新密码至少 6 位');

    const user = findUser.get(req.user.username);
    if (!user || !bcrypt.compareSync(String(oldPassword), user.password)) {
      throw badRequest('原密码不正确');
    }

    updatePassword.run(bcrypt.hashSync(String(newPassword), 10), user.id);

    writeLog({
      userId: user.id,
      username: user.username,
      module: 'auth',
      action: 'change_password',
      source: 'web',
      status: 'success',
      ip: clientIp(req),
    });

    return success(res, { changed: true }, '密码已更新，请使用新密码重新登录');
  })
);

/** 退出登录（JWT 无状态，服务端仅记录日志） */
router.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    writeLog({
      userId: req.user.id,
      username: req.user.username,
      module: 'auth',
      action: 'logout',
      source: 'web',
      status: 'success',
      ip: clientIp(req),
    });
    return success(res, { loggedOut: true }, '已退出登录');
  })
);

module.exports = router;
