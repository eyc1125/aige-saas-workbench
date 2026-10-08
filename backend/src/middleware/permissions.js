/**
 * 角色与权限（B5）
 * ------------------------------------------------------------------
 * 三个角色，按「能做什么」划分，而不是按「能看哪一页」：
 *
 *   viewer    只读 —— 能看所有运维页面与数据，**任何写操作都被拒**
 *   operator  运维 —— 能操作网站 / DNS / 容器 / 应用部署 / 巡检修复；
 *                     改不了系统配置，也管不了账号
 *   admin     管理员 —— 全权，含系统设置、MCP 令牌、用户管理
 *
 * ⛔ 这个文件是**唯一的权限事实来源**。
 *    不要在各自的路由文件里手写角色判断 —— 那样一定有漏的，而漏掉的那一个接口
 *    就是「所有登录用户都能全权操作」。正确姿势只有两步：
 *      ① 在下面 MODULE_RULES 里给新模块定角色；
 *      ② 跑 `npm run check:perm`（CI 每次真跑）—— 它会比对「真实挂载的模块」
 *         与「规则表里的模块」，少一个直接报红。
 *
 * ⚠️ 判定只看两样：**请求方法** + **模块路径**。不看前端传的任何东西 ——
 *    前端隐藏按钮是体验，不是安全边界。
 */
'use strict';

const { forbidden } = require('../utils/errors');

/** 角色等级：数字越大权限越高 */
const ROLE_LEVEL = { viewer: 1, operator: 2, admin: 3 };

/** 角色中文名（错误提示与界面展示共用） */
const ROLE_TEXT = { viewer: '只读', operator: '运维', admin: '管理员' };

/** 合法角色列表（新增用户 / 改角色时校验用） */
const ROLES = Object.keys(ROLE_LEVEL);

/** 只要读、不改任何状态的方法 */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const isReadMethod = (method) => READ_METHODS.has(String(method || '').toUpperCase());

/**
 * 模块级规则 —— **每个挂到 /api 下的模块都必须在这里出现**。
 * read  = GET/HEAD/OPTIONS 的最低角色
 * write = 其余方法的最低角色
 *
 * 为什么不用一条「其余全是 operator」兜底：那样新模块忘了归类时，
 * 它会**悄悄**变成运维可用。像用户管理这种本该只有管理员能碰的模块，
 * 「忘了写规则」就等于给运维开了口子 —— 而这种事没有任何征兆。
 * 现在改成显式列举 + CI 比对，漏一个立刻红。
 */
const MODULE_RULES = [
  { path: '/dashboard', read: 'viewer', write: 'operator' },
  { path: '/websites', read: 'viewer', write: 'operator' },
  { path: '/inspect', read: 'viewer', write: 'operator' },
  { path: '/alerts', read: 'viewer', write: 'operator' },
  { path: '/domains', read: 'viewer', write: 'operator' },
  { path: '/docker', read: 'viewer', write: 'operator' },
  { path: '/apps', read: 'viewer', write: 'operator' },
  { path: '/logs', read: 'viewer', write: 'admin' },
  // 系统设置里躺着宝塔密钥 / Cloudflare Token / MCP 令牌 / 机器人 Webhook，
  // 「能看到」约等于「能拿到半台服务器」，所以整块（含读）都要求管理员。
  { path: '/settings', read: 'admin', write: 'admin' },
  // 用户与角色管理
  { path: '/users', read: 'admin', write: 'admin' },
];

/**
 * 路径级例外 —— 优先级高于模块规则，从上往下第一条命中生效。
 * 只用于「同一个模块里有个别接口不该跟着模块走」的情况。
 */
const EXCEPTIONS = [
  // 任何登录角色都该能做的「自己的事」
  { path: '/auth/profile', method: 'GET', min: 'viewer', why: '看自己的登录信息' },
  { path: '/auth/password', method: 'PUT', min: 'viewer', why: '改自己的密码' },
  { path: '/auth/logout', method: 'POST', min: 'viewer', why: '退出登录' },
];

/**
 * 算出某接口需要的最低角色
 * @param {string} modulePath 模块路径，如 /websites（不含 /api 前缀）
 * @param {string} method HTTP 方法
 * @returns {{min: string, explicit: boolean, rule: object|null}}
 *          explicit=false 表示没有任何规则覆盖它（只有 /auth 这类内部自理的模块会这样）
 */
function minRoleFor(modulePath, method) {
  const path = String(modulePath || '/');
  const m = String(method || 'GET').toUpperCase();

  for (const rule of EXCEPTIONS) {
    if (path === rule.path && rule.method === m) {
      return { min: rule.min, explicit: true, rule };
    }
  }

  // 取「最长前缀匹配」，这样将来出现嵌套模块（如 /apps/tasks）也能定出更细的规则
  let best = null;
  for (const rule of MODULE_RULES) {
    if (!path.startsWith(rule.path)) continue;
    if (!best || rule.path.length > best.path.length) best = rule;
  }
  if (best) {
    const min = isReadMethod(m) ? best.read : best.write;
    return { min, explicit: true, rule: best };
  }

  // 没有规则覆盖：读操作按只读放行，写操作按运维放行（保守侧），但显式标记出来
  return { min: isReadMethod(m) ? 'viewer' : 'operator', explicit: false, rule: null };
}

/** 角色是否达到最低要求（未知角色一律不通过） */
function allows(role, min) {
  const have = ROLE_LEVEL[role] || 0;
  const need = ROLE_LEVEL[min] || 99;
  return have >= need;
}

/**
 * 权限中间件：按「模块路径 + 方法」判定
 * 用法：router.use('/websites', requireAuth, requirePermission, require('./websites'))
 * ⚠️ 必须排在 requireAuth 之后 —— 它依赖 req.user.role。
 */
function requirePermission(req, _res, next) {
  // req.baseUrl 在 router.use 中间件里就是这个模块的挂载路径（如 /api/websites）
  const modulePath = String(req.baseUrl || '').replace(/^\/api/, '') || '/';
  const { min } = minRoleFor(modulePath, req.method);

  if (allows(req.user?.role, min)) return next();

  const mine = ROLE_TEXT[req.user?.role] || '未知身份';
  return next(forbidden(`该操作需要「${ROLE_TEXT[min]}」及以上权限，当前身份是「${mine}」。`));
}

/** 某个角色能不能做某件事（导出给自检与前端提示用；真正的拦截在 requirePermission） */
function can(role, modulePath, method) {
  return allows(role, minRoleFor(modulePath, method).min);
}

module.exports = {
  ROLE_LEVEL,
  ROLE_TEXT,
  ROLES,
  MODULE_RULES,
  EXCEPTIONS,
  READ_METHODS,
  isReadMethod,
  minRoleFor,
  allows,
  requirePermission,
  can,
};
