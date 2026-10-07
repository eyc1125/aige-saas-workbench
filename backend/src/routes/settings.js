/**
 * 系统设置路由
 * ------------------------------------------------------------------
 * GET  /api/settings                  读取全部配置（敏感项自动脱敏）
 * PUT  /api/settings                  保存配置（留空=不修改，__CLEAR__=清空）
 * POST /api/settings/test/:target     连通性测试（baota / cloudflare / docker）
 * GET  /api/settings/mcp              读取 MCP 连接信息（地址 + 令牌掩码 + 可用工具）
 * POST /api/settings/mcp/token        重新生成 MCP 连接令牌（仅此一次返回明文）
 * PUT  /api/settings/admin            修改管理员账号（用户名 / 昵称 / 密码）
 * GET  /api/settings/system           运行环境信息（版本、端口、部署方式）
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const { badRequest } = require('../utils/errors');
const { writeLog, clientIp } = require('../utils/logger');
const settings = require('../services/settings');
const baotaService = require('../services/baota');
const cloudflareService = require('../services/cloudflare');
const dockerService = require('../services/docker');
const { TOOL_DEFINITIONS } = require('../mcp/tools');
// 工具分组与总数统一由 mcp/instructions.js 提供（单一来源，避免两处各写一份数字）
const { SERVER_INSTRUCTIONS, TOOL_GROUPS, TOOL_COUNT, groupListText } = require('../mcp/instructions');

const router = express.Router();

/** 读取配置（脱敏） */
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    return success(res, {
      settings: settings.getForDisplay(),
      // 这些是只读的运行期信息，前端用于提示（如反向代理该指向哪个端口）
      runtime: {
        apiPort: config.port,
        mcpPort: config.mcpPort,
        env: config.env,
        staticServed: true,
      },
    });
  })
);

/** 保存配置 */
router.put(
  '/',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    // 只允许白名单内的 key 落库：防止非法配置项写入
    const allowed = Object.keys(settings.SCHEMA);
    const patch = {};
    Object.entries(body).forEach(([k, v]) => {
      if (allowed.includes(k)) patch[k] = v;
    });
    if (!Object.keys(patch).length) throw badRequest('没有可保存的配置项');

    const changed = settings.setMany(patch);

    writeLog({
      userId: req.user.id,
      username: req.user.username,
      module: 'settings',
      action: 'update_settings',
      source: 'web',
      status: 'success',
      // 只记录改动的 key，不记录值（敏感值绝不进日志）
      detail: { changedKeys: changed },
      ip: clientIp(req),
    });

    return success(res, { changed }, changed.length ? `已保存 ${changed.length} 项配置` : '配置未发生变化');
  })
);

/**
 * 连通性测试
 * :target = baota | cloudflare | docker
 * 测试用的配置以「本次请求体」优先（便于用户填完先测再保存）
 */
router.post(
  '/test/:target',
  asyncHandler(async (req, res) => {
    const target = req.params.target;
    const body = req.body || {};
    let result;

    if (target === 'baota') {
      const baseUrl = body.bt_panel_url || settings.get('bt_panel_url');
      const apiKey = body.bt_api_key || settings.get('bt_api_key');
      const allowInsecureTls =
        body.bt_allow_insecure_tls !== undefined
          ? String(body.bt_allow_insecure_tls).toLowerCase() === 'true'
          : String(settings.get('bt_allow_insecure_tls')).toLowerCase() === 'true';
      result = await new baotaService.BaotaClient({ baseUrl, apiKey, allowInsecureTls }).testConnection();
    } else if (target === 'cloudflare') {
      const apiToken = body.cf_api_token || settings.get('cf_api_token');
      result = await new cloudflareService.CloudflareClient({ apiToken }).testConnection();
    } else if (target === 'docker') {
      const host = body.docker_host || settings.get('docker_host');
      result = await new dockerService.DockerClient({ host }).testConnection();
    } else {
      throw badRequest(`不支持的测试目标：${target}`);
    }

    writeLog({
      userId: req.user.id,
      username: req.user.username,
      module: 'settings',
      action: `test_${target}`,
      target,
      source: 'web',
      status: result.ok ? 'success' : 'failed',
      message: result.message,
      ip: clientIp(req),
    });

    return success(res, result, result.message);
  })
);

