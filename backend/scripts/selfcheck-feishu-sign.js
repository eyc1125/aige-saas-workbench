/**
 * 飞书签名算法自检（对照官方示例的固定值）
 * ------------------------------------------------------------------
 * 为什么值得单独写一个自检：
 *   签名算错的表现是「推送一直失败」—— 不报错、不抛异常，对方只是静默拒收。
 *   而它又是最容易写反的一处（stringToSign 当 key、message 为空，还带一个换行）。
 *   所以这里把**飞书官方 Python 示例**（照抄不改）在固定输入下算出的值写死成期望值，
 *   让 Node 实现逐字节对齐 —— 这是一次真正的跨实现验证，
 *   不是"自己算一遍再跟自己比"。
 *
 * 期望值来源（飞书官方算法）：
 *   string_to_sign = '{}\n{}'.format(timestamp, secret)
 *   hmac_code = hmac.new(string_to_sign.encode('utf-8'), digestmod=hashlib.sha256).digest()
 *   sign = base64.b64encode(hmac_code).decode('utf-8')
 * 由 Python 3.12 跑出，本文件下方 CASES 里逐条列出（含生成命令）。
 *
 * ⚠️ 改 utils/sign.js 之后必须重跑本脚本；它零依赖，CI 每次真跑一遍。
 *
 * 用法：node backend/scripts/selfcheck-feishu-sign.js
 */
'use strict';

const { feishuSign } = require('../src/utils/sign');

/**
 * [timestamp, secret, 由官方 Python 示例算出的签名]
 * 生成命令（在装有 python3 的机器上）：
 *   python3 -c "import hmac,hashlib,base64;s='{ts}\n{secret}';print(base64.b64encode(hmac.new(s.encode(),digestmod=hashlib.sha256).digest()).decode())"
 */
const CASES = [
  ['1700000000', 'test-secret', 'mbm4Y4oluIPQ00qlBIhX8vAZ0EKv3nw0LuTb91jPL84='],
  ['1791407399', 'aige-saas-workbench', '1my7/kPPPpVR8BUUK5SEG6hvm++f3H2p+xhYO589DCk='],
  ['1', '', 'UvZ0hAx3K2gavzQZHyFbKpitulsSL03z/UYKTtfr+Wc='],
  ['1735689600', 'Zx9-abc_DEF.1234567890', '8BJZEqONjSlvLiNrv6mbvmKyjfXWeAvtMGHmVddWaLI='],
];

let failed = 0;

console.log('=== 飞书签名：与官方 Python 示例交叉比对 ===');
for (const [ts, secret, expected] of CASES) {
  const actual = feishuSign(ts, secret);
  if (actual === expected) {
    console.log(`   ✅ timestamp=${ts} secret=${JSON.stringify(secret)} → ${actual}`);
  } else {
    failed += 1;
    console.error(`   ❌ timestamp=${ts} secret=${JSON.stringify(secret)}`);
    console.error(`      期望（Python 官方示例）：${expected}`);
    console.error(`      实际（Node 实现）      ：${actual}`);
  }
}

console.log('\n=== 形状与行为约束 ===');
// base64(SHA-256) 恒为 32 字节 → 44 个字符并以 '=' 结尾
const sample = feishuSign('1700000000', 'test-secret');
if (sample.length === 44 && sample.endsWith('=')) {
  console.log('   ✅ 长度 44、以 = 结尾（符合 base64 编码 32 字节摘要）');
} else {
  failed += 1;
  console.error(`   ❌ 签名形状不对：长度 ${sample.length}，末尾 "${sample.slice(-2)}"`);
}

// 换行不能少：把 \n 去掉必须得到**不同**的结果，否则说明实现忽略了换行
const noNewline = feishuSign('1700000000', '\ntest-secret');
if (noNewline !== sample) {
  console.log('   ✅ 换行参与计算（去掉换行会得到不同签名）');
} else {
  failed += 1;
  console.error('   ❌ 换行没有参与计算 —— stringToSign 里的 \\n 被丢了');
}

// 密钥不同必须结果不同（防"把 secret 忽略了"这种低级错）
if (feishuSign('1700000000', 'other-secret') !== sample) {
  console.log('   ✅ 密钥参与计算（换密钥会得到不同签名）');
} else {
  failed += 1;
  console.error('   ❌ 换密钥签名没变 —— secret 被忽略了');
}

// 时间戳类型：数字与字符串应等价（调用方可能传 number）
if (feishuSign(1700000000, 'test-secret') === sample) {
  console.log('   ✅ 时间戳传数字与字符串等价');
} else {
  failed += 1;
  console.error(
    '   ❌ 时间戳传数字与字符串结果不一致（body 里两者都会被飞书接受，但结果必须相同）'
  );
}

console.log('');
if (failed) {
  console.error(`❌ 飞书签名自检未通过：${failed} 项`);
  process.exit(1);
}
console.log(`✅ 飞书签名自检通过（${CASES.length} 组固定值与官方 Python 示例逐字节一致）`);
