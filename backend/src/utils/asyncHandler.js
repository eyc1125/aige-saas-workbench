/**
 * 异步路由包装器
 * ------------------------------------------------------------------
 * Express 4 不会自动捕获 async 函数抛出的异常，
 * 用这个包装器把 Promise rejection 转交给全局错误中间件。
 */
'use strict';

module.exports = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
