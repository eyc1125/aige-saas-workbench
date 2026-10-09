/**
 * MCP 工具定义与实现
 * ------------------------------------------------------------------
 * 需求要求的 13 个工具全部在这里注册。
 * 每个工具统一：
 *   - 有 name / description / inputSchema（标准 JSON Schema）
 *   - 返回结构化结果 { success, data, message }
 *   - 无论成功失败都写一条操作日志（source = mcp）
 *
 * 设计取舍：工具名与参数严格按需求文档命名，方便 AI 直接按语义调用；
 *          在需求之外做了两处「更好用」的兼容（不破坏原参数）：
 *            · add_dns_record 的 zone_id 可省略 —— 只给 name 会自动定位 zone
 *            · deploy_app 默认等待部署完成（可关）—— 否则 AI 只能拿到任务号却不知结果
 */
'use strict';

const baotaService = require('../services/baota');
const cloudflareService = require('../services/cloudflare');
const dockerService = require('../services/docker');
const deployService = require('../services/deploy');
const healthService = require('../services/health');
const githubService = require('../services/github');
const pgyerService = require('../services/pgyer');
const { listTemplates } = require('../services/apps');
const { writeLog } = require('../utils/logger');

/**
 * MCP 对外公网地址 —— `/upload` 端点就在它下面。
 * ⛔ 没有它，`get_upload_help` 就给不出「可直接复制执行」的命令：
 *    客户端那边（AI）根本拿不到端点地址，这正是「本机 APK 传不上去」的一半原因。
 * 可用环境变量覆盖，换域名部署时不用改代码。
 */
const MCP_PUBLIC_BASE = String(
  process.env.MCP_PUBLIC_URL || 'https://aige-saas-mcp.miaocaieyc.com.cn'
).replace(/\/+$/, '');

/**
 * 源站 IP —— 给 `get_upload_help` 生成「直连源站」命令用（跳过 Cloudflare）。
 * ⛔ 为什么必须有：**Cloudflare 免费版对单次请求有 100 秒上限**。上行慢的时候，
 *    十几 MB 的安装包根本传不完就被掐断，现象是 `curl: (35) Connection was reset`，
 *    而且**源站日志里什么都没有**（请求压根没到）—— 极难查。
 *    实测同一个 17MB 的 APK：直连源站 **59 秒成功**，走 Cloudflare 则 **240 秒仍未传完**。
 * 环境变量可覆盖；为空时 `get_upload_help` 就只给走域名的那条命令。
 */
const MCP_ORIGIN_IP = String(process.env.MCP_ORIGIN_IP || '120.53.102.56').trim();

// ============================================================
// 工具定义（JSON Schema）
// ============================================================

