/**
 * 操作日志记录器
 * ------------------------------------------------------------------
 * 所有「会改变状态」的操作（Web 点击、MCP 工具调用）都要落一条日志，
 * 前端「最近操作日志」和 MCP 排查都读这张表。
 * 写日志失败绝不能影响主流程，因此全部 try/catch 吞掉并只打印到控制台。
 *
 * ⛔ B6 审计 diff 的硬规则（写入方必须遵守）：
 *    `before` / `after` 用于回答「谁在什么时候把什么改成了什么」，
 *    **绝不能把密钥、令牌、Webhook 地址等敏感值的明文写进来**。
 *    配置类的敏感项请走 `settings.applyPatch()`，它在源头就把敏感值
 *    替换成「已设置 / 未设置」，调用方拿不到明文也就写不进去。
 */
'use strict';

const db = require('../db');

const insertLog = db.prepare(`
  INSERT INTO operation_logs
    (user_id, username, module, action, target, detail, before_value, after_value,
     source, status, message, ip, duration_ms)
  VALUES
    (@user_id, @username, @module, @action, @target, @detail, @before_value, @after_value,
     @source, @status, @message, @ip, @duration_ms)
`);

/** 对象 → JSON 字符串；字符串原样保留；空值 → null */
function toJson(value) {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * 写入一条操作日志
 * @param {object} entry
 * @param {number} [entry.userId]
 * @param {string} [entry.username]
 * @param {string} entry.module  模块：auth/dashboard/website/domain/docker/app/settings/mcp
 * @param {string} entry.action  动作，如 create_website
 * @param {string} [entry.target] 操作对象
 * @param {any}    [entry.detail] 详情（对象会被 JSON 序列化）
 * @param {any}    [entry.before] 改动前的值（B6；对象会按字段存 JSON）
 * @param {any}    [entry.after]  改动后的值（B6）
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
      detail: toJson(entry.detail),
      before_value: toJson(entry.before),
      after_value: toJson(entry.after),
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
 * 把日志行里的 before_value / after_value 从 JSON 字符串还原成对象（B6）
 * ------------------------------------------------------------------
 * 查询侧统一走这里，前端拿到的就是可直接渲染的「字段 → 值」对照。
 * 容错口径：能解析成对象就返回对象；是空值返回 null；其余原样返回字符串
 * （宁可让前端多一层类型判断，也不要因为一条脏数据让整个日志列表打不开）。
 */
function parseAuditFields(row) {
  if (!row) return row;
  const parse = (value) => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'object') return value;
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'object' ? parsed : value;
    } catch {
      return value;
    }
  };
  return { ...row, before_value: parse(row.before_value), after_value: parse(row.after_value) };
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

module.exports = { writeLog, clientIp, withLog, parseAuditFields };
