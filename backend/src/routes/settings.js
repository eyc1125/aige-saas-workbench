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
const githubService = require('../services/github');
const pgyerService = require('../services/pgyer');
const { TOOL_DEFINITIONS } = require('../mcp/tools');
// 只读工具清单由 mcp/server.js 推导（与真正生效的鉴权用同一份，避免两边不一致）
const { READONLY_DEFINITIONS } = require('../mcp/server');
// 工具分组与总数统一由 mcp/instructions.js 提供（单一来源，避免两处各写一份数字）
const {
  SERVER_INSTRUCTIONS,
  TOOL_GROUPS,
  TOOL_COUNT,
  groupListText,
} = require('../mcp/instructions');

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

/** 把改动明细压成 { 字段: 值 }，供审计日志的 before / after 两列存放（B6） */
function changeValues(changes, side) {
  return Object.fromEntries(changes.map((c) => [c.key, c[side]]));
}

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

    // applyPatch 返回字段级改动明细；敏感项在那一层就已脱敏成「已设置/未设置」
    const changes = settings.applyPatch(patch);

    // 动了代码仓库的配置就清一次 GitHub 缓存：否则改完令牌/仓库名之后的 60 秒里，
    // 页面还是旧数据，用户会以为「改了没用」
    if (changes.some((c) => c.key.startsWith('github_'))) githubService.clearCache();
    // 蒲公英同理：换了 API Key 之后必须立刻重新请求，否则旧 Key 的错误/结果会被缓存住
    if (changes.some((c) => c.key.startsWith('pgyer_'))) pgyerService.clearCache();

    // 没有任何实际改动就不写日志 —— 「点了一次保存但什么都没改」不值得留痕，
    // 否则审计日志会被这种空记录刷满，真正要查的那条反而被埋掉。
    if (changes.length) {
      writeLog({
        userId: req.user.id,
        username: req.user.username,
        module: 'settings',
        action: 'update_settings',
        source: 'web',
        status: 'success',
        // detail 只放改动的字段名；值走 before / after（B6 审计 diff）
        detail: { changedKeys: changes.map((c) => c.key) },
        before: changeValues(changes, 'before'),
        after: changeValues(changes, 'after'),
        ip: clientIp(req),
      });
    }

    return success(
      res,
      { changed: changes.map((c) => c.key) },
      changes.length ? `已保存 ${changes.length} 项配置` : '配置未发生变化'
    );
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
      result = await new baotaService.BaotaClient({
        baseUrl,
        apiKey,
        allowInsecureTls,
      }).testConnection();
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
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http')
    .split(',')[0]
    .trim();
  const host = String(req.headers.host || '127.0.0.1').split(':')[0];
  const isDefaultPort = (proto === 'https' && port === 443) || (proto === 'http' && port === 80);
  return `${proto}://${host}${isDefaultPort ? '' : `:${port}`}`;
}