const TOOL_DEFINITIONS = [
  {
    name: 'get_server_status',
    description:
      '获取服务器实时状态：CPU 使用率、内存使用率与容量、磁盘使用率、系统负载、系统版本，以及网站/域名/容器数量统计。用于巡检、告警判断和汇报服务器健康状况。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'list_websites',
    description:
      '获取宝塔面板中所有网站列表，包含域名、站点目录、运行状态、PHP 版本、备注与创建时间。支持关键词搜索与分页。',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: '搜索关键词，匹配域名或备注，可省略' },
        page: { type: 'number', description: '页码，默认 1' },
        limit: { type: 'number', description: '每页条数，默认 200（AI 场景通常需要一次看全）' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'create_website',
    description:
      '在宝塔中一键新建网站（默认创建纯静态站点）。会自动查重：若同名网站已存在则直接返回失败，不会覆盖。创建成功后网站目录默认为 /www/wwwroot/<域名>。',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: '网站主域名，例如 demo.example.com' },
        path: { type: 'string', description: '网站目录，可省略，默认 /www/wwwroot/<域名>' },
        ps: { type: 'string', description: '备注说明，可省略' },
      },
      required: ['domain'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_website',
    description:
      '删除宝塔中指定域名的网站。⚠️ 危险操作：会一并删除该站点的网站目录。仅删除站点与目录，不会动数据库和 FTP 账号。执行前会先确认站点存在。',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: '要删除的网站域名（站点名）' },
      },
      required: ['domain'],
      additionalProperties: false,
    },
  },
  {
    name: 'apply_ssl',
    description:
      "为指定网站申请或部署 SSL 证书。mode=letsencrypt（默认）时调用宝塔自动申请 Let's Encrypt 免费证书；mode=manual 时需要额外传入证书与私钥内容。",
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: '网站域名（站点名）' },
        mode: {
          type: 'string',
          enum: ['letsencrypt', 'manual'],
          description: '申请方式，默认 letsencrypt',
        },
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: '证书需要覆盖的域名列表，可省略（默认使用网站自身域名）',
        },
        cert: { type: 'string', description: 'mode=manual 时的证书内容（PEM）' },
        key: { type: 'string', description: 'mode=manual 时的私钥内容（PEM）' },
      },
      required: ['domain'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_domains',
    description:
      '获取 Cloudflare 账号下所有域名区域（zone）列表，包含 zone_id、域名、状态、套餐类型。后续操作 DNS 解析需要用到 zone_id。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'list_dns_records',
    description:
      '获取某个域名区域下的全部 DNS 解析记录。可传 zone_id，也可只传 domain（会自动定位所属区域）。',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: { type: 'string', description: '域名区域 ID，与 domain 二选一' },
        domain: { type: 'string', description: '域名（如 example.com），会自动查出其 zone_id' },
        type: { type: 'string', description: '只筛选某类记录，如 A / CNAME / TXT，可省略' },
        search: { type: 'string', description: '按记录名或记录值搜索，可省略' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'add_dns_record',
    description:
      '添加一条 DNS 解析记录。zone_id 可省略：只给 name（完整域名，如 test.example.com）时会自动定位所属区域。已存在同类型同名的记录时不会重复添加，而是直接复用并返回 created=false。',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: '记录类型：A / AAAA / CNAME / TXT / MX / NS / SRV / CAA',
        },
        name: { type: 'string', description: '记录名，填完整域名即可，例如 test.example.com' },
        content: {
          type: 'string',
          description: '记录值：A 记录填 IP，CNAME 填目标域名，TXT 填文本',
        },
        zone_id: { type: 'string', description: '域名区域 ID，可省略（推荐省略，会自动定位）' },
        proxied: {
          type: 'boolean',
          description: '是否开启 Cloudflare 代理（橙色云），仅 A/AAAA/CNAME 有效，默认 true',
        },
        ttl: { type: 'number', description: 'TTL 秒数，1 表示自动，默认 1' },
        priority: { type: 'number', description: 'MX 记录的优先级，可省略' },
      },
      required: ['type', 'name', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_dns_record',
    description:
      '删除一条 DNS 解析记录。需要 zone_id 与 record_id；如果不确定 record_id，请先用 list_dns_records 查询。⚠️ 删除后不可恢复。',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: { type: 'string', description: '域名区域 ID' },
        record_id: { type: 'string', description: '解析记录 ID' },
      },
      required: ['zone_id', 'record_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_containers',
    description:
      '获取 Docker 容器列表，包含容器名、镜像、运行状态、端口映射、创建时间，并标记哪些是本系统部署的应用。支持筛选与搜索。',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: '是否包含已停止的容器，默认 true' },
        state: {
          type: 'string',
          enum: ['running', 'stopped'],
          description: '只看运行中或已停止，可省略',
        },
        search: { type: 'string', description: '按容器名或镜像名搜索，可省略' },
        managed: { type: 'boolean', description: '只看由本工作台部署的容器，默认 false' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'restart_container',
    description:
      '重启指定容器。container_id 可以是容器 ID，也可以是容器名（如 aige-uptime-kuma-a1b2c3）。',
    inputSchema: {
      type: 'object',
      properties: {
        container_id: { type: 'string', description: '容器 ID 或容器名' },
      },
      required: ['container_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'deploy_app',
    description:
      '一键部署应用（自动完成：Cloudflare 添加域名解析 → 拉取镜像 → 创建并启动容器 → 宝塔配置反向代理 → 配置 HTTPS）。可用应用见 list_app_templates。默认会等待部署结束再返回结果。',
    inputSchema: {
      type: 'object',
      properties: {
        app_name: {
          type: 'string',
          description: '应用模板标识，如 uptime-kuma / n8n / nocodb / wordpress / dify',
        },
        domain: {
          type: 'string',
          description: '要绑定的域名，例如 kuma.example.com（需已托管在 Cloudflare）',
        },
        wait: {
          type: 'boolean',
          description: '是否等待部署完成再返回，默认 true（最长等 3 分钟）',
        },
      },
      required: ['app_name', 'domain'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_deploy_logs',
    description:
      '查询部署任务的进度与日志。deploy_app 返回的 task_id 传入即可；since_id 用于增量拉取（只看新产生的日志）。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '部署任务 ID（deploy_app 返回的 taskId）' },
        since_id: { type: 'number', description: '只返回该日志 ID 之后的新日志，默认 0（全部）' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  // ---- 便捷工具（需求之外补充，让 AI 少绕路；不影响上面 13 个） ----
  {
    name: 'list_app_templates',
    description:
      '列出应用商店中所有可一键部署的应用模板（名称、简介、推荐内存、容器数量）。部署前可先调用它确认应用标识。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  // ============================================================
  // 以下工具是为了让「本系统一个 MCP 就能替代宝塔 MCP + Cloudflare MCP」
  // ------------------------------------------------------------------
  // 补齐依据：宝塔官方 MCP 有 17 个工具，含日志、配置读写、备份、万能 API 兜底；
  //          Cloudflare 那侧缺「改记录」与「清缓存」；Docker 缺启停与日志。
  //          补齐后 AI 只接这一个 MCP 就能干完所有活，不必再挂别的 MCP。
  // ============================================================
  {
    name: 'get_site_logs',
    description:
      '读取某个网站的访问日志或错误日志（末尾若干行）。排查「页面 500」「访问不到」「被谁刷了」这类问题时必用。type=access 是访问日志，type=error 是错误日志。',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', description: '网站域名，例如 aige-saas-panel.miaocaieyc.com.cn' },
        type: {
          type: 'string',
          enum: ['access', 'error'],
          description: '日志类型：access 访问日志（默认）/ error 错误日志',
        },
        lines: { type: 'number', description: '读取末尾多少行，默认 100，最大 2000' },
      },
      required: ['site'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_nginx_config',
    description:
      '读取某个网站的 Nginx 站点配置全文（含 SSL、反向代理、伪静态等所有段落）。想看清一个站到底怎么配的、或改配置前先读一遍，都用它。',
    inputSchema: {
      type: 'object',
      properties: { site: { type: 'string', description: '网站域名' } },
      required: ['site'],
      additionalProperties: false,
    },
  },
  {
    name: 'save_nginx_config',
    description:
      '覆盖写入某个网站的 Nginx 配置并自动重载。⚠️ 危险操作：会整段替换原配置。系统会在写入前自动备份原文件（返回 backupPath），写完执行 nginx -t 试载。改配置前请先用 get_nginx_config 读一遍。',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', description: '网站域名' },
        content: { type: 'string', description: '完整的 Nginx 站点配置内容（整段替换，不是追加）' },
      },
      required: ['site', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description:
      '读取服务器上的文本文件（限定在宝塔可管理的路径内）。带 lines 参数时只返回末尾若干行，适合看日志；不传则返回全文。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件的绝对路径，例如 /www/wwwlogs/example.com.log' },
        lines: { type: 'number', description: '只读末尾多少行，可省略（省略则读全文）' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_directory',
    description:
      '列出服务器上某个目录的内容（名称、大小、修改时间、权限、属主）。常用于确认站点目录、备份目录里有什么。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录绝对路径，例如 /www/wwwroot 或 /www/backup' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_backups',
    description:
      '列出宝塔的备份目录（/www/backup 下按用途分子目录：site 网站、database 数据库、backup_restore 一键还原）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_ssl_certs',
    description:
      '列出所有网站的 SSL 证书台账：签发者、生效时间、到期时间、**剩余天数**，以及状态（ok 正常 / expiring 15 天内到期 / expired 已过期）。做证书巡检、回答「证书还有几天到期」用它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'run_health_checks',
    description:
      '【自愈巡检】跑一遍全站体检，返回每一项的结论 + 是否提供一键修复 + 该项的熔断预算。检查项：证书到期风险、站点未启用 HTTPS、Cloudflare SSL 模式与源站是否一致、本项目容器运行状态、磁盘水位、口令与令牌自查。severity：critical / warning / info / ok / unknown。修复用 apply_health_fix 传对应 id。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'apply_health_fix',
    description:
      '【自愈巡检】执行某个检查项的修复。checkId 取 run_health_checks 返回的 id，常见有：ssl_expiring（续签临期证书）、ssl_missing（为站点补证书）、container_down（启动本项目停掉的容器）、disk_watermark（清理无用镜像）。⚠️ 受熔断约束：同一动作 30 分钟内最多 3 次；被熔断说明没修好，应去读日志找根因。无修复动作的项（如 cf_ssl_mode、weak_credentials）会直接报错——那类问题需要人工判断。',
    inputSchema: {
      type: 'object',
      properties: {
        checkId: {
          type: 'string',
          description: '检查项 id，例如 ssl_expiring / container_down / disk_watermark',
        },
      },
      required: ['checkId'],
      additionalProperties: false,
    },
  },
  {
    name: 'call_bt_api',
    description:
      '【万能兜底】直接调用宝塔面板的任意 API 端点，用于本系统还没封装的能力（计划任务、防火墙、FTP、数据库、文件压缩等）。参数 endpoint 形如 /site?action=GetSiteList。不确定端点时先看 https://www.bt.cn/api-doc/ 。⚠️ 端点语义与风险由调用方自行确认。',
    inputSchema: {
      type: 'object',
      properties: {
        endpoint: {
          type: 'string',
          description: '宝塔 API 路径，例如 /system?action=GetSystemTotal 或 /data?action=getData',
        },
        params: { type: 'object', description: '请求参数对象，可省略' },
        method: { type: 'string', enum: ['POST', 'GET'], description: '请求方法，默认 POST' },
      },
      required: ['endpoint'],
      additionalProperties: false,
    },
  },
  {
    name: 'call_cf_api',
    description:
      '【Cloudflare 兜底】直接调用 Cloudflare 的**区域级** API 端点，用于本系统还没封装的能力（WAF 规则、Page Rules、缓存规则、Transform Rules、区域设置等）。path 形如 /zones/{zone_id}/settings/ssl。' +
      '⚠️ **只允许 /zones 开头的路径** —— 账号级端点（/accounts、/user、/memberships…）会被拒绝，以免一把 Token 影响整个 Cloudflare 账号。' +
      '⚠️ 这是**写**工具（只读令牌用不了）；删除类操作不可恢复，动线上配置前先用 GET 看清现状。端点参考 https://developers.cloudflare.com/api/',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'CF API 路径（必须以 /zones 开头），如 /zones/{zone_id}/settings/ssl 或 /zones/{zone_id}/rulesets',
        },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
          description: 'HTTP 方法，默认 GET',
        },
        query: { type: 'object', description: '查询参数对象，可省略' },
        body: { type: 'object', description: '请求体对象（GET / DELETE 会忽略），可省略' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_dns_record',
    description:
      '修改已有的 DNS 记录（改记录值，或切换 Cloudflare 代理开关）。可传 record_id，或传 name（+可选 type）由系统自动定位记录。比「删了重建」安全。',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: { type: 'string', description: '区域 ID，省略时由 domain 自动定位' },
        domain: {
          type: 'string',
          description: '完整域名，用于自动定位 zone，例如 sub.example.com',
        },
        record_id: { type: 'string', description: '记录 ID，省略时用 name 定位' },
        name: { type: 'string', description: '记录名（完整域名），用于定位记录' },
        type: { type: 'string', description: '记录类型，配合 name 精确定位，例如 A / CNAME' },
        content: { type: 'string', description: '新的记录值，不改则省略' },
        proxied: { type: 'boolean', description: '是否开启 Cloudflare 代理（橙云），不改则省略' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'purge_cloudflare_cache',
    description:
      '清理 Cloudflare 边缘缓存。传 urls 只清指定 URL；不传则全量清理。改完网站内容发现访客还是旧版时用它。',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: { type: 'string', description: '区域 ID，省略时由 domain 自动定位' },
        domain: { type: 'string', description: '完整域名，用于自动定位 zone' },
        urls: {
          type: 'array',
          items: { type: 'string' },
          description:
            '要清理的完整 URL 列表，省略则全量清理，例如 ["https://example.com/index.html"]',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_zone_info',
    description:
      '获取某个域名区域的详情：状态、套餐、DNS 服务器、SSL 模式（off / flexible / full / strict）。',
    inputSchema: {
      type: 'object',
      properties: {
        zone_id: { type: 'string', description: '区域 ID，省略时由 domain 自动定位' },
        domain: { type: 'string', description: '完整域名，用于自动定位 zone' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'manage_container',
    description:
      '管理 Docker 容器的生命周期：start 启动 / stop 停止 / restart 重启 / remove 删除。参数 container 可传容器名或 ID（支持前缀匹配）。删除操作会二次确认容器存在。',
    inputSchema: {
      type: 'object',
      properties: {
        container: {
          type: 'string',
          description: '容器名或 ID（ID 支持前几位前缀），例如 aige-workbench-backend',
        },
        action: {
          type: 'string',
          enum: ['start', 'stop', 'restart', 'remove'],
          description: '要执行的动作',
        },
      },
      required: ['container', 'action'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_container_logs',
    description: '读取某个容器的运行日志（末尾若干行）。排查容器启动失败、应用报错必用。',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string', description: '容器名或 ID（支持前缀）' },
        lines: { type: 'number', description: '读取末尾多少行，默认 100，最大 2000' },
      },
      required: ['container'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_images',
    description:
      '列出服务器上的 Docker 镜像（标签、大小、被多少容器引用、创建时间）。清理磁盘前先看这个。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_repo_commits',
    description:
      '获取 GitHub 仓库的最近提交（作者、时间、提交信息首行、commit SHA），以及默认分支、语言、最近推送时间。用于回答「最近改了什么」「上次推送是什么时候」。仓库名格式为 owner/repo，省略时用「系统设置 → 代码仓库」里配置的第一个仓库。',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: '仓库名，格式 owner/repo，可省略' },
        limit: { type: 'number', description: '返回条数，默认 10，最大 30' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_ci_status',
    description:
      '获取 GitHub Actions 的运行状态：最近若干次 workflow 的成功 / 失败 / 进行中、所在分支、触发方式、耗时，并给出「现在绿不绿」的判断。排查「CI 挂了」时先用这个，再决定要不要去翻具体日志。',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: '仓库名，格式 owner/repo，可省略' },
        limit: { type: 'number', description: '返回最近几次运行，默认 10，最大 30' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_distributed_apps',
    description:
      '获取蒲公英（内测分发平台）账号下的应用清单：每个应用的当前版本号、版本编号、安装包大小、上传时间，以及**下载页地址与二维码地址**。用于回答「现在测试版是哪个版本」「最新包什么时候传的」「把下载页给我」。注意：这里只读；要上传安装包请让用户用蒲公英官方 MCP 或 CLI。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回最多几个应用，默认 20，最大 50' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_distributed_app',
    description:
      '获取蒲公英上某个应用的详情与**真实历史版本列表**（每条含各自的 buildKey / 版本号 / 版本编号 / 体积 / 上传时间，最新在前），并带上当前版本的下载页与二维码。需要先用 list_distributed_apps 拿到 appKey。' +
      '⚠️ 历史版本的 buildKey 是 delete_pgyer_build / set_pgyer_newest_build 的**唯一依据** —— 删版本前务必先用本工具核对 buildKey 与版本号对得上（删了不可恢复）。' +
      '⚠️ 二维码只有当前版本有（蒲公英只对最新版下发），历史条目的 qrCodeUrl 为 null 属正常，不是缺失。',
    inputSchema: {
      type: 'object',
      properties: {
        appKey: { type: 'string', description: '应用标识，从 list_distributed_apps 的结果里取' },
      },
      required: ['appKey'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_crontabs',
    description:
      '获取服务器上**全部**计划任务（cron）：名称、执行周期、是否启用、执行身份、分类，并标注哪些属于本项目（owner=own）、哪些属于其他项目（owner=foreign），以及疑似「排障时临时加的、事后没清理」的任务。用于回答「服务器上都有哪些定时任务在跑」「有没有遗留的临时任务」。⚠️ 这是整台机器的任务清单，多数属于其他项目；**只读，不提供启停或删除**，也**不返回脚本正文**（其他项目的脚本里有明文密钥）。注意：本工作台自己的定时清理在后端进程里跑，不在此列。',
    inputSchema: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          enum: ['all', 'own', 'foreign'],
          description: '只看某一类：all（默认）/ own（本项目）/ foreign（其他项目）',
        },
        keyword: { type: 'string', description: '按名称关键字过滤，可省略' },
        limit: { type: 'number', description: '返回最多几条，默认 50，最大 200' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_upload_help',
    description:
      '【把「本机文件」传到蒲公英的唯一可行路径】返回一条**可直接复制执行**的命令，把使用者本机的安装包 POST 到本工作台的上传入口。适用场景：安装包在使用者的电脑上（MCP 协议本身传不了二进制，所以必须由**本机终端**把文件送出去）。可选传 filePath，命令里的路径与文件名会直接填好。返回的命令默认带 --resolve **直连源站**，绕过 Cloudflare 的 100 秒请求上限（大文件走 Cloudflare 会被掐断）。',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description:
            '使用者本机安装包的绝对路径（如 C:\\Users\\me\\Desktop\\app.apk）。给了它，返回的命令可直接复制执行',
        },
        fileSizeBytes: {
          type: 'number',
          description:
            '文件字节数（可选）。超过 100MB 会明确警告 —— 上限由 Cloudflare 免费版定，放宽 nginx 也没用',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'upload_app_to_pgyer',
    description: `把**公网网址上**的安装包上传到蒲公英（内测分发）：传 downloadUrl，服务端先下载再上传，全程不落我们的盘。

⛔ **安装包在使用者本机时，不要用这个工具** —— 它只收 URL，服务器读不到那台电脑的磁盘。
本机文件请走 get_upload_help（那条路是通的、已实测跑过）：
1) 调 get_upload_help（带上 filePath）→ 拿到一条可直接复制执行的命令；
2) 在**本机终端**执行它 —— 文件原始字节直接作为请求体 POST 到 ${MCP_PUBLIC_BASE}/upload，
   鉴权用请求头 x-mcp-token: <全权令牌>（不能放 URL，也不要用 multipart）；
3) 传完调 list_distributed_apps 把下载页与二维码取回来。

限制：只支持 .apk / .ipa / .hap，单包 ≤ 100MB；上传是**新增版本**，不覆盖旧版本。`,
    inputSchema: {
      type: 'object',
      properties: {
        downloadUrl: {
          type: 'string',
          description: '安装包的下载地址（http/https，服务器能访问到即可）',
        },
        fileName: {
          type: 'string',
          description:
            '文件名，如 myapp.apk。省略时会从下载地址和响应头里推断；推断不出来必须给 —— 扩展名决定蒲公英归为 Android 还是 iOS',
        },
        updateDescription: { type: 'string', description: '这个版本的更新说明（会显示在下载页）' },
      },
      required: ['downloadUrl'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_pgyer_build',
    description:
      '修改蒲公英上某个版本的更新说明 / 版本号 / 安装方式 / 安装密码。需要先用 list_distributed_apps 或 get_distributed_app 拿到 buildKey。⚠️ 官方接口是「传空即清空」，所以这里**只带明确给了的字段**，没给的字段原样保留。',
    inputSchema: {
      type: 'object',
      properties: {
        buildKey: {
          type: 'string',
          description: '版本标识，从 get_distributed_app 的历史版本里取',
        },
        updateDescription: { type: 'string', description: '更新说明' },
        version: { type: 'string', description: '版本号，如 1.2.0' },
        installType: {
          type: 'number',
          description: '安装方式：2 = 密码安装，3 = 邀请安装',
        },
        password: { type: 'string', description: '安装密码（installType 为 2 时使用）' },
      },
      required: ['buildKey'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_pgyer_newest_build',
    description:
      '把蒲公英上某个版本设为「最新版本」，或取消它的最新标记。传错版本、想让正确的版本顶到下载页最上面时用它 —— 这比删掉重传安全得多。',
    inputSchema: {
      type: 'object',
      properties: {
        buildKey: { type: 'string', description: '版本标识' },
        isNewest: {
          type: 'boolean',
          description: 'true 设为最新版本（默认），false 取消最新标记',
        },
      },
      required: ['buildKey'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_pgyer_build',
    description:
      '⛔ 删除蒲公英上的**一个版本**，不可恢复。调用前务必先用 get_distributed_app 核对 buildKey 与版本号对得上。只是不想让它当最新版，请用 set_pgyer_newest_build，不要删。',
    inputSchema: {
      type: 'object',
      properties: {
        buildKey: { type: 'string', description: '要删除的版本标识（务必先核对）' },
      },
      required: ['buildKey'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_pgyer_app',
    description:
      '⛔⛔ 删除蒲公英上的**整个应用**（连它的全部历史版本一起删，不可恢复）。只在确认这个内测应用彻底不再需要时使用；只是想清旧版本请用 delete_pgyer_build。删之前建议先跟使用者确认一次应用名。',
    inputSchema: {
      type: 'object',
      properties: {
        appKey: { type: 'string', description: '应用标识，从 list_distributed_apps 取' },
      },
      required: ['appKey'],
      additionalProperties: false,
    },
  },
];

// ============================================================
// 令牌作用域（D2）：哪些工具算「只读」
// ============================================================
/**
 * 「只读令牌」可以调用的工具白名单。
 *
 * ⚠️ 刻意用**白名单**而不是黑名单：
 *    新增工具时若忘了归类，白名单默认「不给只读令牌用」——错在保守的一边；
 *    换成黑名单则会默认「给只读令牌用」，漏标一个就是一次线上误删。
 *    两者必须恰好铺满全部工具、且互不重叠，由 scripts/selfcheck-mcp-scope.js
 *    在 CI 里卡住（新增工具忘了归类会直接红），所以不存在「默认值」被误用的可能。
 *
 * 归入只读的三条标准：只查不改、不改服务器任何状态、不产生不可逆结果。
 */
const READONLY_TOOLS = new Set([
  // 巡检与自愈
  'get_server_status',
  'list_ssl_certs',
  // ⚠️ 取舍：run_health_checks 会写告警记录、可能外发通知（不碰服务器本身）。
  //    它正是「用只读令牌的 AI 最该干的事」，且告警有 fingerprint 去重 + 30 分钟静默窗口，
  //    被反复触发也刷不了屏，因此归入只读。真正会改服务器的是 apply_health_fix（写）。
  'run_health_checks',

  // 网站（宝塔）
  'list_websites',
  'get_site_logs',
  'get_nginx_config',

  // 文件与备份
  'read_file',
  'list_directory',
  'list_backups',

  // 域名与 DNS（Cloudflare）
  'list_domains',
  'list_dns_records',
  'get_zone_info',

  // Docker
  'list_containers',
  'get_container_logs',
  'list_images',

  // 应用部署
  'list_app_templates',
  'get_deploy_logs',

  // 代码仓库（GitHub）—— 纯只读：不碰服务器，也不改 GitHub 上任何东西
  'list_repo_commits',
  'get_ci_status',

  // 应用分发（蒲公英）—— 只读部分：查版本 / 下载页 / 二维码，
  // 外加「怎么把本机文件传上来」的帮助文本（它只是生成命令，不碰任何数据）
  'list_distributed_apps',
  'get_distributed_app',
  'get_upload_help',

  // 计划任务（C3）—— 纯只读：只看服务器上有哪些定时任务，
  // 不返回脚本正文（其他项目的脚本里有明文密钥），也不提供启停/删除
  'list_crontabs',
]);

/**
 * 会改变服务器 / 线上状态的工具 —— 只读令牌调用一律拒绝。
 * 与 READONLY_TOOLS 的并集必须是全部已注册工具（自检保证）。
 */
const WRITE_TOOLS = new Set([
  // 网站（宝塔）
  'create_website',
  'delete_website',
  'apply_ssl',
  'save_nginx_config',

  // 域名与 DNS
  'add_dns_record',
  'update_dns_record',
  'delete_dns_record',
  'purge_cloudflare_cache',

  // Docker
  'restart_container',
  'manage_container',

  // 应用部署
  'deploy_app',

  // 应用分发（蒲公英）：上传会新增线上版本，改/删直接影响下载页，全算写
  'upload_app_to_pgyer',
  'update_pgyer_build',
  'set_pgyer_newest_build',
  'delete_pgyer_build',
  'delete_pgyer_app',

  // 自愈修复
  'apply_health_fix',

  // 万能兜底：可以触达宝塔任意写接口，必须算写
  'call_bt_api',

  // Cloudflare 兜底：可触达任意**区域级**写接口（账号级已挡），同样必须算写
  'call_cf_api',
]);

/** 统一成功结果 */
const ok = (data, message = '操作成功') => ({ success: true, data: data ?? null, message });

/**
 * 取「网站」标识（**宽容输入**）
 * ------------------------------------------------------------------
 * 站点名、网站域名、站点标识在本系统里指的是同一个东西，但不同工具的参数名
 * 历史上分别叫过 \`site\` / \`siteName\` / \`domain\`。AI 读到的是每个工具的 JSON Schema，
 * 一不留神就会在三个名字之间猜错，然后「报错 → 重读 schema → 重试」白跑一轮。
 * 三种都认一下，比要求 AI 永远别猜错更实际。
 */
const pickSite = (args = {}) =>
  String(args.site || args.siteName || args.domain || args.name || '').trim();

/** 取「区域 ID」：文档口径是 \`zone_id\`，但驼峰 \`zoneId\` 也认（AI 很爱写驼峰） */
const pickZoneId = (args = {}) => String(args.zone_id || args.zoneId || '').trim();

/** 取「记录 ID」：同理，\`record_id\` 与 \`recordId\` 都认 */
const pickRecordId = (args = {}) => String(args.record_id || args.recordId || '').trim();

/** 取蒲公英的「版本标识」：\`buildKey\` / \`build_key\` / \`key\` 都认 */
const pickBuildKey = (args = {}) =>
  String(args.buildKey || args.build_key || args.key || '').trim();

/** Cloudflare 的 zone_id 形状：32 位十六进制（用来区分「这是 ID」还是「这是域名」） */
const looksLikeZoneId = (v) => /^[0-9a-f]{32}$/i.test(String(v || ''));

/** 把 zone_id / 域名 解析成真正的 zone_id（zone_id 缺省时自动定位） */
async function resolveZoneId(args = {}) {
  const raw = pickZoneId(args);

  // ⛔ 这里必须分辨「传的是 ID 还是域名」：
  //    AI 很爱把域名塞进 zoneId（参数名看着就像要 ID），如果直接当 ID 用，
  //    Cloudflare 会返回一个含糊的错误，排查方向会被带偏。
  //    zone_id 是 32 位十六进制，不像就当作域名走自动定位。
  if (raw && looksLikeZoneId(raw)) return raw;

  const domain = String(args.domain || (String(raw).includes('.') ? raw : '')).trim();
  if (!domain) {
    throw Object.assign(
      new Error(
        '需要提供 zone_id（32 位，或 zoneId），或者直接给一个完整域名' +
          '（如 aige-saas-panel.miaocaieyc.com.cn）让我自动定位'
      ),
      { expected: true, status: 400 }
    );
  }

  const cf = cloudflareService.createClient();
  const zone = await cf.findZoneByDomain(domain);
  return zone.id;
}

const TOOL_HANDLERS = {
  /** 自愈巡检：跑一遍全部检查 */
  async run_health_checks() {
    const report = await healthService.runChecks();
    const { summary } = report;
    const unhealthy = summary.critical + summary.warning + summary.info;
    return ok(
      report,
      unhealthy
        ? `巡检完成：${summary.critical} 项严重、${summary.warning} 项警告、${summary.info} 项提示`
        : `巡检完成：${summary.ok} 项全部正常`
    );
  },

  /** 自愈巡检：执行某项修复（受熔断约束） */
  async apply_health_fix({ checkId }) {
    if (!checkId) {
      throw Object.assign(
        new Error('需要提供 checkId（如 ssl_expiring / container_down / disk_watermark）'),
        {
          expected: true,
          status: 400,
        }
      );
    }
    const r = await healthService.applyFix(String(checkId), { username: 'mcp', source: 'mcp' });
    return ok(r, r.message || `已执行修复：${r.title}`);
  },

  /** 1. 服务器状态 */
  async get_server_status() {
    const [server, disk, sites, zones, containers] = await Promise.all([
      baotaService.createClient().getSystemTotal(),
      baotaService
        .createClient()
        .getDiskInfo()
        .catch(() => ({ disks: [], root: null })),
      baotaService
        .createClient()
        .getSiteList({ page: 1, limit: 500 })
        .catch(() => ({ list: [], total: 0 })),
      cloudflareService
        .createClient()
        .listZones()
        .catch(() => []),
      dockerService
        .createClient()
        .listContainers(true)
        .catch(() => []),
    ]);

    const running = containers.filter((c) => c.running).length;

    return ok(
      {
        server: {
          system: server.system,
          kernel: server.version,
          cpuCores: server.cpuNum,
          cpuUsagePercent: server.cpuUsage,
          memory: {
            totalMb: server.memTotalMb,
            usedMb: server.memUsedMb,
            freeMb: server.memFreeMb,
            usagePercent: server.memUsage,
          },
          load: server.load,
        },
        disk: {
          total: disk.root?.total || '-',
          used: disk.root?.used || '-',
          free: disk.root?.free || '-',
          usagePercent: disk.root?.usage ?? null,
          disks: disk.disks,
        },
        counts: {
          websites: sites.total || sites.list.length,
          domains: zones.length,
          containers: containers.length,
          containersRunning: running,
          containersStopped: containers.length - running,
        },
        summary: `CPU ${server.cpuUsage}% · 内存 ${server.memUsage}%（${(server.memTotalMb / 1024).toFixed(1)} GB）· 磁盘 ${disk.root?.usage ?? '?'}% · 容器 ${running}/${containers.length} 运行中`,
      },
      '服务器状态获取成功'
    );
  },

  /** 2. 网站列表 */
  async list_websites({ search = '', page = 1, limit = 200 }) {
    const baota = baotaService.createClient();
    const { list, total } = await baota.getSiteList({ page, limit, search });
    const filtered = search
      ? list.filter(
          (s) => s.name.includes(search) || s.domain.includes(search) || s.ps.includes(search)
        )
      : list;
    return ok(
      { list: filtered, total: search ? filtered.length : total },
      `共 ${filtered.length} 个网站`
    );
  },

  /** 3. 新建网站 */
  async create_website({ domain, path, ps }) {
    const clean = String(domain || '')
      .trim()
      .toLowerCase();
    if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(clean)) {
      return { success: false, data: null, message: `域名格式不正确：${domain}` };
    }

    const baota = baotaService.createClient();
    if (await baota.siteExists(clean)) {
      return {
        success: false,
        data: { domain: clean, exists: true },
        message: `网站已存在：${clean}，未重复创建`,
      };
    }

    const result = await baota.addSite({ domain: clean, path, ps: ps || '由 MCP 创建的站点' });
    return ok(result, `网站创建成功：${clean}（目录 ${result.path}）`);
  },

  /** 4. 删除网站 */
  async delete_website({ domain }) {
    const clean = String(domain || '')
      .trim()
      .toLowerCase();
    if (!clean) return { success: false, data: null, message: 'domain 不能为空' };

    const baota = baotaService.createClient();
    const site = await baota.getSite(clean);
    if (!site) return { success: false, data: null, message: `网站不存在：${clean}` };

    const result = await baota.deleteSite(clean);
    return ok({ ...result, path: site.path }, `网站已删除：${clean}`);
  },

  /** 5. 申请 SSL */
  async apply_ssl({ domain, mode = 'letsencrypt', domains, cert, key }) {
    const baota = baotaService.createClient();
    const site = await baota.getSite(domain);
    if (!site) return { success: false, data: null, message: `网站不存在：${domain}` };

    if (mode === 'manual') {
      if (!cert || !key)
        return { success: false, data: null, message: 'mode=manual 时必须同时提供 cert 与 key' };
      const result = await baota.setSsl({
        siteName: site.name,
        cert,
        key,
        domains: domains || site.domains,
      });
      return ok(result, `证书已部署到 ${site.name}`);
    }

    const list =
      Array.isArray(domains) && domains.length
        ? domains
        : site.domains.length
          ? site.domains
          : [site.name];
    const result = await baota.applyLetsEncrypt({ siteName: site.name, domains: list });
    return ok(result, `证书申请已提交（覆盖：${list.join(', ')}），通常 10-60 秒完成签发`);
  },

  /** 6. 域名区域列表 */
  async list_domains() {
    const zones = await cloudflareService.createClient().listZones();
    return ok({ list: zones, total: zones.length }, `共 ${zones.length} 个域名区域`);
  },

  /** 7. DNS 记录列表 */
  async list_dns_records(args = {}) {
    const { type = '', search = '' } = args;
    const zoneId = await resolveZoneId(args);
    const records = await cloudflareService.createClient().listDnsRecords(zoneId, { type, search });
    return ok({ zoneId, list: records, total: records.length }, `共 ${records.length} 条解析记录`);
  },

  /** 8. 添加 DNS 记录 */
  async add_dns_record(args = {}) {
    const { type, name, content, proxied = true, ttl, priority } = args;
    if (!type || !name || !content) {
      return { success: false, data: null, message: 'type、name、content 均为必填' };
    }
    const zoneId = await resolveZoneId({ ...args, domain: args.domain || name });
    const cf = cloudflareService.createClient();

    const { record, created } = await cf.ensureDnsRecord(zoneId, {
      type: String(type).toUpperCase(),
      name: String(name).trim().toLowerCase(),
      content,
      proxied,
      ttl,
      priority,
      comment: '由 MCP 添加',
    });

    return ok(
      { zoneId, created, record },
      created
        ? `解析已添加：${record.name} → ${record.content}（${created ? '新记录' : '复用已有记录'}）`
        : `解析已存在，未重复添加：${record.name} → ${record.content}`
    );
  },

  /** 9. 删除 DNS 记录 */
  async delete_dns_record(args = {}) {
    const zoneId = await resolveZoneId(args);
    const recordId = pickRecordId(args);
    if (!recordId)
      return { success: false, data: null, message: '需要提供 record_id（recordId 也认）' };
    const result = await cloudflareService.createClient().deleteDnsRecord(zoneId, recordId);
    return ok(result, `解析已删除（record_id: ${recordId}）`);
  },

  /** 10. 容器列表 */
  async list_containers({ all = true, state = '', search = '', managed = false }) {
    const docker = dockerService.createClient();
    let list = await docker.listContainers(all);
    if (managed) list = list.filter((c) => c.managedByWorkbench);
    if (state === 'running') list = list.filter((c) => c.running);
    if (state === 'stopped') list = list.filter((c) => !c.running);
    if (search) {
      const kw = String(search).toLowerCase();
      list = list.filter(
        (c) => c.name.toLowerCase().includes(kw) || c.image.toLowerCase().includes(kw)
      );
    }
    return ok(
      {
        list: list.map((c) => ({
          id: c.id,
          name: c.name,
          image: c.image,
          state: c.state,
          status: c.status,
          ports: c.portSummary,
          created: c.createdText,
          domain: c.domain,
          managedByWorkbench: c.managedByWorkbench,
        })),
        total: list.length,
        running: list.filter((c) => c.running).length,
      },
      `共 ${list.length} 个容器（${list.filter((c) => c.running).length} 个运行中）`
    );
  },

  /** 11. 重启容器 */
  async restart_container({ container_id }) {
    if (!container_id) return { success: false, data: null, message: 'container_id 不能为空' };
    const docker = dockerService.createClient();

    // 允许直接传容器名：先按名字找到真实 ID，避免调用方还要先查列表
    let id = container_id;
    const list = await docker.listContainers(true);
    const matched =
      list.find((c) => c.name === container_id) || list.find((c) => c.id.startsWith(container_id));
    if (matched) id = matched.id;

    await docker.restartContainer(id);
    return ok(
      { containerId: id, name: matched?.name || container_id },
      `容器已重启：${matched?.name || container_id}`
    );
  },

  /** 12. 一键部署应用 */
  async deploy_app({ app_name, domain, wait = true }) {
    const templates = listTemplates();
    if (!templates.some((t) => t.key === app_name)) {
      return {
        success: false,
        data: { available: templates.map((t) => t.key) },
        message: `应用模板不存在：${app_name}。可用：${templates.map((t) => t.key).join(' / ')}`,
      };
    }

    const started = deployService.startDeploy({
      appKey: app_name,
      domain,
      actor: 'mcp',
      source: 'mcp',
    });

    if (!wait) {
      return ok(
        started,
        `部署任务已创建（task_id: ${started.taskId}），可用 get_deploy_logs 查询进度`
      );
    }

    const task = await deployService.waitForTask(started.taskId, 180000);
    const logs = deployService.getLogs(started.taskId).map((l) => `[${l.level}] ${l.message}`);

    if (task.status === 'failed') {
      return {
        success: false,
        data: {
          taskId: task.id,
          status: task.status,
          progress: task.progress,
          error: task.error,
          logs,
        },
        message: `部署失败：${task.error}`,
      };
    }
    if (task.status !== 'success') {
      return ok(
        { taskId: task.id, status: task.status, progress: task.progress, logs },
        '部署仍在进行中（超过 3 分钟），请用 get_deploy_logs 继续查询'
      );
    }

    return ok(
      {
        taskId: task.id,
        status: task.status,
        progress: task.progress,
        url: task.result?.url || `https://${domain}`,
        containers: task.result?.containers || [],
        ssl: task.result?.ssl || null,
        warnings: task.result?.warnings || [],
        logs,
      },
      `部署完成，访问地址：${task.result?.url || `https://${domain}`}`
    );
  },

  /** 13. 部署日志 */
  async get_deploy_logs({ task_id, since_id = 0 }) {
    const task = deployService.getTask(task_id);
    if (!task) return { success: false, data: null, message: `部署任务不存在：${task_id}` };

    const logs = deployService.getLogs(task_id, since_id);
    return ok(
      {
        taskId: task.id,
        appName: task.app_name,
        appTitle: task.app_title,
        domain: task.domain,
        status: task.status,
        progress: task.progress,
        currentStep: task.current_step,
        totalSteps: task.total_steps,
        stepName: task.steps?.[task.current_step] || null,
        error: task.error,
        result: task.result,
        logs: logs.map((l) => ({
          id: l.id,
          step: l.step,
          level: l.level,
          message: l.message,
          time: l.created_at,
        })),
      },
      `任务状态：${task.status}（进度 ${task.progress}%）`
    );
  },

  /** 附加：应用模板列表 */
  async list_app_templates() {
    const list = listTemplates();
    return ok({ list, total: list.length }, `共 ${list.length} 个可部署应用`);
  },

  // ============================================================
  // 以下为补齐「一个 MCP 替代宝塔 + Cloudflare」新增的工具实现
  // ============================================================

  /** 14. 站点日志（访问 / 错误） */
  async get_site_logs(args = {}) {
    const { type = 'access', lines = 100 } = args;
    const site = pickSite(args);
    if (!site) {
      return {
        success: false,
        data: null,
        message: '需要提供 site（网站域名；siteName / domain 也认）',
      };
    }
    const res = await baotaService.createClient().getSiteLogs(site, { type, lines });
    return ok(
      res,
      `${site} 的${type === 'error' ? '错误' : '访问'}日志（末尾 ${res.returnedLines} 行，共 ${res.totalLines} 行）`
    );
  },

  /** 15. 读取站点 Nginx 配置 */
  async get_nginx_config(args = {}) {
    const site = pickSite(args);
    if (!site) {
      return {
        success: false,
        data: null,
        message: '需要提供 site（网站域名；siteName / domain 也认）',
      };
    }
    const res = await baotaService.createClient().getNginxConfig(site);
    return ok(res, `已读取 ${site} 的 Nginx 配置（${res.content.length} 字符）`);
  },

  /** 16. 写入站点 Nginx 配置（自动备份 + 试载） */
  async save_nginx_config(args = {}) {
    const site = pickSite(args);
    const { content } = args;
    if (!site || !content)
      return { success: false, data: null, message: '需要提供 site（网站域名）与 content' };
    const res = await baotaService.createClient().saveNginxConfig(site, content);
    return ok(res, `已写入 ${site} 的配置${res.backupPath ? '（原文件已备份）' : ''}并重载 Nginx`);
  },

  /** 17. 读取服务器文件 */
  async read_file({ path: filePath, lines }) {
    if (!filePath) return { success: false, data: null, message: '需要提供 path（文件绝对路径）' };
    const baota = baotaService.createClient();
    if (lines) {
      const res = await baota.readTail(filePath, lines);
      return ok(res, `已读取 ${filePath} 末尾 ${res.returnedLines} 行（共 ${res.totalLines} 行）`);
    }
    const content = await baota.readFile(filePath);
    return ok({ path: filePath, chars: String(content).length, content }, `已读取 ${filePath}`);
  },

  /** 18. 列出目录 */
  async list_directory({ path: dirPath }) {
    if (!dirPath) return { success: false, data: null, message: '需要提供 path（目录绝对路径）' };
    const res = await baotaService.createClient().listDir(dirPath);
    return ok(res, `${dirPath} 下有 ${res.count} 项`);
  },

  /** 19. 列出备份 */
  async list_backups() {
    const res = await baotaService.createClient().listBackups();
    return ok(res, `备份目录下有 ${res.count} 项`);
  },

  /** 20. 证书台账（含剩余天数，与宝塔口径一致） */
  async list_ssl_certs() {
    const res = await baotaService.createClient().listSslCerts();
    const warn =
      res.expiring || res.expired
        ? `；⚠️ ${res.expiring} 个 15 天内到期、${res.expired} 个已过期`
        : '';
    return ok(res, `共 ${res.total} 个站点，其中 ${res.withCert} 个已配证书${warn}`);
  },

  /** 21. 万能兜底：调用宝塔任意 API */
  async call_bt_api({ endpoint, params, method }) {
    if (!endpoint)
      return { success: false, data: null, message: '需要提供 endpoint（宝塔 API 路径）' };
    const res = await baotaService.createClient().callRaw(endpoint, params || {}, method || 'POST');
    return ok(res, `已调用宝塔接口 ${res.endpoint}`);
  },

  /** 21.5 Cloudflare 兜底：直调区域级 API（账号级端点已被服务层挡掉） */
  async call_cf_api({ path, method, query, body } = {}) {
    const p = String(path || '').trim();
    if (!p) {
      return {
        success: false,
        data: null,
        message:
          '需要提供 path（CF API 路径，必须以 /zones 开头，如 /zones/{zone_id}/settings/ssl）',
      };
    }
    const client = cloudflareService.createClient();
    const data = await client.callApi(p, { method, query, body });
    const m = String(method || 'GET').toUpperCase();
    return {
      ...ok(data, `已调用 Cloudflare ${m} ${p}`),
      // 能改线上配置（WAF / 缓存规则 / 区域设置…），必须留痕
      audit: { before: null, after: { method: m, path: p } },
    };
  },

  /** 22. 修改 DNS 记录 */
  async update_dns_record(args = {}) {
    const { name, type, content, proxied } = args;
    if (content === undefined && proxied === undefined) {
      return {
        success: false,
        data: null,
        message: 'content 与 proxied 至少要给一个，否则没有要改的内容',
      };
    }
    const cf = cloudflareService.createClient();
    const zoneId = await resolveZoneId(args);

    // 没给 record_id 就用 name（+可选 type）定位
    let recordId = pickRecordId(args);
    if (!recordId) {
      if (!name)
        return {
          success: false,
          data: null,
          message: '需要提供 record_id，或提供 name 以便定位记录',
        };
      const records = await cf.listDnsRecords(zoneId, {});
      const hit = records.find(
        (r) => r.name === name && (!type || r.type === String(type).toUpperCase())
      );
      if (!hit)
        return {
          success: false,
          data: null,
          message: `在区域里找不到记录：${name}${type ? ` (${type})` : ''}`,
        };
      recordId = hit.id;
    }

    const patch = {};
    if (content !== undefined) patch.content = content;
    if (proxied !== undefined) patch.proxied = proxied;

    const res = await cf.updateDnsRecord(zoneId, recordId, patch);
    return {
      ...ok(res, `已更新记录 ${res.name || name || recordId}`),
      // B6 审计：这条解析从什么改成了什么（由 callTool 写进操作日志，不外传给 AI）
      audit: { before: res.before, after: cloudflareService.recordFields(res) },
    };
  },

  /** 23. 清理 Cloudflare 缓存 */
  async purge_cloudflare_cache(args = {}) {
    const zoneId = await resolveZoneId(args);
    const res = await cloudflareService.createClient().purgeCache(zoneId, { urls: args.urls });
    return ok(
      res,
      res.mode === 'everything'
        ? '已提交全量缓存清理'
        : `已提交 ${args.urls.length} 个 URL 的缓存清理`
    );
  },

  /** 24. 区域详情 */
  async get_zone_info(args = {}) {
    const zoneId = await resolveZoneId(args);
    const res = await cloudflareService.createClient().getZone(zoneId);
    return ok(
      res,
      `${res.name}：状态 ${res.status}，套餐 ${res.plan || '-'}，SSL ${res.sslMode || '-'}`
    );
  },

  /** 25. 容器生命周期管理 */
  async manage_container({ container, action }) {
    const docker = dockerService.createClient();
    const hit = await resolveContainer(docker, container);

    let res;
    if (action === 'start') res = await docker.startContainer(hit.id);
    else if (action === 'stop') res = await docker.stopContainer(hit.id);
    else if (action === 'restart') res = await docker.restartContainer(hit.id);
    else if (action === 'remove') res = await docker.removeContainer(hit.id);
    else
      return {
        success: false,
        data: null,
        message: `不支持的 action：${action}（可用 start / stop / restart / remove）`,
      };

    const verb = { start: '已启动', stop: '已停止', restart: '已重启', remove: '已删除' }[action];
    return ok(
      { container: hit.name, containerId: hit.id, action, detail: res },
      `${hit.name} ${verb}`
    );
  },

  /** 26. 容器日志 */
  async get_container_logs({ container, lines = 100 }) {
    const docker = dockerService.createClient();
    const hit = await resolveContainer(docker, container);
    const res = await docker.getContainerLogs(hit.id, { tail: lines, timestamps: true });
    const text = typeof res === 'string' ? res : res?.logs || JSON.stringify(res);
    return ok(
      { container: hit.name, containerId: hit.id, lines, content: text },
      `${hit.name} 的日志（末尾 ${lines} 行）`
    );
  },

  /** 27. 镜像列表 */
  async list_images() {
    const list = await dockerService.createClient().listImages();
    const totalSize = list.reduce((sum, i) => sum + (Number(i.size) || 0), 0);
    return ok(
      { list, total: list.length, totalSize, totalSizeText: formatBytes(totalSize) },
      `共 ${list.length} 个镜像，合计 ${formatBytes(totalSize)}`
    );
  },

  /** 28. 仓库最近提交（B4） */
  async list_repo_commits({ repo, limit }) {
    const full = resolveRepo(repo);
    const count = clampLimit(limit, 10);
    const [info, commits] = await Promise.all([
      githubService.repoInfo(full),
      githubService.listCommits(full, { perPage: count }),
    ]);
    return ok(
      {
        repo: full,
        defaultBranch: info.defaultBranch,
        language: info.language,
        pushedAt: info.pushedAt,
        htmlUrl: info.htmlUrl,
        commits,
      },
      `${full} 最近 ${commits.length} 次提交（分支 ${info.defaultBranch}，最近推送 ${info.pushedAt || '未知'}）`
    );
  },

  /** 29. CI 状态（B4） */
  async get_ci_status({ repo, limit }) {
    const count = clampLimit(limit, 10);
    const data = await githubService.ciStatus(resolveRepo(repo), { perPage: count });
    const { latest } = data;
    const verdict = !latest
      ? '这个仓库还没有 Actions 运行记录'
      : latest.status !== 'completed'
        ? `最新一次正在跑（${latest.name} · ${latest.branch}）`
        : latest.conclusion === 'success'
          ? `最新一次通过（${latest.name} · ${latest.branch}）`
          : `⚠️ 最新一次是 ${latest.conclusion || '未知结果'}（${latest.name} · ${latest.branch}）`;
    return ok(data, `${data.repo}：${verdict}`);
  },

  /**
   * 29.5 上传帮助：生成一条可直接复制执行的命令（只读，不碰任何数据）
   * ------------------------------------------------------------------
   * 为什么需要它：MCP 协议传不了二进制，而文件在**使用者的电脑上** ——
   * 唯一可行的路径就是「让本机终端把字节 POST 到工作台的上传入口」。
   * 但客户端看不到本工作台的文档，所以端点 / 鉴权 / 字段必须由工具**当面告诉它**，
   * 否则就会出现「知道该用 curl，却不知道往哪打、带什么头」的死角。
   */
  async get_upload_help({ filePath, fileSizeBytes } = {}) {
    const rawPath = String(filePath || '').trim();
    // 文件名取路径最后一段；中文名必须 URL 编码，否则 curl 会把 URL 拆坏 —— 这里替使用者编好
    const rawName =
      (rawPath ? rawPath.split(/[\\/]/).filter(Boolean).pop() : '') || 'app-release.apk';
    const url = `${MCP_PUBLIC_BASE}/upload?fileName=${encodeURIComponent(rawName)}`;
    const size = Number(fileSizeBytes) || 0;
    const maxBytes = pgyerService.MAX_UPLOAD_BYTES;
    const tooBig = size > maxBytes;

    // ⛔ 默认就给「直连源站」的命令：走 Cloudflare 时，上行慢的大文件会被它的 100 秒上限掐断
    let host;
    try {
      host = new URL(MCP_PUBLIC_BASE).hostname;
    } catch {
      host = '';
    }
    const resolve = host && MCP_ORIGIN_IP ? `--resolve "${host}:443:${MCP_ORIGIN_IP}"` : '';

    const isWinPath = /^[a-zA-Z]:[\\/]/.test(rawPath) || rawPath.includes('\\');
    const winTarget = rawPath || '<安装包绝对路径>';
    const nixTarget = rawPath && !isWinPath ? rawPath : `/path/to/${rawName}`;

    // 两条命令都给全：AI 不必自己拼（拼错一次就白跑一轮）。
    // 主：直连源站（绕过 CF 100 秒上限）；备：走域名（直连不通时用）。
    const winCmd = (withResolve) =>
      [
        `curl.exe -X POST "${url}" \``,
        '  -H "x-mcp-token: <你的全权 MCP 令牌>" `',
        '  -H "Content-Type: application/octet-stream" `',
        ...(withResolve && resolve ? [`  ${resolve} \``] : []),
        `  --data-binary "@${winTarget}"`,
      ].join('\n');
    const nixCmd = (withResolve) =>
      [
        `curl -X POST "${url}" \\`,
        '  -H "x-mcp-token: <你的全权 MCP 令牌>" \\',
        '  -H "Content-Type: application/octet-stream" \\',
        ...(withResolve && resolve ? [`  ${resolve} \\`] : []),
        `  --data-binary "@${nixTarget}"`,
      ].join('\n');

    const winDirect = winCmd(true);
    const nixDirect = nixCmd(true);
    const winPlain = winCmd(false);
    const nixPlain = nixCmd(false);
    const hasDirect = !!resolve;

    const data = {
      endpoint: url,
      method: 'POST',
      authHeader: 'x-mcp-token: <你的全权 MCP 令牌>（也可用 Authorization: Bearer <令牌>）',
      body: '文件的原始字节（application/octet-stream）—— 不要用 multipart/form-data',
      fileName: rawName,
      originIp: MCP_ORIGIN_IP || null,
      bypassCloudflare: resolve || null,
      fileSizeBytes: size || null,
      maxBytes,
      oversized: tooBig,
      commands: {
        recommended: {
          label: hasDirect
            ? '直连源站（推荐：绕过 Cloudflare 的 100 秒请求上限）'
            : '直传（把文件原始字节 POST 到上传入口）',
          windowsPowerShell: winDirect,
          linuxMac: nixDirect,
        },
        fallback: hasDirect
          ? {
              label: '走域名（直连不通时用；大文件可能被 Cloudflare 掐断）',
              windowsPowerShell: winPlain,
              linuxMac: nixPlain,
            }
          : null,
      },
      responseExample:
        '{"code":0,"message":"上传成功：艾哥剪辑 v0.0.03","data":{"buildKey":"…","version":"0.0.03","downloadPage":"https://www.pgyer.com/xxxx","qrCodeUrl":"…"}}',
      troubleshooting: [
        {
          symptom: 'curl: (35) Connection was reset / 传一半就断',
          cause: '走 Cloudflare，撞上它「单次请求 100 秒」的上限（源站日志里会一条都没有）',
          fix: '改用上面的「直连源站」那条命令',
        },
        {
          symptom: 'HTTP 401',
          cause: '令牌没带、带错，或者放进了 URL 的 ?token=',
          fix: '令牌放请求头（x-mcp-token 或 Authorization: Bearer）',
        },
        {
          symptom: 'HTTP 403 FORBIDDEN',
          cause: '用的是只读令牌 —— 上传会改线上分发的版本，只认全权令牌',
          fix: '换成「系统设置 → MCP 连接」里的全权令牌',
        },
        {
          symptom: 'HTTP 400 EMPTY_BODY',
          cause: '少了 --data-binary，或误用了 multipart/form-data',
          fix: '文件原始字节直接作为请求体',
        },
        {
          symptom: 'Windows 报「curl 不是内部或外部命令」或参数错误',
          cause: 'PowerShell 里 curl 是 Invoke-WebRequest 的别名',
          fix: '写 curl.exe',
        },
        {
          symptom: '413 / 文件过大',
          cause: '安装包超过 100MB（Cloudflare 与蒲公英套餐都卡在这个量级）',
          fix: '先压缩体积；或改用蒲公英官方 CLI / CI 插件走另一条渠道。MCP 侧没有别的路',
        },
        {
          symptom: '业务码 1249',
          cause: '这个文件不是有效的安装包（损坏，或后缀名骗人）',
          fix: '确认包能正常安装、后缀是真 .apk / .ipa / .hap',
        },
      ],
      nextSteps: [
        'set_pgyer_newest_build —— 把新版本设为最新版',
        'update_pgyer_build —— 改版本说明 / 版本号',
        'get_distributed_app —— 核对历史版本',
      ],
    };

    const head = tooBig
      ? `⛔ 这个文件 ${formatBytes(size)} 超过上限 ${formatBytes(maxBytes)}，会被挡下，先别传（压缩后重试）。`
      : '把下面整段复制到本机终端执行（Windows 用 PowerShell 那条）：';

    const parts = [
      head,
      '',
      `【推荐】${data.commands.recommended.label}`,
      winDirect,
      '',
      nixDirect,
    ];
    if (data.commands.fallback) {
      parts.push('', `【备选】${data.commands.fallback.label}`, winPlain);
    }
    parts.push(
      '',
      '⛔ 三个必知：① PowerShell 里必须写 curl.exe（curl 是 Invoke-WebRequest 的别名）；' +
        '② 令牌 = 你 MCP 配置里 Authorization: Bearer 后面那串，且只能放请求头；' +
        '③ 不要用 multipart，文件本身就是请求体。',
      tooBig
        ? ''
        : '传完用 list_distributed_apps 取下载页与二维码，需要的话再用 set_pgyer_newest_build 设为最新版。',
      '若失败：把完整报错贴回来，对着 data.troubleshooting 逐条排' +
        '（最常见三条：Connection was reset → 换直连那条；401 → 令牌要放请求头；403 → 用了只读令牌）。'
    );

    return ok(data, parts.join('\n'));
  },

  /** 30. 蒲公英应用清单（B7） */
  async list_distributed_apps({ limit }) {
    const count = clampLimit(limit, 20, 50);
    const { items, totalApps, totalBuilds } = await pgyerService.listApps();
    const list = items.slice(0, count);
    if (!list.length) {
      return ok(
        { apps: [], totalApps: 0, totalBuilds: 0 },
        '蒲公英账号下还没有任何应用（要发第一个包：包在网址上用 upload_app_to_pgyer，包在本机用 get_upload_help 拿命令）'
      );
    }
    const lines = list
      .map(
        (a) =>
          `${a.name} v${a.latest.version}（${formatBytes(a.latest.fileSize)}，${a.latest.createdAt}）`
      )
      .join('；');
    return ok(
      { apps: list, totalApps, totalBuilds },
      `共 ${totalApps} 个应用 / ${totalBuilds} 个版本：${lines}`
    );
  },

  /** 31. 蒲公英应用详情（B7） */
  async get_distributed_app({ appKey }) {
    if (!appKey) {
      throw Object.assign(new Error('需要提供 appKey（可先用 list_distributed_apps 获取）'), {
        expected: true,
        status: 400,
      });
    }
    const data = await pgyerService.appDetail(appKey);
    // 把每个版本的 buildKey 直接列在 message 里 —— AI 接下来要拿它调
    // delete_pgyer_build / set_pgyer_newest_build，不必再去 data.history 里翻
    const lines = data.history.map((h) => `v${h.version}=${h.buildKey}`).join(' ｜ ');
    return ok(
      data,
      `${data.latest.name} 当前 v${data.latest.version}（${formatBytes(data.latest.fileSize || 0)}）；` +
        `共 ${data.history.length} 个版本（新 → 旧）：${lines}；` +
        `下载页 ${data.latest.downloadPage || '未获取到'}`
    );
  },

  /** 33. 上传安装包到蒲公英（从网址拉取） */
  async upload_app_to_pgyer(args = {}) {
    const url = String(args.downloadUrl || args.url || '').trim();
    if (!url) {
      return { success: false, data: null, message: '需要提供 downloadUrl（安装包的下载地址）' };
    }
    const r = await pgyerService.uploadFromUrl(url, {
      fileName: String(args.fileName || '').trim(),
      updateDescription: String(args.updateDescription || '').trim(),
    });
    return ok(
      r,
      r.pending
        ? '安装包已上传，蒲公英还在解析，稍后刷新即可看到新版本'
        : `上传成功：${r.name} v${r.version}（${formatBytes(r.fileSize)}）`
    );
  },

  /** 34. 修改蒲公英版本信息（更新说明 / 版本号 / 安装方式 / 密码） */
  async update_pgyer_build(args = {}) {
    const buildKey = pickBuildKey(args);
    if (!buildKey) {
      return {
        success: false,
        data: null,
        message: '需要提供 buildKey（从 get_distributed_app 的历史版本里取）',
      };
    }
    const r = await pgyerService.updateBuild(buildKey, {
      updateDescription: args.updateDescription,
      version: args.version,
      installType: args.installType,
      password: args.password,
    });
    return ok(r, `已更新版本 ${buildKey} 的：${r.updated.join('、')}`);
  },

  /** 35. 设置 / 取消「最新版本」标记 */
  async set_pgyer_newest_build(args = {}) {
    const buildKey = pickBuildKey(args);
    if (!buildKey) return { success: false, data: null, message: '需要提供 buildKey' };
    const isNewest = args.isNewest !== false;
    const r = await pgyerService.setNewestBuild(buildKey, isNewest);
    return {
      ...ok(r, isNewest ? `已把 ${buildKey} 设为最新版本` : `已取消 ${buildKey} 的最新版本标记`),
      // 这会直接改变下载页上「最新版是哪个」，属于要留痕的动作
      audit: { before: { buildKey, isNewest: !isNewest }, after: { buildKey, isNewest } },
    };
  },

  /** 36. 删除蒲公英上的一个版本（⛔ 不可恢复） */
  async delete_pgyer_build(args = {}) {
    const buildKey = pickBuildKey(args);
    if (!buildKey) return { success: false, data: null, message: '需要提供 buildKey' };
    const r = await pgyerService.deleteBuild(buildKey);
    return {
      ...ok(r, `已删除版本 ${buildKey}。此操作不可恢复`),
      audit: { before: { buildKey, exists: true }, after: { buildKey, deleted: true } },
    };
  },

  /** 37. 删除蒲公英上的整个应用（⛔ 连历史版本一起删，不可恢复） */
  async delete_pgyer_app(args = {}) {
    const appKey = String(args.appKey || args.app_key || '').trim();
    if (!appKey) return { success: false, data: null, message: '需要提供 appKey' };
    const r = await pgyerService.deleteApp(appKey);
    return {
      ...ok(r, `已删除应用 ${appKey}（含全部历史版本）。此操作不可恢复`),
      audit: { before: { appKey, exists: true }, after: { appKey, deleted: true } },
    };
  },

  /** 32. 计划任务清单（C3，只读） */
  async list_crontabs({ owner, keyword, limit }) {
    const count = clampLimit(limit, 50, 200);
    const data = await baotaService.createClient().listCrontabs();

    const which = owner === 'own' || owner === 'foreign' ? owner : 'all';
    const kw = String(keyword || '')
      .trim()
      .toLowerCase();

    let list = data.tasks;
    if (which !== 'all') list = list.filter((t) => t.owner === which);
    if (kw) list = list.filter((t) => t.name.toLowerCase().includes(kw));

    const shown = list.slice(0, count);
    const basis =
      `${data.total} 个任务（本项目 ${data.ownCount} / 其他项目 ${data.foreignCount}；` +
      `启用 ${data.enabledCount}、停用 ${data.disabledCount}；执行标记为 0 的 ${data.abnormalCount} 个）`;

    if (!shown.length) {
      return ok(
        { ...data, tasks: [], filtered: list.length, scopeNote: data.scopeNote },
        `按条件没筛到任务。全部：${basis}`
      );
    }

    const lines = shown
      .map((t) => {
        const who = t.owner === 'own' ? '本项目' : '其他项目';
        const flag = t.enabled ? '' : '（已停用）';
        return `${t.name}${flag} · ${t.cycle} · ${who}${t.legacyHint ? ' · 疑似排障遗留' : ''}`;
      })
      .join('；');

    return ok(
      {
        ...data,
        tasks: shown,
        filtered: list.length,
        returned: shown.length,
        truncated: list.length > shown.length,
      },
      `${basis}。${shown.length} 条：${lines}`
    );
  },
};

/** 人类可读字节数（与 baota 服务里的实现保持一致） */
function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 按名字或 ID 前缀定位容器
 * AI 常只给容器名，或只给短 ID（12 位），所以这里做多重匹配。
 */
async function resolveContainer(docker, reference) {
  const ref = String(reference || '').trim();
  if (!ref) {
    throw Object.assign(new Error('需要提供容器名或 ID'), { expected: true, status: 400 });
  }

  const all = await docker.listContainers(true);
  const hit =
    all.find((c) => c.name === ref) ||
    all.find((c) => c.id === ref) ||
    all.find((c) => String(c.id).startsWith(ref)) ||
    all.find((c) => String(c.name).includes(ref));

  if (!hit) {
    throw Object.assign(new Error(`找不到容器：${ref}（可先用 list_containers 查看全部容器）`), {
      expected: true,
      status: 404,
    });
  }
  return hit;
}

/**
 * 定位仓库（B4）
 * AI 常常只给「看下最近提交」而不带仓库名，所以省略时用配置里的第一个仓库。
 */
function resolveRepo(reference) {
  const ref = String(reference || '').trim();
  if (ref) return githubService.normalize(ref).full;

  const configured = githubService.configuredRepos();
  if (!configured.length) {
    throw Object.assign(
      new Error('没有可用的仓库：请先到「系统设置 → 代码仓库」填写关注的仓库（格式 owner/repo）'),
      { expected: true, status: 428 }
    );
  }
  return configured[0];
}

/** 把 AI 传的条数夹在 1..max —— 它经常会传 100 这种值 */
function clampLimit(value, fallback, max = 30) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.round(n)));
}

/**
 * 执行一个工具
 * @param {string} name 工具名
 * @param {object} args 参数
 * @returns {Promise<{success:boolean, data:any, message:string}>}
 */
async function callTool(name, args = {}) {
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    return { success: false, data: null, message: `未知工具：${name}` };
  }

  const start = Date.now();
  try {
    const result = await handler(args || {});
    // B6 审计约定：工具可以额外返回 `audit: { before, after }`，由这里写进操作日志。
    // 写完之后就剥掉不再外传 —— 工具对外的返回结构始终是 { success, data, message }，
    // 免得 AI 客户端那边多出一个没人认识的字段。
    const { audit, ...exposed } = result;
    writeLog({
      username: 'mcp',
      module: 'mcp',
      action: name,
      target:
        args.domain ||
        args.name ||
        args.container_id ||
        args.task_id ||
        args.app_name ||
        args.appKey ||
        args.buildKey ||
        args.checkId ||
        null,
      source: 'mcp',
      status: result.success ? 'success' : 'failed',
      message: result.message,
      detail: result.success ? undefined : { args },
      before: audit?.before,
      after: audit?.after,
      durationMs: Date.now() - start,
    });
    return exposed;
  } catch (err) {
    writeLog({
      username: 'mcp',
      module: 'mcp',
      action: name,
      target:
        args.domain ||
        args.name ||
        args.container_id ||
        args.task_id ||
        args.app_name ||
        args.checkId ||
        null,
      source: 'mcp',
      status: 'failed',
      message: err.message,
      durationMs: Date.now() - start,
    });
    return {
      success: false,
      data: err.detail ? { detail: err.detail } : null,
      message: err.message || '工具执行失败',
    };
  }
}

/** 工具名集合，供 server 校验 */
const TOOL_NAMES = TOOL_DEFINITIONS.map((t) => t.name);

module.exports = {
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  TOOL_HANDLERS,
  READONLY_TOOLS,
  WRITE_TOOLS,
  callTool,
};
