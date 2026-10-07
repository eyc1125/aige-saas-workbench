/**
 * 操作日志记录器
 * ------------------------------------------------------------------
 * 所有「会改变状态」的操作（Web 点击、MCP 工具调用）都要落一条日志，
 * 前端「最近操作日志」和 MCP 排查都读这张表。
 * 写日志失败绝不能影响主流程，因此全部 try/catch 吞掉并只打印到控制台。
 */
'use strict';

const db = require('../db');

const insertLog = db.prepare(`
  INSERT INTO operation_logs
    (user_id, username, module, action, target, detail, source, status, message, ip, duration_ms)
  VALUES
    (@user_id, @username, @module, @action, @target, @detail, @source, @status, @message, @ip, @duration_ms)
`);

/**
 * 写入一条操作日志
 * @param {object} entry
 * @param {number} [entry.userId]
 * @param {string} [entry.username]
 * @param {string} entry.module  模块：auth/dashboard/website/domain/docker/app/settings/mcp
 * @param {string} entry.action  动作，如 create_website
 * @param {string} [entry.target] 操作对象
 * @param {any}    [entry.detail] 详情（对象会被 JSON 序列化）
 * @param {string} [entry.source] web / mcp / system
 * @param {string} [entry.status] success / failed
 * @param {string} [entry.message]
 * @param {string} [entry.ip]
 * @param {number} [entry.durationMs]
 */
function writeLog(entry) {
  try {
    insertLog.run({
      user_id: entry.userId ?? null,
      username: entry.username ?? null,
      module: entry.module ?? 'system',
      action: entry.action ?? 'unknown',
      target: entry.target ?? null,
      detail: entry.detail === undefined || entry.detail === null
        ? null
        : typeof entry.detail === 'string'
          ? entry.detail
          : JSON.stringify(entry.detail),
      source: entry.source ?? 'web',
      status: entry.status ?? 'success',
      message: entry.message ?? null,
      ip: entry.ip ?? null,
      duration_ms: entry.durationMs ?? null,
    });
  } catch (err) {
    console.error('[logger] 写入操作日志失败：', err.message);
  }
}

/** 取客户端 IP（兼容宝塔 Nginx 反代后的 X-Forwarded-For） */
function clientIp(req) {
  if (!req) return null;
  const xff = req.headers?.['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

/**
 * 包一层「自动记录日志」的执行器，用于路由与 MCP 工具
 * 用法：await withLog(ctx, () => doSomething())
 * @param {object} ctx  { module, action, target, userId, username, source, ip }
 * @param {Function} fn 实际业务函数
 */
async function withLog(ctx, fn) {
  const start = Date.now();
  try {
    const data = await fn();
    writeLog({
      ...ctx,
      source: ctx.source ?? 'web',
      status: 'success',
      detail: ctx.detailOnSuccess ? undefined : ctx.detail,
      durationMs: Date.now() - start,
    });
    return data;
  } catch (err) {
    writeLog({
      ...ctx,
      source: ctx.source ?? 'web',
      status: 'failed',
      message: err.message,
      ip: ctx.ip,
      durationMs: Date.now() - start,
    });
    throw err;
  }
}

module.exports = { writeLog, clientIp, withLog };
