/**
 * 登录鉴权路由
 * ------------------------------------------------------------------
 * POST /api/auth/login         登录换取 JWT（启用二次验证时只返回临时票据）
 * POST /api/auth/login/totp    二次验证：票据 + 6 位码（或恢复码）换正式令牌
 * GET  /api/auth/profile       获取当前登录信息
 * PUT  /api/auth/password      修改自己的密码
 * POST /api/auth/logout        退出（前端丢弃令牌即可，这里只做日志）
 *
 * 二次验证（D1）：
 * GET  /api/auth/totp          查当前绑定状态
 * POST /api/auth/totp/setup    生成密钥与恢复码（**还没启用**）
 * POST /api/auth/totp/enable   用一次验证码确认绑定 → 正式启用
 * POST /api/auth/totp/disable  关闭（要密码 + 验证码）
 * POST /api/auth/totp/recovery 重新生成恢复码（要验证码）
 */
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken, signTotpTicket, verifyTotpTicket } = require('../middleware/auth');
const { requireAuth } = require('../middleware/auth');
const { loginLimiter } = require('../middleware/rateLimit');
const { encrypt, decrypt } = require('../utils/crypto');
const totpUtil = require('../utils/totp');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const { badRequest, unauthorized } = require('../utils/errors');
const { writeLog, clientIp } = require('../utils/logger');

const router = express.Router();

const findUser = db.prepare('SELECT * FROM users WHERE username = ?');
const touchLogin = db.prepare(
  "UPDATE users SET last_login_at = datetime('now','localtime') WHERE id = ?"
);
const findById = db.prepare(
  'SELECT id, username, nickname, role, last_login_at, created_at FROM users WHERE id = ?'
);
const updatePassword = db.prepare(
  "UPDATE users SET password = ?, updated_at = datetime('now','localtime') WHERE id = ?"
);
/** 当前登录用户的二次验证字段（setup / enable / recovery 都要读它） */
const findSelf = db.prepare(
  'SELECT id, username, password, totp_secret, totp_enabled, totp_recovery, totp_bound_at FROM users WHERE id = ?'
);
const saveTotpSecret = db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?');
const enableTotp = db.prepare(
  "UPDATE users SET totp_enabled = 1, totp_recovery = ?, totp_bound_at = datetime('now','localtime') WHERE id = ?"
);
const disableTotp = db.prepare(
  'UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_recovery = NULL, totp_bound_at = NULL WHERE id = ?'
);
const saveRecovery = db.prepare('UPDATE users SET totp_recovery = ? WHERE id = ?');

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

    // ⛔ 密码对了但启用了二次验证：**不发正式令牌**，只给一张 5 分钟的临时票据。
    //    票据只能用来提交验证码（见 middleware/auth.js 的 scope 检查），
    //    拿到它不等于登录成功 —— 否则二次验证就白做了。
    if (user.totp_enabled) {
      writeLog({
        userId: user.id,
        username: user.username,
        module: 'auth',
        action: 'login',
        target: user.username,
        source: 'web',
        status: 'success',
        message: '密码校验通过，等待二次验证',
        ip,
      });
      return success(
        res,
        { needTotp: true, ticket: signTotpTicket(user) },
        '请输入验证器 App 上的 6 位验证码'
      );
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

    return success(
      res,
      { token, user: publicUser({ ...user, last_login_at: new Date().toLocaleString('zh-CN') }) },
      '登录成功'
    );
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

// ============================================================
// 登录二次验证（TOTP · D1）
// ============================================================

/** 读某用户的恢复码 hash 列表（脏数据当空处理，别让人因为一条坏记录彻底进不来） */
function recoveryList(user) {
  if (!user?.totp_recovery) return [];
  try {
    const list = JSON.parse(user.totp_recovery);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * 校验 6 位码或恢复码
 * 命中恢复码时顺手把它消费掉 —— 恢复码是**一次性**的。
 */
function checkCode(user, { code, recovery }) {
  if (recovery) {
    const hash = totpUtil.hashRecoveryCode(recovery);
    const list = recoveryList(user);
    if (!list.includes(hash)) return { ok: false, reason: 'recovery' };
    saveRecovery.run(JSON.stringify(list.filter((h) => h !== hash)), user.id);
    return { ok: true, viaRecovery: true };
  }

  const secret = user.totp_secret ? decrypt(user.totp_secret) : '';
  if (!secret) return { ok: false, reason: 'nobind' };
  return totpUtil.verify(secret, code)
    ? { ok: true, viaRecovery: false }
    : { ok: false, reason: 'code' };
}

/** 二次验证：用「密码换来的临时票据 + 验证码」换正式登录令牌 */
router.post(
  '/login/totp',
  // 复用登录限流：这里同样是在猜凭据（只是猜的是验证码/恢复码）
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { ticket, code, recovery } = req.body || {};
    const payload = verifyTotpTicket(ticket);
    if (!payload) throw unauthorized('验证已超时，请重新登录');

    const user = findUser.get(payload.username);
    if (!user || !user.totp_enabled) throw unauthorized('该账号未启用二次验证');

    const ip = clientIp(req);
    const hit = checkCode(user, { code, recovery });

    if (!hit.ok) {
      writeLog({
        userId: user.id,
        username: user.username,
        module: 'auth',
        action: 'login_totp',
        target: user.username,
        source: 'web',
        status: 'failed',
        message: recovery ? '恢复码无效或已被使用' : '验证码不正确',
        ip,
      });
      throw unauthorized(
        hit.reason === 'recovery'
          ? '恢复码无效或已被使用（每个恢复码只能用一次）'
          : '验证码不正确（验证器里的码每 30 秒换一次，请核对手机时间）'
      );
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
      message: hit.viaRecovery ? '使用恢复码登录' : '登录成功（二次验证通过）',
      ip,
    });

    return success(
      res,
      {
        token,
        user: publicUser({ ...user, last_login_at: new Date().toLocaleString('zh-CN') }),
        viaRecovery: hit.viaRecovery,
      },
      hit.viaRecovery ? '已用恢复码登录，该码已作废 —— 建议尽快重新获取恢复码' : '登录成功'
    );
  })
);

