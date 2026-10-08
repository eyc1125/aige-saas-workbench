/**
 * 第三方 webhook 的签名计算
 * ------------------------------------------------------------------
 * 为什么单独抽成零依赖模块：
 *   签名算错的表现是「推送一直失败」—— 既不报错也不抛异常，只是对方静默拒收，
 *   排查成本很高。所以需要一个**能独立验证**的东西：
 *   零依赖 => 可以在不装 node_modules 的 CI job 里直接跑，
 *   并对着平台官方示例算出的固定值做比对（见 scripts/selfcheck-feishu-sign.js）。
 *
 * 只依赖 node:crypto，不依赖 db / settings / 任何业务代码。
 */
'use strict';

const crypto = require('crypto');

/**
 * 飞书自定义机器人的签名
 * ------------------------------------------------------------------
 * ⚠️ 算法照抄官方示例，**不要自己发挥**：
 *
 *   stringToSign = `${timestamp}\n${secret}`        ← 中间是一个换行
 *   sign = base64( HMAC-SHA256( key = stringToSign, message = "" ) )
 *
 * 两个最容易写反的地方：
 *   1. stringToSign 是当作 **key** 用，message 是**空**的 ——
 *      写成 HMAC(key = secret, message = stringToSign) 是最常见的错法；
 *   2. 那个 `\n` 不能少。
 *
 * 以官方 Python 示例为准：
 *   string_to_sign = '{}\n{}'.format(timestamp, secret)
 *   hmac_code = hmac.new(string_to_sign.encode('utf-8'), digestmod=hashlib.sha256).digest()
 *   sign = base64.b64encode(hmac_code).decode('utf-8')
 *
 * @param {string|number} timestamp 秒级时间戳
 * @param {string} secret 机器人「签名校验」里的密钥
 * @returns {string} base64 签名
 */
function feishuSign(timestamp, secret) {
  const stringToSign = `${timestamp}\n${secret}`;
  return crypto.createHmac('sha256', stringToSign).digest('base64');
}

module.exports = { feishuSign };
