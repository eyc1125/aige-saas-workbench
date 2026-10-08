/**
 * 全局错误处理中间件
 * ------------------------------------------------------------------
 * 统一出口：所有异常都在这里转成 { code, message, data } 结构。
 * 区分对待：
 *   - AppError（预期内业务错误）→ 原样返回 message 与状态码
 *   - body-parser 这类**请求本身有问题**的异常 → 按 4xx 返回真实原因
 *   - 其他未捕获异常 → 记详细日志，对外只给通用提示（不泄露堆栈）
 */
'use strict';

const { AppError } = require('../utils/errors');

/**
 * 判断是不是「客户端请求有问题」这一类框架异常
 * ------------------------------------------------------------------
 * 典型是 body-parser 在 JSON 语法错误时抛的：
 *   { type: 'entity.parse.failed', status: 400, statusCode: 400, expose: true }
 * 这类错误必须回 400 并说清原因。之前一律当 500 处理，
 * 结果调用方只看到「服务器内部错误，请查看后端日志」，
 * 明明是自己的请求体写坏了，却去后端日志里找 bug —— 排查方向被彻底带偏（真踩过）。
 *
 * 约束：只放行 4xx，且必须带 expose:true（express 用它标记「消息可以给用户看」）。
 * 5xx 的框架异常仍然按未捕获异常处理，避免把内部细节透出去。
 */
function isClientError(err) {
  const status = Number(err?.status || err?.statusCode);
  return Number.isInteger(status) && status >= 400 && status < 500 && err?.expose === true;
}

/**
 * body-parser 的报错是英文的，直接抛给前端等于没说
 * ------------------------------------------------------------------
 * 典型是上传安装包超过 `express.raw({ limit })` 时抛的：
 *   { type: 'entity.too.large', status: 413, expose: true, limit: 104857600 }
 * 前端看到 "request entity too large" 根本不知道该做什么，
 * 所以换成「多大上限 / 该怎么办」的中文。
 */
function friendlyMessage(err) {
  if (err?.type === 'entity.too.large') {
    const mb = err.limit ? Math.round(err.limit / 1024 / 1024) : null;
    return `请求体太大${mb ? `，上限 ${mb}MB` : ''}。请换更小的文件，或分次上传。`;
  }
  return err.message;
}

// Express 靠「4 个参数」识别错误处理中间件，_next 不能省（下划线前缀表示有意不用）
function errorHandler(err, req, res, _next) {
  const clientError = isClientError(err);
  const isExpected = err instanceof AppError || err.expected === true || clientError;
  const status = isExpected ? err.status || err.statusCode || 400 : 500;

  if (!isExpected) {
    console.error(`[error] ${req.method} ${req.originalUrl} 未捕获异常：`, err);
  } else if (status >= 500) {
    console.warn(`[error] ${req.method} ${req.originalUrl} → ${err.message}`);
  }

  const body = {
    code: isExpected
      ? err.code || (clientError ? 'INVALID_REQUEST' : 'BUSINESS_ERROR')
      : 'INTERNAL_ERROR',
    message: isExpected ? friendlyMessage(err) : '服务器内部错误，请查看后端日志',
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
