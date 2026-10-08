/**
 * 权限覆盖自检（B5 · 零容忍，CI 每次真跑）
 * ------------------------------------------------------------------
 * 为什么必须有这个：权限体系最典型的失效方式不是「判错了」，
 * 而是**漏判** —— 新加一个模块，忘了在 routes/index.js 里挂 requirePermission，
 * 那个模块下的所有接口就退化成「只要登录就能用」。
 * 它不报错、不告警，界面上也看不出来，只有等出事才知道。
 *
 * 所以这里不看代码写得对不对，而是**遍历真实挂载的路由栈**，断言两件事：
 *   1. 每个业务模块（除 /health 与 /auth）都挂了 requireAuth + requirePermission
 *   2. 「实际挂载的模块」与「权限规则表 MODULE_RULES 里的模块」完全一致
 *      —— 少一个 = 新模块没归类；多一个 = 规则表里有沉淀的死规则
 */
'use strict';

const express = require('express');
const routes = require('../src/routes');
const { MODULE_RULES } = require('../src/middleware/permissions');

let failed = 0;
const ok = (s) => console.log(`   ✅ ${s}`);
const ng = (s) => {
  console.error(`   ❌ ${s}`);
  failed += 1;
};

/** 公开 / 内部自理的模块：本来就不该走 requirePermission */
const PUBLIC_MODULES = new Set(['/health', '/auth']);

/**
 * 从 layer 的正则里还原挂载路径
 * Express 4 把 '/websites' 编译成 /^\/websites\/?(?=\/|$)/i
 */
function layerPath(layer) {
  const src = String(layer.regexp?.source || '');
  const m = src.match(/^\^\\\/([^\\?]*)/);
  if (!m) return null;
  return `/${m[1].replace(/\\\//g, '/')}`;
}

/** 遍历 router.stack，按挂载路径聚合出「这个模块挂了哪些中间件」 */
function collect(router) {
  const groups = new Map();
  (router.stack || []).forEach((layer) => {
    const path = layerPath(layer);
    if (path === null) return;
    if (!groups.has(path)) {
      groups.set(path, { hasAuth: false, hasPerm: false, hasRouter: false, methods: new Set() });
    }
    const g = groups.get(path);
    const name = layer.handle?.name;

    if (name === 'requireAuth') {
      g.hasAuth = true;
    } else if (name === 'requirePermission') {
      g.hasPerm = true;
    } else if (layer.handle?.stack) {
      g.hasRouter = true;
      (layer.handle.stack || []).forEach((l) => {
        if (l.route) Object.keys(l.route.methods).forEach((m) => g.methods.add(m.toUpperCase()));
      });
    } else if (layer.route) {
      Object.keys(layer.route.methods).forEach((m) => g.methods.add(m.toUpperCase()));
    }
  });
  return groups;
}

console.log('===== 权限覆盖自检（B5） =====');

// 挂一个最小 app 把路由挂上去（和 index.js 的入口保持一致：都挂在 /api 下）
const app = express();
app.use('/api', routes);

const groups = collect(routes);
const mounted = [...groups.keys()].filter((p) => !PUBLIC_MODULES.has(p)).sort();
const configured = MODULE_RULES.map((r) => r.path).sort();

console.log(`   实际挂载的业务模块 ${mounted.length} 个：${mounted.join('、')}`);
console.log(`   权限规则表里的模块 ${configured.length} 个`);
console.log('');

// ---- 1. 每个业务模块都必须挂 requireAuth + requirePermission ----
const missingGuard = [];
mounted.forEach((path) => {
  const g = groups.get(path);
  if (!g.hasRouter) return; // 只挂在根上的杂项（如 /health），已排除
  const lack = [];
  if (!g.hasAuth) lack.push('requireAuth');
  if (!g.hasPerm) lack.push('requirePermission');
  if (lack.length) missingGuard.push(`${path}（缺 ${lack.join(' + ')}）`);
});
if (missingGuard.length) {
  ng(
    `这些模块没有挂权限中间件，任何登录用户都能全权操作：\n      ${missingGuard.join('\n      ')}`
  );
} else {
  ok('每个业务模块都挂了 requireAuth + requirePermission');
}

// ---- 2. 挂载的模块与规则表必须完全一致 ----
const noRule = mounted.filter((p) => !configured.includes(p));
const noMount = configured.filter((p) => !mounted.includes(p));
if (noRule.length) {
  ng(`这些模块没有在 permissions.js 的 MODULE_RULES 里归类：${noRule.join('、')}`);
} else {
  ok('所有业务模块都在权限规则表里有明确归类（没有靠默认值兜着）');
}
if (noMount.length) {
  ng(`规则表里列了并不存在的模块（改过名或删掉了？）：${noMount.join('、')}`);
} else {
  ok('规则表里没有已不存在的模块（无沉淀死规则）');
}

// ---- 3. 值本身要合法 ----
const badValue = MODULE_RULES.filter(
  (r) =>
    !['viewer', 'operator', 'admin'].includes(r.read) ||
    !['viewer', 'operator', 'admin'].includes(r.write)
).map((r) => r.path);
if (badValue.length) {
  ng(`规则里的角色名不合法：${badValue.join('、')}`);
} else {
  ok('规则表里的角色名都合法（viewer / operator / admin）');
}

console.log('');
if (failed) {
  console.error(`❌ 权限覆盖自检未通过：${failed} 项`);
  process.exit(1);
}
console.log(`✅ 权限覆盖自检通过（${mounted.length} 个业务模块全部归位）`);
