/**
 * 业务异常类
 * ------------------------------------------------------------------
 * 全局错误中间件依赖它区分「可预期的业务错误」与「未捕获的程序错误」：
 *   - AppError：返回真实 message 与对应 HTTP 状态码
 *   - 其他异常：对外统一返回 500 + 通用提示，细节只写日志，不泄露给前端
 */
'use strict';

class AppError extends Error {
  /**
   * @param {string} message 面向用户的错误信息（中文、可读）
   * @param {number} status  HTTP 状态码
   * @param {string} code    业务码，便于前端精确判断（如 INVALID_PARAM）
   * @param {object} detail  附加信息（会随响应返回，便于排错）
   */
  constructor(message, status = 400, code = 'BUSINESS_ERROR', detail = null) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.expected = true; // 标记为「预期内错误」
  }
}

/** 参数校验失败 */
const badRequest = (message = '请求参数有误', detail = null) =>
  new AppError(message, 400, 'INVALID_PARAM', detail);

/** 未登录 / 令牌失效 */
const unauthorized = (message = '登录已过期，请重新登录') =>
  new AppError(message, 401, 'UNAUTHORIZED');

/** 无权限 */
const forbidden = (message = '没有操作权限') => new AppError(message, 403, 'FORBIDDEN');

/** 资源不存在 */
const notFound = (message = '资源不存在') => new AppError(message, 404, 'NOT_FOUND');

/** 外部服务调用失败（宝塔 / Cloudflare / Docker） */
const upstream = (message = '外部接口调用失败', detail = null) =>
  new AppError(message, 502, 'UPSTREAM_ERROR', detail);

/** 尚未配置（例如还没填宝塔密钥） */
const notConfigured = (message = '功能尚未配置，请先到「系统设置」完成配置') =>
  new AppError(message, 428, 'NOT_CONFIGURED');

module.exports = {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  upstream,
  notConfigured,
};
