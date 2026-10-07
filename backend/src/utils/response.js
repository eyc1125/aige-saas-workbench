/**
 * 统一响应格式
 * ------------------------------------------------------------------
 * 全站所有 REST 接口固定返回：{ code, message, data }
 *   code = 0    表示成功
 *   code != 0   表示失败，与 HTTP 状态码配合使用
 * MCP 工具的结果也复用同一结构（见 mcp/tools.js）。
 */
'use strict';

/** 成功响应 */
function success(res, data = null, message = 'ok') {
  return res.json({ code: 0, message, data });
}

/** 失败响应 */
function fail(res, message = '请求失败', code = 1, httpStatus = 400, detail = null) {
  const body = { code, message, data: null };
  if (detail) body.detail = detail;
  return res.status(httpStatus).json(body);
}

/** 分页响应：list 页统一格式 */
function paginated(res, list, total, page, pageSize) {
  return success(res, {
    list,
    total,
    page,
    pageSize,
    totalPages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
  });
}

module.exports = { success, fail, paginated };