/** 查当前账号的二次验证状态 */
router.get(
  '/totp',
  requireAuth,
  asyncHandler(async (req, res) => {
    const me = findSelf.get(req.user.id);
    return success(res, {
      enabled: !!me.totp_enabled,
      boundAt: me.totp_bound_at || null,
      recoveryLeft: recoveryList(me).length,
    });
  })
);

/**
 * 开始绑定：生成密钥 + 恢复码（**此时还没有启用**）
 * ------------------------------------------------------------------
 * ⚠️ 顺序很重要：**先把恢复码交给用户，再让他输码启用**。
 *    反过来的话，用户一旦手机丢了/卸载了验证器，就彻底进不了面板，
 *    只能去服务器上改数据库 —— 这正是这类功能最容易造成的自锁。
 */
router.post(
  '/totp/setup',
  requireAuth,
  asyncHandler(async (req, res) => {
    const me = findSelf.get(req.user.id);
    if (me.totp_enabled) throw badRequest('二次验证已启用；换设备请先关闭它再重新绑定');

    const secret = totpUtil.generateSecret();
    const codes = totpUtil.generateRecoveryCodes();

    saveTotpSecret.run(encrypt(secret), me.id);
    saveRecovery.run(JSON.stringify(codes.map(totpUtil.hashRecoveryCode)), me.id);

    writeLog({
      userId: me.id,
      username: me.username,
      module: 'auth',
      action: 'totp_setup',
      source: 'web',
      status: 'success',
      message: '生成二次验证密钥（尚未启用）',
      ip: clientIp(req),
    });

    return success(
      res,
      {
        secret,
        secretText: totpUtil.formatSecret(secret),
        otpauthUrl: totpUtil.otpauthUrl({ secret, account: me.username }),
        recoveryCodes: codes,
      },
      '请用验证器 App 扫码，并把恢复码抄到安全的地方'
    );
  })
);

/** 用一次验证码确认绑定 → 正式启用 */
router.post(
  '/totp/enable',
  requireAuth,
  asyncHandler(async (req, res) => {
    const me = findSelf.get(req.user.id);
    if (me.totp_enabled) throw badRequest('二次验证已经是启用状态');
    if (!me.totp_secret) throw badRequest('请先点「开始绑定」获取密钥');

    if (!totpUtil.verify(decrypt(me.totp_secret), req.body?.code)) {
      writeLog({
        userId: me.id,
        username: me.username,
        module: 'auth',
        action: 'totp_enable',
        source: 'web',
        status: 'failed',
        message: '验证码不正确，未启用',
        ip: clientIp(req),
      });
      throw badRequest('验证码不正确（请确认手机时间准确，验证器里的码每 30 秒更新）');
    }

    // 保留 setup 时已经生成的恢复码（用户已经抄走了）
    enableTotp.run(me.totp_recovery, me.id);

    writeLog({
      userId: me.id,
      username: me.username,
      module: 'auth',
      action: 'totp_enable',
      source: 'web',
      status: 'success',
      message: '已启用登录二次验证',
      ip: clientIp(req),
    });

    return success(res, { enabled: true }, '已启用二次验证，下次登录需要验证码');
  })
);

/** 关闭二次验证：必须同时给密码 + 验证码（防止会话被盗后一键关掉） */
router.post(
  '/totp/disable',
  requireAuth,
  asyncHandler(async (req, res) => {
    const me = findSelf.get(req.user.id);
    if (!me.totp_enabled) throw badRequest('二次验证当前未启用');

    const { password, code } = req.body || {};
    if (!password || !bcrypt.compareSync(String(password), me.password)) {
      throw badRequest('密码不正确');
    }
    if (!totpUtil.verify(decrypt(me.totp_secret), code)) {
      throw badRequest('验证码不正确');
    }

    disableTotp.run(me.id);

    writeLog({
      userId: me.id,
      username: me.username,
      module: 'auth',
      action: 'totp_disable',
      source: 'web',
      status: 'success',
      message: '已关闭登录二次验证',
      ip: clientIp(req),
    });

    return success(res, { enabled: false }, '已关闭二次验证，登录将只校验密码');
  })
);

/** 重新生成恢复码（旧的立即全部作废） */
router.post(
  '/totp/recovery',
  requireAuth,
  asyncHandler(async (req, res) => {
    const me = findSelf.get(req.user.id);
    if (!me.totp_enabled) throw badRequest('请先启用二次验证');

    if (!totpUtil.verify(decrypt(me.totp_secret), req.body?.code)) {
      throw badRequest('验证码不正确');
    }

    const codes = totpUtil.generateRecoveryCodes();
    saveRecovery.run(JSON.stringify(codes.map(totpUtil.hashRecoveryCode)), me.id);

    writeLog({
      userId: me.id,
      username: me.username,
      module: 'auth',
      action: 'totp_recovery',
      source: 'web',
      status: 'success',
      message: '重新生成了恢复码（旧的作废）',
      ip: clientIp(req),
    });

    return success(res, { recoveryCodes: codes }, '新的恢复码已生成，旧的全部作废');
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