/**
 * 解析对外访问地址
 * ------------------------------------------------------------------
 * 优先用环境变量里配好的正式域名（线上是 https 域名）；
 * 没配才退回「当前请求的 host + 端口」，这样本地开发也能得到一份可用配置。
 */
function resolvePublicUrl(configured, req, port) {
  if (configured) return String(configured).replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers.host || '127.0.0.1').split(':')[0];
  const isDefaultPort = (proto === 'https' && port === 443) || (proto === 'http' && port === 80);
  return `${proto}://${host}${isDefaultPort ? '' : `:${port}`}`;
}

/** MCP 连接信息 */
router.get(
  '/mcp',
  asyncHandler(async (req, res) => {
    // ⚠️ 没有令牌就当场生成一个。
    //    目的：界面上给出的配置必须「复制即可用」，绝不下发 `<尚未生成令牌>` 之类的占位符——
    //    否则使用者还得手动猜该填什么，等于配置是坏的。
    let token = settings.get('mcp_auth_token') || config.mcpAuthToken;
    if (!token) {
      token = crypto.randomBytes(24).toString('hex');
      settings.set('mcp_auth_token', token);
    }

    // ⚠️ 地址必须是外网可达的 https 域名。
    //    之前下发的是 `http://<内网IP>:3001/sse`，那个端口外网根本没开，粘到 AI 工具里必然连不上。
    const panelUrl = resolvePublicUrl(config.public.panelUrl, req, config.port);
    const mcpUrl = resolvePublicUrl(config.public.mcpUrl, req, config.mcpPort);

    // 这份结构 Trae / Cursor / Claude Desktop / Windsurf / VS Code 通用（远程 SSE 传输）
    const remoteConfig = {
      mcpServers: {
        'aige-workbench': {
          url: `${mcpUrl}/sse`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    };

    // 给「人类」看的一页纸：贴到任意 AI 工具里，对方立刻知道这是什么、该怎么用
    const quickstart = `# 艾哥 SaaS 工作台 · MCP 接入说明（复制即用）

## 一、把下面的 JSON 贴进 AI 工具的 MCP 配置
${JSON.stringify(remoteConfig, null, 2)}

Trae / Cursor / Claude Desktop / Windsurf / VS Code 用的是同一套结构；
保存后重启该工具，即可看到名为 aige-workbench 的 MCP 服务器（${TOOL_COUNT} 个工具）。

## 二、接上之后，直接说人话就行
- 「看看服务器现在什么状态」            → get_server_status
- 「体检一遍，有问题顺手修掉」           → run_health_checks + apply_health_fix
- 「帮我部署一个 n8n，域名 n8n.example.com」 → deploy_app
- 「给 xxx.com 加一条 A 记录指向本机」      → add_dns_record
- 「哪个网站的证书快过期了」               → list_ssl_certs
- 「xxx.com 打不开了，排查一下」           → get_site_logs + get_nginx_config
- 「网站改了内容访客还是旧版」             → purge_cloudflare_cache

## 三、能力范围
${groupListText()}

## 四、重要约定
1. **一个 MCP 就够**：不需要再单独挂「宝塔面板 MCP」或「Cloudflare MCP」——已全部覆盖，
   并且额外多了「一键部署应用」和「自愈巡检」。
2. **自愈有熔断**：同一修复动作 30 分钟内最多 3 次；被熔断说明问题没真正解决，该去看日志。
3. **危险操作会先确认**：删除站点、清缓存、改 Nginx 配置等，AI 应先说明影响范围。
4. **不碰无关项目**：服务器上还跑着其他项目，除非你明确要求，AI 不应操作它们。
5. 部署类操作（deploy_app）单次可能耗时几分钟，属正常现象。`;

    return success(res, {
      enabled: true,
      // 界面上仍只显示掩码（防肩窥）；明文只在「复制配置」时随配置一起给出
      tokenMasked: `${token.slice(0, 4)}${'*'.repeat(8)}${token.slice(-4)}`,
      sseUrl: `${mcpUrl}/sse`,
      messageUrl: `${mcpUrl}/messages`,
      healthUrl: `${mcpUrl}/health`,
      panelUrl,
      stdioCommand: 'node src/mcp/stdio.js',
      tools: TOOL_DEFINITIONS.map((t) => ({ name: t.name, description: t.description })),
      toolGroups: TOOL_GROUPS.map((g) => ({
        group: g.group,
        tools: g.tools
          .map((name) => TOOL_DEFINITIONS.find((t) => t.name === name))
          .filter(Boolean)
          .map((t) => ({ name: t.name, description: t.description })),
      })),
      // 这段文字同时是 MCP 客户端 initialize 时读到的说明，界面可直接展示/复制
      instructions: SERVER_INSTRUCTIONS,
      quickstart,
      templateUrl: {
        // 说明：直接带上真实令牌，是为了让「复制配置」按钮粘到 AI 工具里就能用。
        //      接口本身在管理员登录之后，界面上令牌仍以掩码展示，
        //      掩码的作用是防肩窥/防误传，不是防管理员本人。
        trae: remoteConfig,
        cursor: remoteConfig,
        claudeDesktop: remoteConfig,
      },
    });
  })
);

/** 重新生成 MCP 令牌（返回明文一次，请立刻保存到 AI 工具配置里） */
router.post(
  '/mcp/token',
  asyncHandler(async (req, res) => {
    const token = crypto.randomBytes(24).toString('hex');
    settings.set('mcp_auth_token', token);

    writeLog({
      userId: req.user.id,
      username: req.user.username,
      module: 'settings',
      action: 'regenerate_mcp_token',
      source: 'web',
      status: 'success',
      ip: clientIp(req),
    });

    return success(res, { token }, 'MCP 令牌已重新生成，请立即复制保存（离开本页后不再显示）');
  })
);

/** 修改管理员账号 */
router.put(
  '/admin',
  asyncHandler(async (req, res) => {
    const { username, nickname, password } = req.body || {};
    const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!me) throw badRequest('账号不存在');

    const updates = [];
    const params = [];

    if (username && String(username).trim() !== me.username) {
      const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(String(username).trim());
      if (exists) throw badRequest(`用户名已被占用：${username}`);
      updates.push('username = ?');
      params.push(String(username).trim());
    }
    if (nickname !== undefined) {
      updates.push('nickname = ?');
      params.push(String(nickname).trim());
    }
    if (password) {
      if (String(password).length < 6) throw badRequest('密码至少 6 位');
      updates.push('password = ?');
      params.push(bcrypt.hashSync(String(password), 10));
    }
    if (!updates.length) throw badRequest('没有需要修改的内容');

    params.push(me.id);
    db.prepare(`UPDATE users SET ${updates.join(', ')}, updated_at = datetime('now','localtime') WHERE id = ?`).run(...params);

    writeLog({
      userId: req.user.id,
      username: me.username,
      module: 'settings',
      action: 'update_admin',
      source: 'web',
      status: 'success',
      detail: { changed: updates.map((u) => u.split(' ')[0]) },
      ip: clientIp(req),
    });

    return success(res, { updated: true }, '账号信息已更新，若改了用户名或密码请重新登录');
  })
);

/** 运行环境信息 */
router.get(
  '/system',
  asyncHandler(async (_req, res) => {
    const dbFile = config.dbPath;
    return success(res, {
      nodeVersion: process.version,
      platform: `${process.platform} ${process.arch}`,
      apiPort: config.port,
      mcpPort: config.mcpPort,
      uptimeSeconds: Math.floor(process.uptime()),
      memoryUsageMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      dbPath: dbFile,
      deployMode: config.isProd ? 'Docker（生产）' : '本地开发',
      hostDataDir: settings.get('host_data_dir') || '未配置（使用 Docker 命名卷）',
      mcpEnabled: !!(settings.get('mcp_auth_token') || config.mcpAuthToken),
    });
  })
);

module.exports = router;
