/**
 * MCP Server 实现
 * ------------------------------------------------------------------
 * 使用官方 @modelcontextprotocol/sdk，提供两种传输方式：
 *   1. stdio —— 本地 AI 工具直连（见 src/mcp/stdio.js）
 *   2. SSE   —— 远程连接，独立端口（默认 3001）
 *        GET  /sse       建立事件流（MCP 客户端连接入口）
 *        POST /messages  客户端回传消息（sessionId 区分连接）
 *        GET  /health    健康检查
 *
 * 认证：请求需带 MCP 令牌，支持三种传法（哪个顺手用哪个）：
 *        Authorization: Bearer <token>
 *        x-mcp-token: <token>
 *        ?token=<token>
 *
 * 实现说明：SSE 模式下每个连接都需要独立的 Server 实例（SDK 限制：一个
 *          Server 只能绑定一个 Transport），所以这里用工厂函数按连接创建。
 */
'use strict';

const express = require('express');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const config = require('../config');
const settings = require('../services/settings');
const { TOOL_DEFINITIONS, callTool } = require('./tools');
const { SERVER_INFO, SERVER_INSTRUCTIONS } = require('./instructions');

/**
 * 创建一个已注册好全部工具的 MCP Server 实例
 * @returns {Server}
 */
function createMcpServer() {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: SERVER_INSTRUCTIONS,
  });

  // 工具清单：直接把 JSON Schema 交给客户端
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

  // 工具调用：统一返回 { success, data, message } 的 JSON 文本
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params || {};
    const result = await callTool(name, args || {});

    return {
      content: [
        {
          type: 'text',
          // 同时给一句人类可读的 message 和完整结构化数据，AI 与人都能看
          text: `${result.success ? '✅' : '❌'} ${result.message}\n\n${JSON.stringify(result, null, 2)}`,
        },
      ],
      structuredContent: result,
      isError: !result.success,
    };
  });

  // 捕获连接级错误，避免单个客户端异常影响整个服务
  server.onerror = (err) => console.error('[mcp] 连接异常：', err.message);

  return server;
}

/** 当前有效的 MCP 令牌（数据库优先，其次 .env） */
function currentToken() {
  return settings.get('mcp_auth_token') || config.mcpAuthToken || '';
}

/** 令牌校验中间件 */
function authMiddleware(req, res, next) {
  const token = currentToken();

  // 未配置令牌：放行但给出警告（方便本地首次调试）
  if (!token) {
    console.warn('[mcp] ⚠️  未配置 MCP 令牌，当前允许匿名连接。请到「系统设置 → MCP」生成令牌。');
    return next();
  }

  const header = req.headers.authorization || '';
  const provided =
    (header.startsWith('Bearer ') ? header.slice(7).trim() : '') ||
    String(req.headers['x-mcp-token'] || '') ||
    String(req.query.token || '');

  if (provided !== token) {
    return res.status(401).json({
      code: 'UNAUTHORIZED',
      message: 'MCP 令牌无效，请检查 Authorization: Bearer <token>',
      data: null,
    });
  }
  return next();
}

/**
 * 启动 SSE 模式的 MCP 服务
 * @returns {Promise<import('http').Server>}
 */
async function startMcpServer() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  // 会话表：sessionId → transport
  const transports = new Map();

  app.get('/health', (_req, res) => {
    res.json({
      code: 0,
      message: 'ok',
      data: {
        service: 'aige-workbench-mcp',
        transport: 'sse',
        sessions: transports.size,
        tools: TOOL_DEFINITIONS.length,
        authRequired: !!currentToken(),
        uptime: Math.floor(process.uptime()),
      },
    });
  });

  // 建立 SSE 连接
  app.get('/sse', authMiddleware, async (req, res) => {
    const transport = new SSEServerTransport('/messages', res);
    transports.set(transport.sessionId, transport);
    console.log(`[mcp] 新连接建立，session=${transport.sessionId}，当前会话数 ${transports.size}`);

    res.on('close', () => {
      transports.delete(transport.sessionId);
      console.log(`[mcp] 连接关闭，session=${transport.sessionId}，剩余会话数 ${transports.size}`);
    });

    // 每个连接一个独立 Server 实例
    const server = createMcpServer();
    await server.connect(transport);
  });

  // 客户端回传消息
  app.post('/messages', authMiddleware, async (req, res) => {
    const sessionId = String(req.query.sessionId || '');
    const transport = transports.get(sessionId);
    if (!transport) {
      return res.status(404).json({
        code: 'SESSION_NOT_FOUND',
        message: `会话不存在或已断开：${sessionId}。请重新连接 /sse。`,
        data: null,
      });
    }
    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (err) {
      console.error('[mcp] 处理消息失败：', err.message);
      if (!res.headersSent) {
        res.status(500).json({ code: 'INTERNAL_ERROR', message: err.message, data: null });
      }
    }
    return undefined;
  });

  return new Promise((resolve) => {
    const httpServer = app.listen(config.mcpPort, '0.0.0.0', () => {
      console.log(
        `[mcp] SSE 服务已启动：http://0.0.0.0:${config.mcpPort}/sse（共 ${TOOL_DEFINITIONS.length} 个工具）`
      );
      resolve(httpServer);
    });
  });
}

/**
 * 以 stdio 方式连接（供 src/mcp/stdio.js 使用）
 */
async function attachStdio() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

module.exports = { createMcpServer, startMcpServer, attachStdio, TOOL_DEFINITIONS, currentToken };
