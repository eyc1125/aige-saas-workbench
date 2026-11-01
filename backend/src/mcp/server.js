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
const fileUpload = require('../services/fileUpload');
const hostExec = require('../services/hostExec');
const uploadTicket = require('./upload-ticket');
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

    const result = await callTool(name, args || {}, { scope });

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
   * 用法（**AI 全自动**）：先调 `get_upload_help`，它会返回一条**已内嵌一次性票据**的
   *   curl 命令，直接在本机终端执行即可 —— 全程不需要向任何人索要令牌。
   * 用法（人工 / 脚本，带令牌的老方式，仍然支持）：
   *   curl -X POST "https://<mcp 域名>/upload?fileName=app.apk" \
   *        -H "x-mcp-token: <全权令牌>" -H "Content-Type: application/octet-stream" \
   *        --data-binary @app.apk
   *
   * ⚠️ 令牌路径只认**全权**令牌；票据路径只由全权令牌签发，且 5 分钟有效、一次性、绑文件名。
   * ⚠️ 文件在内存里过一遍就转给蒲公英对象存储，**不落我们的盘**。
   */
  app.post(
    '/upload',
    // 两种鉴权，任一通过即可：
    //   ① **请求头全权令牌**（脚本 / 人工用；原有方式，完全向后兼容）
    //   ② **一次性上传票据**（AI 全自动用）—— 由 `get_upload_help` 签发、内嵌在 URL 里。
    //      票据专为「命令能被 AI 直接执行」而设：5 分钟有效、只能传签发时指定的那一个
    //      文件名、用后即废、且**反推不出主人令牌**。详见 mcp/upload-ticket.js
    (req, res, next) => {
      const ticket = String(req.query.ticket || '').trim();
      if (!ticket) return authMiddleware(req, res, next);
      try {
        req.uploadTicket = uploadTicket.verify(ticket, String(req.query.fileName || '').trim(), {
          kind: 'pgyer',
        });
        req.mcpScope = SCOPE_FULL; // 票据只由全权令牌签发，等价于全权
        return next();
      } catch (err) {
        return res.status(err.status || 401).json({
          code: err.code || 'BAD_UPLOAD_TICKET',
          message: err.message,
          data: null,
        });
      }
    },
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
      // 传完直接设为「最新版」—— 开发迭代时省掉一次单独调用
      const setNewest = ['1', 'true'].includes(String(req.query.setNewest || '').toLowerCase());
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
        // 票据用后即废 —— 放在**上传成功之后**：万一失败还能拿同一张重试，更实用
        if (req.uploadTicket) uploadTicket.consume(req.uploadTicket);

        // 顺手把下载页 / 二维码 / 版本号带回去，省掉调用方再查一次
        // （AI 少一次工具调用 = 少一次等待与出错机会）。拿不到不影响「上传已成功」。
        const detail = await pgyerService.latestDetailOf(result.appKey).catch(() => null);

        // 可选：顺手设为「最新版本」。失败**不影响**「上传已经成功」这件事，只如实报告
        let newestNote = '';
        if (setNewest && result.buildKey) {
          try {
            await pgyerService.setNewestBuild(result.buildKey, true);
            newestNote = '，已设为最新版本';
          } catch (e) {
            newestNote = `（自动设为最新版没成功：${e.message}；可稍后用 set_pgyer_newest_build 手动设）`;
          }
        }

        return res.json({
          code: 0,
          message: result.pending
            ? `安装包已上传，蒲公英还在解析，稍后刷新即可看到新版本${newestNote}`
            : `上传成功：${result.name} v${result.version}${newestNote}${
                detail && detail.downloadPage ? `；下载页 ${detail.downloadPage}` : ''
              }`,
          data: { ...result, ...(detail || {}), setNewestApplied: setNewest || false },
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

  /**
   * 通用文件上传入口（HTTP，给「有终端」的 AI / 脚本用）
   * ------------------------------------------------------------------
   * 与上面的 `/upload`（蒲公英专用，只认 .apk/.ipa/.hap）**分工明确**：
   *   · 想发内测包 → `/upload`（会直接进蒲公英并生成下载页）
   *   · 想放任何文件到服务器 → 这里（落盘到指定目录，返回绝对路径 + sha256）
   *
   * 用法（**AI 全自动**）：先调 `upload_file` 工具，它会返回一条**已内嵌一次性票据**的
   *   curl 命令；在本机终端执行即可，全程不需要向任何人索要令牌。
   * 用法（人工 / 脚本，带令牌）：直接带 `x-mcp-token` 头 POST 即可。
   *
   * ⛔ 用流式接收而不是 `express.raw()`：200MB 的包整块读进内存会顶爆容器，
   *    而流式写盘只占一个临时文件的位置，内存基本恒定。
   */
  app.post(
    '/upload-file',
    (req, res, next) => {
      const fileName = String(req.query.fileName || '').trim();
      const targetDir = String(req.query.targetDir || '').trim();
      // 只在调用方**明确带了** overwrite 时才参与票据比对 ——
      // 没带就说明「以票据里签的为准」，不能因为"默认 false"跟票据的 true 冲突而误拒。
      const hasOverwrite = req.query.overwrite !== undefined;
      const overwrite = ['1', 'true', 'yes'].includes(
        String(req.query.overwrite || '').toLowerCase()
      );

      const ticket = String(req.query.ticket || '').trim();
      if (!ticket) return authMiddleware(req, res, next);
      try {
        req.uploadTicket = uploadTicket.verify(ticket, fileName, {
          kind: 'file',
          dir: targetDir,
          ...(hasOverwrite ? { overwrite } : {}),
        });
        req.mcpScope = SCOPE_FULL; // 票据只由全权令牌签发，等价于全权
        return next();
      } catch (err) {
        return res.status(err.status || 401).json({
          code: err.code || 'BAD_UPLOAD_TICKET',
          message: err.message,
          data: null,
        });
      }
    },
    async (req, res) => {
      if (req.mcpScope !== SCOPE_FULL) {
        return res.status(403).json({
          code: 'FORBIDDEN',
          message: '上传会向服务器写文件，只读令牌不行，请改用全权令牌。',
          data: null,
        });
      }

      const fileName = String(req.query.fileName || req.headers['x-file-name'] || '').trim();
      // 目标目录 / 覆盖开关：URL 里省略时回落到**票据里签下的值**。
      // ⛔ 这样「拿到票据的人改不了落点」—— 票据签给哪个目录，就只能落到哪个目录。
      const targetDir = String(req.query.targetDir || req.uploadTicket?.d || '').trim();
      const overwrite = ['1', 'true', 'yes'].includes(
        String(req.query.overwrite ?? (req.uploadTicket?.o ? '1' : '')).toLowerCase()
      );

      const contentType = String(req.headers['content-type'] || '');
      if (/multipart\/form-data/i.test(contentType)) {
        return res.status(400).json({
          code: 'INVALID_CONTENT_TYPE',
          message:
            '不要用 multipart/form-data。请把文件的原始字节直接作为请求体（application/octet-stream），不是表单。',
          data: null,
        });
      }

      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > fileUpload.MAX_BYTES) {
        return res.status(413).json({
          code: 'FILE_TOO_LARGE',
          message: `文件超过单文件上限 ${fileUpload.MAX_MB}MB（本次 ${Math.round(
            declared / 1024 / 1024
          )}MB）。可换更小的包，或用环境变量 UPLOAD_MAX_MB 调大上限。`,
          data: null,
        });
      }

      try {
        const result = await fileUpload.saveStream(req, { fileName, targetDir, overwrite });
        // 票据用后即废 —— 放在**上传成功之后**：失败还能拿同一张重试，更实用
        if (req.uploadTicket) uploadTicket.consume(req.uploadTicket);
        return res.json({
          code: 0,
          message: `已保存到 ${result.path}（${result.size} 字节，sha256 ${result.sha256.slice(
            0,
            16
          )}…${result.overwritten ? '，已覆盖原文件' : ''}${
            result.zipNormalized ? '，已修正 Windows zip 的路径分隔符' : ''
          }）`,
          data: result,
        });
      } catch (err) {
        return res.status(err.status || 500).json({
          code: err.code || 'ERROR',
          message: err.message,
          data: err.detail || null,
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

  // 启动自检：两个新能力的"地基"是否到位。
  //   · 上传根没挂到宿主机 → 上传会写进容器内层，宿主机上找不到文件（必须喊出来）
  //   · 宿主机执行要挑一个带 nsenter 的运行时镜像（不 await：拉镜像可能慢，不能拖住启动）
  fileUpload.selfCheck();
  hostExec.warmUp();

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
