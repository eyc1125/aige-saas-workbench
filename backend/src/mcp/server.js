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
 * 令牌分级（D2 · 只读令牌）：
 *   full     —— 全部工具
 *   readonly —— 只能调用 tools.js 里 READONLY_TOOLS 白名单内的工具
 *   判级别只看「令牌是什么」，不看客户端怎么说；两道门同时关：
 *     ① ListTools 只回只读工具（让 AI 一开始就知道自己的边界，不会白试）
 *     ② CallTool 命中写工具直接拒绝（①是建议，②才是强制；AI 完全可以硬调）
 *   ⚠️ sessionId 与级别绑定：拿只读令牌往「全权 session」发消息会被 403 拦下，
 *      否则知道 sessionId 就等于拿到全权（sessionId 可猜、可泄漏，不能当凭据用）。
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
const { TOOL_DEFINITIONS, callTool, READONLY_TOOLS } = require('./tools');
const { SERVER_INFO, SERVER_INSTRUCTIONS } = require('./instructions');

const SCOPE_FULL = 'full';
const SCOPE_READONLY = 'readonly';

/** 只读令牌能看到的工具清单（顺序与注册顺序一致，界面上不会跳来跳去） */
const READONLY_DEFINITIONS = TOOL_DEFINITIONS.filter((t) => READONLY_TOOLS.has(t.name));

/** 只读连接附加在说明书末尾的一段话（AI 读了就不会去试写操作） */
const READONLY_NOTICE = `

## ⛔ 当前连接使用「只读令牌」

你这次的令牌**只能查、不能改**：上面列出的写操作工具（新建/删除站点、改 DNS、
改 Nginx 配置、重启容器、部署应用、自愈修复、call_bt_api 等）都不在可用清单里，
即使调用也会被服务端拒绝。

遇到需要动手改的需求，**不要反复重试**，直接告诉使用者：
「这需要全权令牌，请到工作台『系统设置 → MCP 连接』复制全权配置，或由管理员代为执行。」`;

/**
 * 创建一个已注册好全部工具的 MCP Server 实例
 * @param {{ scope?: string }} [options] scope=readonly 时只暴露并只允许只读工具
 * @returns {Server}
 */
function createMcpServer({ scope = SCOPE_FULL } = {}) {
  const readonly = scope === SCOPE_READONLY;
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: readonly ? `${SERVER_INSTRUCTIONS}${READONLY_NOTICE}` : SERVER_INSTRUCTIONS,
  });

  // 工具清单：直接把 JSON Schema 交给客户端
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: readonly ? READONLY_DEFINITIONS : TOOL_DEFINITIONS,
  }));

  // 工具调用：统一返回 { success, data, message } 的 JSON 文本
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params || {};

    // 只读令牌的第二道门：白名单之外一律拒绝。
    // 用「返回失败的调用结果」而不是抛异常 —— 抛异常会让 SDK 断开连接，
    // 客户端看到的是「MCP 挂了」，而不是「这个工具你没权限」，排错方向会被带偏。
    if (readonly && !READONLY_TOOLS.has(name)) {
      const denied = {
        success: false,
        data: null,
        message:
          `只读令牌无权调用 ${name}（该工具会修改服务器或线上状态）。` +
          `当前只读令牌可用 ${READONLY_DEFINITIONS.length} 个只读工具列表见 ListTools；` +
          `确需执行请改用全权令牌，或让工作台管理员代为操作。`,
      };
      return {
        content: [{ type: 'text', text: `❌ ${denied.message}` }],
        structuredContent: denied,
        isError: true,
      };
    }

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

/** 当前有效令牌（数据库优先，其次 .env）；只读令牌只存在数据库里 */
function currentTokens() {
  return {
    full: settings.get('mcp_auth_token') || config.mcpAuthToken || '',
    readonly: settings.get('mcp_readonly_token') || '',
  };
}

/** 当前有效的 MCP 全权令牌（兼容旧调用方） */
function currentToken() {
  return currentTokens().full;
}

/** 从请求里取令牌（三种传法） */
function extractToken(req) {
  const header = req.headers.authorization || '';
  return (
    (header.startsWith('Bearer ') ? header.slice(7).trim() : '') ||
    String(req.headers['x-mcp-token'] || '') ||
    String(req.query.token || '')
  );
}

/**
 * 判断令牌属于哪个级别
 * @returns {'full'|'readonly'|null} null = 令牌无效
 */
