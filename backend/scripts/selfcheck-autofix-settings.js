/**
 * 自动自愈开关自检
 * ------------------------------------------------------------------
 * ⛔ 踩过的坑（本轮实测发现）：`health.js` 一直在用
 *    `settings.set('auto_heal_enabled')` 存自动自愈开关，
 *    但 `services/settings.js` 的白名单 `SCHEMA` 里**没有登记这两个 key** ——
 *    `set()` 直接抛「未知配置项：auto_heal_enabled」。
 *
 *    后果是「健康巡检」页上的自动自愈开关**从来没生效过**：拨过去就报错/弹回，
 *    而后端日志一片正常、启动日志也照常说「当前关闭」，完全看不出坏在哪。
 *
 * 所以这里只做一件事：**真的把开关写进去、再读回来**，对不上就红。
 * 这也是「零征兆静默失效」唯一能被机器逮到的办法。
 *
 * 运行：node backend/scripts/selfcheck-autofix-settings.js
 */
'use strict';

const settings = require('../src/services/settings');
const health = require('../src/services/health');

/** 自动自愈用到的配置项（写死在 health.js 里，这里必须与之一致） */
const REQUIRED_KEYS = ['auto_heal_enabled', 'auto_heal_interval_min'];

let failed = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failed += 1;
}

// ① 用到的 key 必须已在白名单里登记
const missing = REQUIRED_KEYS.filter((k) => !settings.SCHEMA[k]);
check('自动自愈的配置项已登记进 settings 白名单', missing.length === 0, missing.join('、'));

// ② 真的能写、能读回（等价于用户在页面上拨一次开关）
const before = health.getAutoHeal();
try {
  health.setAutoHeal({ enabled: true, intervalMin: 10 });
  check('开启后读回为「已开启」', health.getAutoHeal().enabled === true);
  check('间隔写 10 分钟能正确读回', health.getAutoHeal().intervalMin === 10);

  health.setAutoHeal({ enabled: false });
  check('关闭后读回为「已关闭」', health.getAutoHeal().enabled === false);
} catch (err) {
  check('开关可以正常读写', false, err.message);
} finally {
  // 还原运行前的状态，别污染本机 / CI 的库
  try {
    health.setAutoHeal({ enabled: before.enabled, intervalMin: before.intervalMin });
  } catch {
    /* 前面已经失败过，这里不再叠加噪音 */
  }
}

if (failed) {
  console.error(`\n❌ 自动自愈配置自检未通过（${failed} 项）`);
  console.error('   多半是 settings.js 的 SCHEMA 里漏登记了 auto_heal_* 配置项。');
  process.exit(1);
}
console.log('\n✅ 自动自愈配置自检全部通过');
