/**
 * TOTP（基于时间的一次性口令）· D1 登录二次验证
 * ------------------------------------------------------------------
 * 零依赖实现，照 RFC 6238 / RFC 4226 写。之所以不引 otplib 之类的库：
 *   · 算法本身只有几十行，引一个库反而多一个供应链面（这是安全功能）；
 *   · 零依赖才能让 scripts/selfcheck-totp.js 拿 RFC 官方测试向量逐字节比对 ——
 *     验证码算错的表现是「一直提示验证码不对」，很难查，必须能独立断言。
 *
 * ⚠️ 兼容性说明：Google Authenticator / 微软验证器 / 1Password / Authy 等
 *    都按 RFC 6238 实现，参数用默认的 SHA1 / 6 位 / 30 秒即可被它们识别。
 *    （SHA1 在这里不是"弱哈希"问题 —— HMAC-SHA1 的抗碰撞性对 TOTP 足够，
 *      换 SHA256 反而会让一部分老验证器不认。）
 */
'use strict';

const crypto = require('crypto');

/** base32 字母表（RFC 4648，验证器通用） */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 恢复码字母表：去掉容易看错的 I / O / 0 / 1 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 默认参数 */
const STEP = 30; // 秒
const DIGITS = 6;

// ============================================================
// base32
// ============================================================

/** base32 → Buffer（忽略空格与连字符，方便用户手动输入带横线的密钥） */
function base32Decode(input) {
  const clean = String(input || '')
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/** Buffer → base32（不带 padding，验证器普遍接受这种形式） */
function base32Encode(buf) {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += B32[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out;
}

// ============================================================
// 核心：HOTP / TOTP
// ============================================================

/**
 * HOTP（RFC 4226）：HMAC-SHA1 + 动态截断
 * @param {Buffer} key
 * @param {number|bigint} counter
 * @param {number} digits
 */
function hotp(key, counter, digits = DIGITS) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  // 动态截断：取最后一字节低 4 位做偏移，从该位置取 4 字节，抹掉最高位（保证正数）
  const offset = hmac[hmac.length - 1] & 0x0f;
  const value =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(value % 10 ** digits).padStart(digits, '0');
}

/**
 * 算某一时刻的验证码
 * @param {string} secret base32 密钥
 * @param {number} [atSeconds] 时间点（秒），默认现在
 * @param {number} [step]
 */
function totp(secret, atSeconds = Date.now() / 1000, step = STEP) {
  return hotp(base32Decode(secret), Math.floor(atSeconds / step));
}

/**
 * 校验验证码
 * @param {string} secret
 * @param {string} code 用户输入的 6 位码（允许带空格）
 * @param {{window?: number, step?: number, at?: number}} [options]
 *        window：容忍前后各几步。默认 1（±30 秒）——
 *        手机与服务器时钟不可能完全一致，容差太小会出现"刚输完就说错"。
 *        但也别调大：窗口越大，被猜中的概率越高。
 * @returns {boolean}
 */
function verify(secret, code, options = {}) {
  const { window = 1, step = STEP, at = Date.now() / 1000 } = options;
  const target = String(code || '').replace(/\D/g, '');
  if (target.length !== DIGITS) return false;

  const key = base32Decode(secret);
  if (!key.length) return false;

  const counter = Math.floor(at / step);
  for (let i = -window; i <= window; i += 1) {
    const expect = hotp(key, counter + i);
    // 定长字符串比较，用 timingSafeEqual 免得从耗时上反推"差多少"
    if (
      expect.length === target.length &&
      crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(target))
    ) {
      return true;
    }
  }
  return false;
}

// ============================================================
// 密钥 / 恢复码
// ============================================================

/** 生成新密钥：160 bit 随机（RFC 4226 推荐长度），base32 后 32 个字符 */
function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

/** 生成恢复码（一次性）：形如 `A3F9-K2MP` */
function generateRecoveryCodes(count = 10) {
  const list = [];
  for (let i = 0; i < count; i += 1) {
    const bytes = crypto.randomBytes(8);
    let s = '';
    // 256 % 32 === 0，取模无偏
    for (const b of bytes) s += RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length];
    list.push(`${s.slice(0, 4)}-${s.slice(4, 8)}`);
  }
  return list;
}

/**
 * 恢复码入库前的处理
 * 说明：恢复码是**一次性 + 高熵**（32^8）的，用 sha256 足够；
 *      不必上 bcrypt（那会让每次校验都变慢，而这里没有弱口令问题）。
 *      不存明文是为了「数据库被拖走也拿不到登录凭据」。
 * ⚠️ 必须先把格式归一化（大写 + 去掉连字符/空格）：
 *    用户从纸上抄回来时写成 `a3f9k2mp` 或 `A3F9 K2MP` 都很正常，
 *    不归一化就会出现「明明抄对了却说无效」。
 */
function hashRecoveryCode(code) {
  const normalized = String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// ============================================================
// 给验证器 App 扫的地址
// ============================================================

/**
 * 生成 otpauth:// 链接（前端把它画成二维码）
 * @param {{secret: string, account: string, issuer?: string}} options
 */
function otpauthUrl({ secret, account, issuer = '艾哥SaaS工作台' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** 把密钥按 4 位分组，方便用户手动抄进验证器 */
const formatSecret = (secret) => (String(secret || '').match(/.{1,4}/g) || []).join(' ');

module.exports = {
  STEP,
  DIGITS,
  base32Decode,
  base32Encode,
  hotp,
  totp,
  verify,
  generateSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  otpauthUrl,
  formatSecret,
};
