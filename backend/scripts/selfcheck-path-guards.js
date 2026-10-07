/**
 * 路径白名单自检（安全回归）
 * ------------------------------------------------------------------
 * 为什么单独做成一个可执行脚本，而不是只写在代码注释里：
 *   `utils/safePath.js` 挡住的是「通过站点名/备份文件名穿越到别的项目配置」
 *   —— 这是本项目最不能出的安全事故，而它偏偏是那种"平时看不出问题、
 *   一旦失效也毫无征兆"的防线。所以给它一个可重复执行的断言，
 *   让 CI 每次都真正跑一遍，而不是靠"读代码觉得没问题"。
 *
 * 零依赖（只 require 自己项目里的 utils/errors），
 * 所以在**不装 node_modules** 的 CI job 里也能跑。
 *
 * 用法：
 *   node backend/scripts/selfcheck-path-guards.js
 * 退出码非 0 即表示防线失效，CI 会红。
 */
'use strict';

const {
  assertSiteName,
  assertSnapshotFileName,
  snapshotTimestamp,
} = require('../src/utils/safePath');

/** 应当被拒绝的站点名 */
const BAD_SITES = [
  '', // 空
  '   ', // 全空格
  '../etc/passwd', // 目录穿越
  'a/b', // 正斜杠
  'a\\b', // 反斜杠（Windows 风格）
  '..', // 父目录
  '...', // 变体
  'a..b', // 名字里夹 ..
  '.hidden', // 以点开头
  'a\0b', // NUL 截断
  'x'.repeat(300), // 超长
  null,
  undefined,
  123,
];

/** 应当被接受的站点名（真实用到的形态，别误拦） */
const GOOD_SITES = [
  'koyca.com',
  'aige-saas-panel.miaocaieyc.com.cn',
  '*.example.com',
  'site_1',
  'site-1',
];

/** 应当被拒绝的备份文件名（站点固定为 x.com） */
const BAD_FILES = [
  '', // 空
  'x.com.conf.bak.', // 没有时间戳
  'x.com.conf.bak.123', // 位数不够（可能是手工改名）
  'x.com.conf.bak.abcdefghij', // 非数字
  'x.com.conf.bak.1700000000000/../../y', // 尾部拼穿越
  'other.com.conf.bak.1700000000000', // 别的站点的备份
  'koyca.com.conf.bak.1700000000000', // 确实是别的项目的站点
  'x.com.conf.bak.1700000000000.bak', // 多余后缀
  'x.com.conf', // 当前配置，不能当备份回滚
];

const GOOD_FILE = 'x.com.conf.bak.1700000000000';

let failed = 0;

function expectReject(kind, label, fn) {
  let rejected = false;
  let message = '';
  try {
    fn();
  } catch (err) {
    rejected = true;
    message = err.message;
  }
  if (!rejected) {
    failed += 1;
    console.error(`❌ ${kind} 未被拦住：${JSON.stringify(label)}`);
  } else {
    console.log(`   ✅ 拦住 ${kind} ${JSON.stringify(label)} → ${message}`);
  }
}

function expectAccept(kind, label, fn) {
  try {
    fn();
    console.log(`   ✅ 放行合法${kind} ${JSON.stringify(label)}`);
  } catch (err) {
    failed += 1;
    console.error(`❌ 误拦合法${kind} ${JSON.stringify(label)} → ${err.message}`);
  }
}

console.log('=== 站点名校验 ===');
BAD_SITES.forEach((s) => expectReject('站点名', s, () => assertSiteName(s)));
GOOD_SITES.forEach((s) => expectAccept('站点名', s, () => assertSiteName(s)));

console.log('\n=== 备份文件名校验（站点固定 x.com）===');
BAD_FILES.forEach((f) => expectReject('文件名', f, () => assertSnapshotFileName('x.com', f)));
expectAccept('文件名', GOOD_FILE, () => assertSnapshotFileName('x.com', GOOD_FILE));

console.log('\n=== 时间戳解析 ===');
const ts = snapshotTimestamp(GOOD_FILE);
if (ts === 1700000000000) {
  console.log('   ✅ 时间戳解析正确');
} else {
  failed += 1;
  console.error(`❌ 时间戳解析错误：期望 1700000000000，实际 ${ts}`);
}
if (snapshotTimestamp('x.com.conf') === null) {
  console.log('   ✅ 非备份文件返回 null');
} else {
  failed += 1;
  console.error('❌ 非备份文件应返回 null');
}

console.log('');
if (failed) {
  console.error(`❌ 路径白名单自检未通过：${failed} 项`);
  process.exit(1);
}
console.log(
  `✅ 路径白名单自检通过（越权样本 ${BAD_SITES.length + BAD_FILES.length} 个全部拦住，合法样本全部放行）`
);
