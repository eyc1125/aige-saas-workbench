/**
 * TOTP 自检（零依赖，CI 每次真跑）
 * ------------------------------------------------------------------
 * 用 **RFC 6238 附录 B 的官方测试向量**逐字节比对。
 *
 * 为什么必须做这个：验证码算错的表现是「一直提示验证码不对」——
 * 不报错、不抛异常，人只会怀疑手机时间不准或者 App 有问题，
 * 很难想到是自己实现错了。所以把官方算出的固定值写死成期望值。
 *
 * 运行：node backend/scripts/selfcheck-totp.js（CI 也会跑）
 */
'use strict';

const {
  hotp,
  totp,
  verify,
  base32Decode,
  base32Encode,
  generateSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  otpauthUrl,
} = require('../src/utils/totp');

let failed = 0;
const ok = (s) => console.log(`   ✅ ${s}`);
const ng = (s) => {
  console.error(`   ❌ ${s}`);
  failed += 1;
};
const eq = (actual, expect, label) => {
  if (actual === expect) ok(label);
  else ng(`${label}：期望 ${expect}，实际 ${actual}`);
};

// RFC 6238 用的种子是 20 字节 ASCII "12345678901234567890"
const SEED_TEXT = '12345678901234567890';
const SEED_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

console.log('===== TOTP 自检（RFC 6238 官方测试向量）=====');
console.log('');

// ---- 1. base32 编解码 ----
eq(base32Encode(Buffer.from(SEED_TEXT)), SEED_B32, 'base32 编码与 RFC 一致');
eq(base32Decode(SEED_B32).toString(), SEED_TEXT, 'base32 解码与 RFC 一致');
eq(
  base32Decode('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq').toString(),
  SEED_TEXT,
  '解码时忽略大小写、空格与连字符（用户手动输入的样子）'
);
eq(
  base32Encode(base32Decode(generateSecret())).length,
  32,
  '生成的密钥是 32 个 base32 字符（160 bit）'
);

// ---- 2. RFC 6238 附录 B 的六个时间点（8 位码）----
const VECTORS = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

const key = Buffer.from(SEED_TEXT);
VECTORS.forEach(([at, expect]) => {
  const actual = hotp(key, Math.floor(at / 30), 8);
  eq(actual, expect, `T=${at}s（counter=${Math.floor(at / 30)}）→ ${expect}`);
});

// ---- 3. 我们实际用的 6 位码，应当是 8 位码的后 6 位 ----
eq(hotp(key, Math.floor(59 / 30), 6), '287082', '6 位码 = 8 位码取后 6 位（94287082 → 287082）');

// ---- 4. 校验窗口 ----
const secret = SEED_B32;
const at = 1111111111;
const onTime = totp(secret, at);
eq(verify(secret, onTime, { at }), true, '当前时刻的码能通过');
eq(
  verify(secret, totp(secret, at - 30), { at }),
  true,
  '上一步（-30s）的码也能通过 —— 手机与服务器时钟不可能完全一致'
);
eq(verify(secret, totp(secret, at + 30), { at }), true, '下一步（+30s）的码也能通过');
eq(verify(secret, totp(secret, at - 90), { at }), false, '超出 ±1 步的码被拒（窗口不能开太大）');
eq(verify(secret, '000000', { at }), false, '乱填的码被拒');
eq(verify(secret, '12345', { at }), false, '位数不足直接拒');
eq(verify(secret, '', { at }), false, '空值直接拒');
eq(
  verify(secret, `${onTime.slice(0, 3)} ${onTime.slice(3)}`, { at }),
  true,
  '带空格的码也能通过（用户粘贴时可能出现）'
);

// ---- 5. 恢复码 ----
const codes = generateRecoveryCodes(10);
eq(codes.length, 10, '一次生成 10 个恢复码');
eq(
  codes.every((c) => /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(c)),
  true,
  '恢复码格式为 XXXX-XXXX 且不含易混淆的 I / O / 0 / 1'
);
eq(new Set(codes).size, 10, '10 个恢复码互不重复');
eq(hashRecoveryCode('a3f9-k2mp').length, 64, '恢复码以 sha256 存储（64 位十六进制）');
eq(
  hashRecoveryCode('A3F9-K2MP') === hashRecoveryCode('a3f9 k2mp'),
  true,
  '恢复码校验忽略大小写与分隔符（用户抄错格式也能用）'
);
eq(hashRecoveryCode('A3F9-K2MP') === hashRecoveryCode('A3F9-K2MQ'), false, '改一个字符就不匹配');

// ---- 6. otpauth 链接（验证器 App 扫这个）----
const url = otpauthUrl({ secret: SEED_B32, account: 'elyac', issuer: '艾哥SaaS工作台' });
eq(url.startsWith('otpauth://totp/'), true, 'otpauth 链接以 otpauth://totp/ 开头');
eq(url.includes(`secret=${SEED_B32}`), true, '链接里带 secret');
eq(url.includes('digits=6') && url.includes('period=30'), true, '参数为 6 位 / 30 秒');

// ---- 7. 密钥唯一性 ----
eq(
  new Set(Array.from({ length: 50 }, () => generateSecret())).size,
  50,
  '连续生成 50 个密钥互不重复'
);

console.log('');
if (failed) {
  console.error(`❌ TOTP 自检未通过：${failed} 项`);
  process.exit(1);
}
console.log('✅ TOTP 自检通过（与 RFC 6238 官方测试向量逐字节一致）');
