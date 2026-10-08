/**
 * 用户与角色管理（B5）
 * ------------------------------------------------------------------
 * GET    /api/users        用户列表
 * POST   /api/users        新建用户（指定角色）
 * PUT    /api/users/:id    改昵称 / 角色 / 密码
 * DELETE /api/users/:id    删除用户
 *
 * 整块只有管理员能用 —— 在 routes/index.js 里由 permissions 规则表
 * `{ path: '/users', min: 'admin' }` 统一判定，这里不再逐个手写角色校验。
 *
 * ⛔ 两条「防把自己锁在门外」的硬约束（改这块前必读）：
 *   1. 不能删除自己、不能把自己降级；
 *   2. 系统里**至少要留一个管理员** —— 删掉/降级最后一个 admin，
 *      就再也没人能进「系统设置」把角色改回来了（只能去服务器上改数据库）。
 */
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const { badRequest, notFound } = require('../utils/errors');
const { writeLog, clientIp } = require('../utils/logger');
const { ROLES, ROLE_TEXT } = require('../middleware/permissions');

const router = express.Router();

const listStmt = db.prepare(
  'SELECT id, username, nickname, role, last_login_at, created_at FROM users ORDER BY id'
);
const byIdStmt = db.prepare('SELECT * FROM users WHERE id = ?');
const byNameStmt = db.prepare('SELECT id FROM users WHERE username = ?');
const adminCountStmt = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'");
const insertStmt = db.prepare(
  'INSERT INTO users (username, password, nickname, role) VALUES (?, ?, ?, ?)'
);
const deleteStmt = db.prepare('DELETE FROM users WHERE id = ?');

/** 对外输出（绝不带 password 哈希） */
const publicUser = (u) => ({
  id: u.id,
  username: u.username,
  nickname: u.nickname || u.username,
  role: u.role,
  roleText: ROLE_TEXT[u.role] || u.role,
  lastLoginAt: u.last_login_at || null,
  createdAt: u.created_at || null,
});

/** 角色合法性 */
function assertRole(role) {
  if (!ROLES.includes(role)) {
    throw badRequest(
      `角色不合法，只能是：${ROLES.map((r) => `${r}（${ROLE_TEXT[r]}）`).join(' / ')}`
    );
  }
  return role;
}

/** 密码强度：与「修改自己密码」保持同一条线 */
function assertPassword(pwd) {
  if (!pwd || String(pwd).length < 6) throw badRequest('密码至少 6 位');
  return String(pwd);
}

/** 用户列表 */
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    return success(res, {
      list: listStmt.all().map(publicUser),
      roles: ROLES.map((r) => ({ value: r, label: ROLE_TEXT[r] })),
    });
  })
);

/** 新建用户 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { username, password, nickname, role } = req.body || {};
    const name = String(username || '').trim();
    if (!name) throw badRequest('用户名不能为空');
    if (name.length < 3) throw badRequest('用户名至少 3 位');
    if (byNameStmt.get(name)) throw badRequest(`用户名「${name}」已存在`);
    assertPassword(password);
    // 不给角色就按最小权限建 —— 宁可事后手动提权，也不要默认造出一个管理员
    const finalRole = assertRole(role || 'viewer');

    insertStmt.run(
      name,
      bcrypt.hashSync(String(password), 10),
      String(nickname || '').trim() || null,
      finalRole
    );
    // 用用户名回查刚建的那条（不依赖驱动返回的 lastInsertRowid —— 两种驱动口径未必一致）
    const created = byIdStmt.get(byNameStmt.get(name).id);

    writeLog({
      userId: req.user.id,
      username: req.user.username,
      module: 'user',
      action: 'create_user',
      target: name,
      source: 'web',
      status: 'success',
      detail: { role: finalRole },
      after: { username: name, role: finalRole },
      ip: clientIp(req),
    });

    return success(res, publicUser(created), `已创建用户「${name}」（${ROLE_TEXT[finalRole]}）`);
  })
);

/** 修改用户（昵称 / 角色 / 密码，只改传了的那些） */
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const user = byIdStmt.get(id);
    if (!user) throw notFound('用户不存在');

    const { nickname, role, password } = req.body || {};
    const sets = [];
    const params = [];
    const before = {};
    const after = {};

    if (nickname !== undefined) {
      sets.push('nickname = ?');
      params.push(String(nickname).trim() || null);
      before.nickname = user.nickname || '';
      after.nickname = String(nickname).trim() || '';
    }

    if (role !== undefined) {
      const finalRole = assertRole(role);
      if (finalRole !== user.role) {
        // 防自锁：不能把自己降级；不能把最后一个管理员降级
        if (user.id === req.user.id) throw badRequest('不能修改自己的角色（防把自己锁在门外）');
        if (user.role === 'admin' && finalRole !== 'admin' && adminCountStmt.get().c <= 1) {
          throw badRequest('这是最后一个管理员，不能降级 —— 否则没人能再进系统设置改回来了');
        }
        sets.push('role = ?');
        params.push(finalRole);
        before.role = user.role;
        after.role = finalRole;
      }
    }

    if (password !== undefined && password !== '') {
      assertPassword(password);
      sets.push('password = ?');
      params.push(bcrypt.hashSync(String(password), 10));
      // 密码是敏感项：日志里只记「已重置」，绝不记明文
      before.password = '已设置';
      after.password = '已重置';
    }

    if (!sets.length) throw badRequest('没有要修改的内容');

    sets.push("updated_at = datetime('now','localtime')");
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);

    writeLog({
      userId: req.user.id,
      username: req.user.username,
      module: 'user',
      action: 'update_user',
      target: user.username,
      source: 'web',
      status: 'success',
      before,
      after,
      ip: clientIp(req),
    });

    return success(res, publicUser(byIdStmt.get(id)), `已更新用户「${user.username}」`);
  })
);

/** 删除用户 */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const user = byIdStmt.get(id);
    if (!user) throw notFound('用户不存在');

    if (user.id === req.user.id) throw badRequest('不能删除自己的账号');
    if (user.role === 'admin' && adminCountStmt.get().c <= 1) {
      throw badRequest('这是最后一个管理员，不能删除');
    }

    deleteStmt.run(id);

    writeLog({
      userId: req.user.id,
      username: req.user.username,
      module: 'user',
      action: 'delete_user',
      target: user.username,
      source: 'web',
      status: 'success',
      before: { username: user.username, role: user.role, nickname: user.nickname || '' },
      after: null,
      ip: clientIp(req),
    });

    return success(res, { deleted: true }, `已删除用户「${user.username}」`);
  })
);

module.exports = router;
