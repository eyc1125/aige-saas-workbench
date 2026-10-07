/**
 * 外部 HTTP 请求封装
 * ------------------------------------------------------------------
 * 基于 Node 内置 fetch，统一处理：
 *   - 超时（默认 15 秒，避免外部接口卡死把后端拖住）
 *   - 统一的错误信息（把外部返回的错误体拼进 message，方便排查）
 *   - 自签证书跳过校验（insecure 选项，专供内网面板这类场景）
 */
'use strict';

const { upstream } = require('./errors');

/**
 * 惰性创建的「不校验证书」调度器。
 * 说明：宝塔面板用 IP + 自签证书提供 HTTPS，Node 的 fetch 默认会因证书不可信直接拒连。
 *      用 undici 的 Agent 精确关掉这一条通道的校验，而不是用
 *      NODE_TLS_REJECT_UNAUTHORIZED=0 全局关掉——那会连带削弱 Cloudflare 等
 *      公网接口的 TLS 防护，属于过度让步。
 */
let insecureDispatcher = null;
function getInsecureDispatcher() {
  if (!insecureDispatcher) {
    // 懒加载：只有连自签证书的内网面板时才需要它，普通请求不必加载 undici
    const { Agent } = require('undici');
    insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  }
  return insecureDispatcher;
}

/**
 * @param {string} url 完整地址
 * @param {object} [options]
 * @param {string} [options.method='GET']
 * @param {object} [options.headers]
 * @param {any}    [options.body]        对象会自动 JSON 序列化
 * @param {number} [options.timeout=15000] 超时毫秒
 * @param {string} [options.serviceName] 出错时用于拼提示，如「宝塔面板」
 * @param {boolean}[options.raw=false]   true 则返回原始文本，不做 JSON 解析
 * @param {boolean}[options.insecure=false] true 则跳过 TLS 证书校验（自签证书场景）
 */
async function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeout = 15000,
    serviceName = '外部服务',
    raw = false,
    insecure = false,
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const finalHeaders = { ...headers };
  let payload;
  if (body !== undefined && body !== null) {
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      payload = body;
    } else {
      payload = JSON.stringify(body);
      finalHeaders['Content-Type'] = finalHeaders['Content-Type'] || 'application/json';
    }
  }

  const init = {
    method,
    headers: finalHeaders,
    body: payload,
    signal: controller.signal,
  };
  if (insecure) init.dispatcher = getInsecureDispatcher();

  try {
    const res = await fetch(url, init);
    const text = await res.text();

    if (!res.ok) {
      throw upstream(`${serviceName}返回错误（HTTP ${res.status}）`, {
        url,
        status: res.status,
        response: text.slice(0, 800),
      });
    }

    if (raw) return text;
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      // 少数接口返回非 JSON（例如宝塔的部分接口），原样返回文本
      return text;
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      throw upstream(`${serviceName}请求超时（${timeout / 1000} 秒），请检查网络或面板地址`);
    }
    if (err.expected) throw err;
    throw upstream(`${serviceName}请求失败：${err.message}`, { url });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { request };
