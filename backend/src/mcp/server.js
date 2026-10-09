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
 * 认证：请求头带 MCP 令牌，两种写法任选：
 *        Authorization: Bearer <token>
 *        x-mcp-token: <token>
 *      ⛔ 不支持 `?token=`（URL 查询参数）—— 原因见下方 extractToken 上的注释，
 *         一句话：SSE 客户端只在建连时用 URL，后面每次调工具都不会带上它，
 *         支持它等于提供一个「能连上但一用就 401」的半坏路径。
 *
 * 长连接保活：每 25 秒发一次 SSE 心跳（`:` 注释行）。
 *      ⛔ 这个必须有：服务经 Cloudflare 橙色云对外，**CF 免费版对空闲连接约 100 秒就断**，
 *         而 SSE 只在调用工具时才发数据 —— 不心跳的话，AI 停一会儿连接就被掐掉。
 *      同时限制同时会话数（20）并按 15 分钟空闲清理僵尸会话。
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
const pgyerService = require('../services/pgyer');
const { TOOL_DEFINITIONS, callTool, READONLY_TOOLS } = require('./tools');
const { SERVER_INFO, SERVER_INSTRUCTIONS } = require('./instructions');

const SCOPE_FULL = 'full';
const SCOPE_READONLY = 'readonly';

/**
 * SSE 心跳间隔：25 秒
 * ------------------------------------------------------------------
 * ⛔ 为什么这个必须有：这个 MCP 是通过 `https://aige-saas-mcp.miaocaieyc.com.cn`
 *    （Cloudflare 橙色云）对外暴露的，而 **Cloudflare 免费版对空闲连接约 100 秒就断**。
 *    我们的 SSE 只有在「调用工具」时才会发数据 —— 也就是说，AI 一旦停下来思考
 *    一分多钟，连接就会被中间链路掐掉，客户端看到的是「MCP 断了」。
 *    25 秒一次定时写注释行，既刷新链路的空闲计时，又能顺手发现已经死掉的连接。
 */
const SSE_HEARTBEAT_MS = 25 * 1000;

/** 同时最多几个 MCP 会话（正常一个人也就 1~3 个客户端；上限是防泄漏，不是限流） */
const MAX_SESSIONS = 20;

/** 多久没收到客户端任何消息就算「僵尸会话」（客户端异常退出时 close 事件可能不来） */
const SESSION_IDLE_MS = 15 * 60 * 1000;

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

/**
 * 从请求里取令牌
 * ------------------------------------------------------------------
 * ⛔ **刻意不支持 `?token=`（URL 查询参数）**，这是踩过之后去掉的：
 *    SSE 客户端只在**建连那一次**用到 URL，后续每个工具调用都是 POST 到
 *    服务端下发的 `/messages?sessionId=...`，**那个 URL 里不带我们给的 token** ——
 *    结果就是「连接显示成功、但每次调工具都 401」，最难查的一种半坏状态。
 *    而请求头（Authorization / x-mcp-token）会被客户端**原样带到每一次 POST**，所以只认头。
 *    真要在终端里调试，用：curl -H "x-mcp-token: <token>" ...
 */