function resolveScope(provided) {
  const { full, readonly } = currentTokens();
  if (full && provided === full) return SCOPE_FULL;
  if (readonly && provided === readonly) return SCOPE_READONLY;
  return null;
}

/** 令牌校验中间件：通过后把级别挂在 req.mcpScope 上 */
function authMiddleware(req, res, next) {
  const { full, readonly } = currentTokens();

  // 一把令牌都没配：放行但给出警告（方便本地首次调试）
  if (!full && !readonly) {
    console.warn('[mcp] ⚠️  未配置 MCP 令牌，当前允许匿名连接。请到「系统设置 → MCP」生成令牌。');
    req.mcpScope = SCOPE_FULL;
    return next();
  }

  const scope = resolveScope(extractToken(req));
  if (!scope) {
    return res.status(401).json({
      code: 'UNAUTHORIZED',
      message: 'MCP 令牌无效，请检查 Authorization: Bearer <token>',
      data: null,
    });
  }
  req.mcpScope = scope;
  return next();
}

/**
 * 启动 SSE 模式的 MCP 服务
 * @returns {Promise<import('http').Server>}
 */
async function startMcpServer() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  // 会话表：sessionId → { transport, scope }
  const sessions = new Map();

  app.get('/health', (_req, res) => {
    const { full, readonly } = currentTokens();
    res.json({
      code: 0,
      message: 'ok',
      data: {
        service: 'aige-workbench-mcp',
        transport: 'sse',
        sessions: sessions.size,
        tools: TOOL_DEFINITIONS.length,
        readonlyTools: READONLY_DEFINITIONS.length,
        authRequired: !!(full || readonly),
        readonlyTokenConfigured: !!readonly,
        uptime: Math.floor(process.uptime()),
      },
    });
  });

  // 建立 SSE 连接
  app.get('/sse', authMiddleware, async (req, res) => {
    const scope = req.mcpScope;
    const transport = new SSEServerTransport('/messages', res);
    sessions.set(transport.sessionId, { transport, scope });
    console.log(
      `[mcp] 新连接建立，session=${transport.sessionId}，级别=${scope}，当前会话数 ${sessions.size}`
    );

    res.on('close', () => {
      sessions.delete(transport.sessionId);
      console.log(`[mcp] 连接关闭，session=${transport.sessionId}，剩余会话数 ${sessions.size}`);
    });

    // 每个连接一个独立 Server 实例，级别在建连时就固化下来
    const server = createMcpServer({ scope });
    await server.connect(transport);
  });

  // 客户端回传消息
  app.post('/messages', authMiddleware, async (req, res) => {
    const sessionId = String(req.query.sessionId || '');
    const session = sessions.get(sessionId);
    if (!session) {
      return res.status(404).json({
        code: 'SESSION_NOT_FOUND',
        message: `会话不存在或已断开：${sessionId}。请重新连接 /sse。`,
        data: null,
      });
    }

    // 级别必须与建连时一致：否则拿只读令牌往全权 session 发消息就能提权
    if (session.scope !== req.mcpScope) {
      console.warn(
        `[mcp] ⚠️ 拒绝令牌级别不符的消息：session=${sessionId} 建连级别=${session.scope}，请求级别=${req.mcpScope}`
      );
      return res.status(403).json({
        code: 'SCOPE_MISMATCH',
        message: '令牌级别与当前连接不符，请在 AI 工具里统一使用同一把令牌。',
        data: null,
      });
    }

    try {
      await session.transport.handlePostMessage(req, res, req.body);
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
        `[mcp] SSE 服务已启动：http://0.0.0.0:${config.mcpPort}/sse` +
          `（共 ${TOOL_DEFINITIONS.length} 个工具，其中只读 ${READONLY_DEFINITIONS.length} 个）`
      );
      resolve(httpServer);
    });
  });
}

/**
 * 以 stdio 方式连接（供 src/mcp/stdio.js 使用）
 * 说明：stdio 是「本机进程直连」，能起这个进程的人本来就有服务器权限，
 *      所以不做令牌分级，始终按全权处理。
 */
async function attachStdio() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

module.exports = {
  createMcpServer,
  startMcpServer,
  attachStdio,
  TOOL_DEFINITIONS,
  READONLY_DEFINITIONS,
  currentToken,
  currentTokens,
  resolveScope,
  SCOPE_FULL,
  SCOPE_READONLY,
};