/** 令牌统一掩码（界面上只露头尾各 4 位，防肩窥；不是防管理员本人） */
function maskToken(token) {
  if (!token) return '';
  return `${token.slice(0, 4)}${'*'.repeat(8)}${token.slice(-4)}`;
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

    // ---------------- 只读令牌（D2） ----------------
    // ⚠️ 这里**不自动生成**：全权令牌是「没有就当场生成」，因为界面给出的配置必须复制即用；
    //    只读令牌不同 —— 没生成就是「不存在这把凭据」，凭空造一把出来等于多一个出入口。
    //    使用者点「生成只读令牌」时才创建。
    const readonlyToken = settings.get('mcp_readonly_token') || '';
    const readonlyConfig = readonlyToken
      ? {
          mcpServers: {
            // 名字带 -readonly，同一个 AI 工具里可以两把并存、一眼分清谁是谁
            'aige-workbench-readonly': {
              url: `${mcpUrl}/sse`,
              headers: { Authorization: `Bearer ${readonlyToken}` },
            },
          },
        }
      : null;

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
2. **一个 MCP 全包**：宝塔 / Cloudflare / **蒲公英** 都不用再单独接。
   蒲公英的**上传**由本工作台承担 —— 网页「应用分发」页可以直接拖安装包，
   AI 也可以在本机用 \`POST /api/distribute/upload\` 把文件直接推上来
   （安装包只在内存里过一遍，**不会留在本工作台服务器上**）。
3. **只有 GitHub 是纯只读**：能看提交与 CI 状态，不能建 Issue / 提 PR / 重跑 CI。
4. **碰不到你本机的文件**：MCP 工具都跑在服务器上，读文件读的是服务器上的路径。
5. **自愈有熔断**：同一修复动作 30 分钟内最多 3 次；被熔断说明问题没真正解决，该去看日志。
6. **危险操作会先确认**：删除站点、清缓存、改 Nginx 配置等，AI 应先说明影响范围。
7. **不碰无关项目**：服务器上还跑着其他项目，除非你明确要求，AI 不应操作它们。
8. 部署类操作（deploy_app）单次可能耗时几分钟，属正常现象。`;

    return success(res, {
      enabled: true,
      // 界面上仍只显示掩码（防肩窥）；明文只在「复制配置」时随配置一起给出
      tokenMasked: maskToken(token),
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
      // ---------------- 只读令牌（D2） ----------------
      readonly: {
        configured: !!readonlyToken,
        tokenMasked: maskToken(readonlyToken),
        toolCount: READONLY_DEFINITIONS.length,
        totalCount: TOOL_DEFINITIONS.length,
        // 只读令牌能用的工具（前端用来把边界摊开给使用者看，而不是只写一句"只读"）
        toolGroups: TOOL_GROUPS.map((g) => ({
          group: g.group,
          tools: g.tools
            .filter((name) => READONLY_DEFINITIONS.some((d) => d.name === name))
            .map((name) => TOOL_DEFINITIONS.find((t) => t.name === name))
            .filter(Boolean)
            .map((t) => ({ name: t.name, description: t.description })),
        })).filter((g) => g.tools.length),
        config: readonlyConfig,
      },
    });
  })
);

/**
 * 生成 / 吊销 MCP 令牌
 * ------------------------------------------------------------------
 * body: { scope: 'full' | 'readonly'（默认 full）, revoke?: boolean }
 *   full     —— 只能重新生成（它没有"不存在"这个状态：库里没有就回退 .env，清了也是回退）
 *   readonly —— 可生成，也可吊销（吊销后那把只读令牌立即失效，全权令牌不受影响）
 * 两者返回明文都仅此一次，请立刻复制到 AI 工具配置里。
 */
router.post(
  '/mcp/token',
  asyncHandler(async (req, res) => {
    const { scope = 'full', revoke = false } = req.body || {};
    const isReadonly = String(scope).toLowerCase() === 'readonly';
    const key = isReadonly ? 'mcp_readonly_token' : 'mcp_auth_token';

    if (revoke && !isReadonly) {
      throw badRequest('全权令牌不支持吊销，只能重新生成');
    }

    if (revoke) {
      settings.set(key, '__CLEAR__');
      writeLog({
        userId: req.user.id,
        username: req.user.username,
        module: 'settings',
        action: 'revoke_mcp_readonly_token',
        source: 'web',
        status: 'success',
        ip: clientIp(req),
      });
      return success(
        res,
        { scope: 'readonly', revoked: true },
        '只读令牌已吊销，原令牌立即失效（全权令牌不受影响）'
      );
    }

    const token = crypto.randomBytes(24).toString('hex');
    settings.set(key, token);

    writeLog({
      userId: req.user.id,
      username: req.user.username,
      module: 'settings',
      action: isReadonly ? 'regenerate_mcp_readonly_token' : 'regenerate_mcp_token',
      source: 'web',
      status: 'success',
      ip: clientIp(req),
    });

    return success(
      res,
      { token, scope: isReadonly ? 'readonly' : 'full' },
      isReadonly
        ? '只读令牌已生成，请立即复制保存（离开本页后不再显示）'
        : 'MCP 令牌已重新生成，请立即复制保存（离开本页后不再显示）'
    );
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
      const exists = db
        .prepare('SELECT id FROM users WHERE username = ?')
        .get(String(username).trim());
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
    db.prepare(
      `UPDATE users SET ${updates.join(', ')}, updated_at = datetime('now','localtime') WHERE id = ?`
    ).run(...params);

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
