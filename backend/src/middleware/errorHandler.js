/**
 * 全局错误处理中间件
 * ------------------------------------------------------------------
 * 统一出口：所有异常都在这里转成 { code, message, data } 结构。
 * 区分对待：
 *   - AppError（预期内业务错误）→ 原样返回 message 与状态码
 *   - 其他未捕获异常 → 记详细日志，对外只给通用提示（不泄露堆栈）
 */
'use strict';

const { AppError } = require('../utils/errors');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  const isExpected = err instanceof AppError || err.expected === true;
  const status = isExpected ? err.status || 400 : 500;

  if (!isExpected) {
    console.error(`[error] ${req.method} ${req.originalUrl} 未捕获异常：`, err);
  } else if (status >= 500) {
    console.warn(`[error] ${req.method} ${req.originalUrl} → ${err.message}`);
  }

  const body = {
    code: isExpected ? err.code || 'BUSINESS_ERROR' : 'INTERNAL_ERROR',
    message: isExpected ? err.message : '服务器内部错误，请查看后端日志',
    data: null,
  };
  if (isExpected && err.detail) body.detail = err.detail;

  res.status(status).json(body);
}

/** 404 兜底：未匹配到任何路由 */
function notFoundHandler(req, res) {
  res.status(404).json({
    code: 'NOT_FOUND',
    message: `接口不存在：${req.method} ${req.originalUrl}`,
    data: null,
  });
}

module.exports = { errorHandler, notFoundHandler };