function extractToken(req) {
  const header = req.headers.authorization || '';
  return (
    (header.startsWith('Bearer ') ? header.slice(7).trim() : '') ||
    String(req.headers['x-mcp-token'] || '')
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
      message:
        'MCP 令牌无效或没带上。令牌要放在**请求头**里（`Authorization: Bearer <token>` 或 `x-mcp-token: <token>`），' +
        '**不要放在 URL 的 ?token= 里** —— SSE 客户端只在建连时用到 URL，后面每次调工具都不会带上它。' +
        '配置请直接从「系统设置 → MCP 连接」复制。',
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

  // 会话表：sessionId → { transport, scope, lastSeenAt }
  const sessions = new Map();

  /** 关闭并移除一个会话（幂等；连接可能已经自己断了） */
  function dropSession(sessionId, why) {
    const s = sessions.get(sessionId);
    if (!s) return;
    sessions.delete(sessionId);
    try {
      s.transport.close?.();
    } catch {
      /* 已经断了，忽略 */
    }
    console.log(`[mcp] 会话 ${sessionId} 已清理（${why}），剩余 ${sessions.size}`);
  }

  /**
   * SSE 心跳 + 僵尸会话清理（一个定时器干两件事）
   * 客户端会忽略 `:` 开头的注释行，但它确实是一条数据 —— 中间链路（Cloudflare / Nginx）
   * 的空闲计时因此被刷新，长连接就不会被静默掐断。
   */
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastSeenAt > SESSION_IDLE_MS) {
        dropSession(id, '空闲超时');
        continue;
      }
      try {
        s.transport.res?.write(': keep-alive\n\n');
      } catch {
        dropSession(id, '写入失败（连接已断）');
      }
    }
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref?.();

  app.get('/health', (_req, res) => {
    const { full, readonly } = currentTokens();
    res.json({
      code: 0,
      message: 'ok',
      data: {
        service: 'aige-workbench-mcp',
        transport: 'sse',
        sessions: sessions.size,
        maxSessions: MAX_SESSIONS,
        heartbeatSeconds: SSE_HEARTBEAT_MS / 1000,
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
    // 会话上限：防「客户端异常退出、close 事件没来」导致的会话泄漏
    if (sessions.size >= MAX_SESSIONS) {
      console.warn(`[mcp] ⚠️ 会话数已达上限 ${MAX_SESSIONS}，拒绝新连接`);
      return res.status(503).json({
        code: 'TOO_MANY_SESSIONS',
        message: `同时连接的 MCP 客户端已达上限（${MAX_SESSIONS} 个）。请先关掉不用的客户端，稍等片刻再连（空闲会话 15 分钟后会自动清理）。`,
        data: { sessions: sessions.size },
      });
    }

    const scope = req.mcpScope;
    const transport = new SSEServerTransport('/messages', res);
    sessions.set(transport.sessionId, { transport, scope, lastSeenAt: Date.now() });
    console.log(
      `[mcp] 新连接建立，session=${transport.sessionId}，级别=${scope}，当前会话数 ${sessions.size}`
    );

    res.on('close', () => dropSession(transport.sessionId, '客户端断开'));

    // 每个连接一个独立 Server 实例，级别在建连时就固化下来
    const server = createMcpServer({ scope });
    await server.connect(transport);
    return undefined;
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

    // 有消息往来 = 这个会话还活着，刷新空闲计时
    session.lastSeenAt = Date.now();

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

  /**
   * 安装包上传入口（HTTP，给「有终端」的 AI / 脚本用）
   * ------------------------------------------------------------------
   * ⛔ 为什么开在 MCP 服务上，而不是复用面板的 `/api/distribute/upload`：
   *    面板那个接口要**面板登录态**（JWT），而 AI 手上只有 MCP 令牌 —— 它拿不到面板 JWT，
   *    于是「把本机这个 APK 发到蒲公英」这件事在 MCP 侧就是断的。
   *    MCP 令牌本来就能调 `call_bt_api` 做任意服务器操作，所以把上传开在这里**没有放宽信任边界**。
   *
   * 用法（本机打包完，一条命令发走）：
   *   curl -X POST "https://<mcp 域名>/upload?fileName=app.apk" \
   *        -H "x-mcp-token: <全权令牌>" -H "Content-Type: application/octet-stream" \
   *        --data-binary @app.apk
   *
   * ⚠️ 只认**全权**令牌：上传会改变线上分发的版本，只读令牌一律 403。
   * ⚠️ 文件在内存里过一遍就转给蒲公英对象存储，**不落我们的盘**。
   */
  app.post(
    '/upload',
    authMiddleware,
    express.raw({
      type: () => true,
      limit: `${Math.ceil(pgyerService.MAX_UPLOAD_BYTES / 1024 / 1024)}mb`,
    }),
    async (req, res) => {
      if (req.mcpScope !== SCOPE_FULL) {
        return res.status(403).json({
          code: 'FORBIDDEN',
          message: '上传会改变线上分发的版本，只读令牌不行，请改用全权令牌。',
          data: null,
        });
      }

      const fileName = String(req.query.fileName || req.headers['x-file-name'] || '').trim();
      const updateDescription = String(req.query.updateDescription || '').trim();
      const buffer = req.body;

      if (!Buffer.isBuffer(buffer) || !buffer.length) {
        return res.status(400).json({
          code: 'EMPTY_BODY',
          message:
            '没有收到文件内容。请以 application/octet-stream 把文件直接作为请求体发送（不要用 multipart/form-data）。',
          data: null,
        });
      }

      try {
        const result = await pgyerService.uploadApp(buffer, fileName, { updateDescription });
        return res.json({
          code: 0,
          message: result.pending
            ? '安装包已上传，蒲公英还在解析，稍后刷新即可看到新版本'
            : `上传成功：${result.name} v${result.version}`,
          data: result,
        });
      } catch (err) {
        return res.status(err.status || 500).json({
          code: err.code || 'ERROR',
          message: err.message,
          data: null,
        });
      }
    }
  );

  // 兜底错误处理：让任何异常都以 JSON 回去，而不是 Express 默认的 HTML 错误页
  // （客户端拿到 HTML 时只会说「返回了非 JSON」，排查方向会被带偏）
  app.use((err, _req, res, _next) => {
    const tooLarge = err?.type === 'entity.too.large';
    const limitMb = err?.limit ? Math.round(err.limit / 1024 / 1024) : null;
    console.error('[mcp] 请求处理失败：', err?.message);
    if (res.headersSent) return;
    res.status(tooLarge ? 413 : err?.status || 500).json({
      code: tooLarge ? 'ENTITY_TOO_LARGE' : err?.code || 'INTERNAL_ERROR',
      message: tooLarge
        ? `请求体太大${limitMb ? `，上限 ${limitMb}MB` : ''}。请换更小的安装包。`
        : err?.message || '服务器内部错误',
      data: null,
    });
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
