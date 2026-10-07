/**
 * 敏感配置加解密
 * ------------------------------------------------------------------
 * 算法：AES-256-GCM（带认证标签，防篡改）
 * 密钥：由 ENCRYPTION_KEY 经 scrypt 派生出 32 字节密钥
 * 存储格式：enc:v1:<ivBase64>:<tagBase64>:<cipherBase64>
 *
 * 设计说明：加密只用于「落库的敏感配置」（宝塔密钥、Cloudflare Token）。
 *          密钥本身放在 .env，不落库，避免「密钥和密文放一起」等于没加密。
 */
'use strict';

const crypto = require('crypto');
const config = require('../config');

const PREFIX = 'enc:v1:';
// scrypt 加盐值固定（密钥强度由 ENCRYPTION_KEY 本身保证），保证重启后能解出旧密文
const SCRYPT_SALT = 'aige-workbench-config-salt';

let cachedKey = null;
function getKey() {
  if (!cachedKey) {
    cachedKey = crypto.scryptSync(config.encryptionKey, SCRYPT_SALT, 32);
  }
  return cachedKey;
}

/**
 * 加密明文
 * @param {string} plain 明文
 * @returns {string} 密文（带 enc:v1: 前缀，便于识别）
 */
function encrypt(plain) {
  if (plain === undefined || plain === null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * 解密
 * @param {string} value 密文；若不是本系统格式则原样返回（兼容早期明文数据）
 */
function decrypt(value) {
  if (!value) return '';
  const text = String(value);
  if (!text.startsWith(PREFIX)) return text; // 历史明文，直接返回

  try {
    const [ivB64, tagB64, dataB64] = text.slice(PREFIX.length).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // 密钥被换过 / 数据损坏：返回空串而不是抛错，让上层给出「请重新填写」的提示
    console.warn('[crypto] 配置解密失败（ENCRYPTION_KEY 可能已变更），请到系统设置重新填写该配置');
    return '';
  }
}

/** 是否为本系统加密格式 */
const isEncrypted = (value) => typeof value === 'string' && value.startsWith(PREFIX);

/**
 * 脱敏展示：只保留首尾少量字符
 * @param {string} value 明文或密文
 * @param {number} head 头部保留长度
 * @param {number} tail 尾部保留长度
 */
function mask(value, head = 4, tail = 4) {
  const plain = decrypt(value);
  if (!plain) return '';
  if (plain.length <= head + tail) return '*'.repeat(plain.length);
  return `${plain.slice(0, head)}${'*'.repeat(Math.min(plain.length - head - tail, 12))}${plain.slice(-tail)}`;
}

module.exports = { encrypt, decrypt, isEncrypted, mask };
