/**
 * MCP 工具「只读 / 写」归类自检（零依赖，CI 每次真跑）
 * ------------------------------------------------------------------
 * 为什么必须有这个自检：
 *   只读令牌的安全性完全押在 READONLY_TOOLS 这份白名单上。
 *   将来加工具时最危险的失误不是「写错逻辑」，而是**忘了归类**——
 *   那一刻没有任何报错，只读令牌要么悄悄多了一个写权限，要么少了一个只读工具
 *   （AI 会以为工具不存在，绕路去用别的办法）。
 *
 * 所以这里断言四件事：
 *   1. 覆盖完整：每个注册工具都必须在 READONLY_TOOLS 或 WRITE_TOOLS 里
 *   2. 互不重叠：两个集合没有交集
 *   3. 前缀语义：list_/get_ 开头必须只读；delete_/create_/save_/add_/update_ 开头必须写
 *   4. 底线不变量：call_bt_api 必须算写；两边的数量都要大于 0
 */
'use strict';

// ⚠️ 这个自检不像 check:guards / check:sign 那样零依赖：
//    tools.js 顶部会 require services → db → bcryptjs，所以必须有后端依赖才能跑。
//    缺依赖时明确「跳过」而不是报失败 —— 否则在没装依赖的环境里会看到一个假红灯，
//    下次真出问题时就被当成"又是那个假报警"忽略掉了。
let TOOL_NAMES;
let READONLY_TOOLS;
let WRITE_TOOLS;
try {
  ({ TOOL_NAMES, READONLY_TOOLS, WRITE_TOOLS } = require('../src/mcp/tools'));
} catch (err) {
  // 只放行「tools.js 里依赖装不齐」这一种情况。若连 tools.js 本身都找不到，
  // 说明是路径写错了（真 bug），必须照常抛出去。
  const selfMissing = String(err && err.message).includes("'../src/mcp/tools'");
  if (err && err.code === 'MODULE_NOT_FOUND' && !selfMissing) {
    console.log('⚠️  跳过 MCP 作用域自检：缺少后端依赖（tools.js 会 require db / bcryptjs）。');
    console.log('   先执行 `cd backend && npm install`，或在 CI 的 mcp-tools job 里跑。');
    process.exit(0);
  }
  throw err;
}

let failed = 0;
const ok = (msg) => console.log(`   ✅ ${msg}`);
const ng = (msg) => {
  console.error(`   ❌ ${msg}`);
  failed += 1;
};

const readonly = [...READONLY_TOOLS];
const write = [...WRITE_TOOLS];

console.log('===== MCP 工具作用域自检 =====');
console.log(
  `   已注册 ${TOOL_NAMES.length} 个工具：只读 ${readonly.length} 个 / 写 ${write.length} 个`
);
console.log('');

// 1. 覆盖完整
const unclassified = TOOL_NAMES.filter((n) => !READONLY_TOOLS.has(n) && !WRITE_TOOLS.has(n));
if (unclassified.length) {
  ng(
    `这些工具没有归类（新增工具后必须同时更新 tools.js 的 READONLY_TOOLS / WRITE_TOOLS）：${unclassified.join(', ')}`
  );
} else {
  ok(`全部 ${TOOL_NAMES.length} 个工具都已显式归类（没有依赖默认值）`);
}

// 2. 互不重叠
const overlap = readonly.filter((n) => WRITE_TOOLS.has(n));
if (overlap.length) {
  ng(`同一个工具同时出现在只读与写两份名单里：${overlap.join(', ')}`);
} else {
  ok('只读名单与写名单无交集');
}

// 3. 不存在的工具（改名/删除后忘了同步名单）
const ghost = [...readonly, ...write].filter((n) => !TOOL_NAMES.includes(n));
if (ghost.length) {
  ng(`名单里列了不存在的工具（工具已改名或删除？）：${ghost.join(', ')}`);
} else {
  ok('名单里没有已不存在的工具');
}

// 4. 前缀语义（防手滑把 list_websites 归到写、把 delete_website 归到只读）
const READONLY_PREFIX = ['list_', 'get_'];
const WRITE_PREFIX = ['create_', 'delete_', 'save_', 'add_', 'update_'];

const prefixWrong = [];
TOOL_NAMES.forEach((n) => {
  if (READONLY_PREFIX.some((p) => n.startsWith(p)) && !READONLY_TOOLS.has(n)) {
    prefixWrong.push(`${n}（${n.split('_')[0]}_ 开头却不在只读名单）`);
  }
  if (WRITE_PREFIX.some((p) => n.startsWith(p)) && !WRITE_TOOLS.has(n)) {
    prefixWrong.push(`${n}（${n.split('_')[0]}_ 开头却不在写名单）`);
  }
});
if (prefixWrong.length) {
  ng(`前缀语义不符：${prefixWrong.join('；')}`);
} else {
  ok('list_/get_ 全部归只读，create_/delete_/save_/add_/update_ 全部归写');
}

// 5. 底线不变量
if (WRITE_TOOLS.has('call_bt_api')) {
  ok('call_bt_api 归类为「写」（它能触达宝塔任意写接口，必须如此）');
} else {
  ng('call_bt_api 必须是写工具 —— 它能调用宝塔任意接口，只读令牌放行它等于没有只读');
}
if (readonly.length > 0 && write.length > 0) {
  ok('两类都非空（不是把所有工具一股脑归到一边）');
} else {
  ng('只读或写名单为空，归类明显不完整');
}

console.log('');
if (failed) {
  console.error(`❌ MCP 作用域自检未通过：${failed} 项`);
  process.exit(1);
}
console.log(`✅ MCP 作用域自检通过（只读 ${readonly.length} 个 / 写 ${write.length} 个）`);
