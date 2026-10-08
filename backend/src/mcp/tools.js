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
const { listTemplates } = require('../services/apps');
const { writeLog } = require('../utils/logger');

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

  // 自愈修复
  'apply_health_fix',

  // 万能兜底：可以触达宝塔任意写接口，必须算写
  'call_bt_api',
]);

/** 统一成功结果 */
const ok = (data, message = '操作成功') => ({ success: true, data: data ?? null, message });

/** 把域名解析成 zone_id（zone_id 缺省时使用） */
async function resolveZoneId({ zone_id, domain }) {
  if (zone_id) return zone_id;
  if (!domain) {
    throw Object.assign(new Error('需要提供 zone_id，或提供完整域名以便自动定位'), {
      expected: true,
      status: 400,
    });
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
  async list_dns_records({ zone_id, domain, type = '', search = '' }) {
    const zoneId = await resolveZoneId({ zone_id, domain });
    const records = await cloudflareService.createClient().listDnsRecords(zoneId, { type, search });
    return ok({ zoneId, list: records, total: records.length }, `共 ${records.length} 条解析记录`);
  },

  /** 8. 添加 DNS 记录 */
  async add_dns_record({ zone_id, type, name, content, proxied = true, ttl, priority }) {
    if (!type || !name || !content) {
      return { success: false, data: null, message: 'type、name、content 均为必填' };
    }
    const zoneId = await resolveZoneId({ zone_id, domain: name });
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
  async delete_dns_record({ zone_id, record_id }) {
    if (!zone_id || !record_id)
      return { success: false, data: null, message: 'zone_id 与 record_id 均为必填' };
    const result = await cloudflareService.createClient().deleteDnsRecord(zone_id, record_id);
    return ok(result, `解析已删除（record_id: ${record_id}）`);
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
  async get_site_logs({ site, type = 'access', lines = 100 }) {
    if (!site) return { success: false, data: null, message: '需要提供 site（网站域名）' };
    const res = await baotaService.createClient().getSiteLogs(site, { type, lines });
    return ok(
      res,
      `${site} 的${type === 'error' ? '错误' : '访问'}日志（末尾 ${res.returnedLines} 行，共 ${res.totalLines} 行）`
    );
  },

  /** 15. 读取站点 Nginx 配置 */
  async get_nginx_config({ site }) {
    if (!site) return { success: false, data: null, message: '需要提供 site（网站域名）' };
    const res = await baotaService.createClient().getNginxConfig(site);
    return ok(res, `已读取 ${site} 的 Nginx 配置（${res.content.length} 字符）`);
  },

  /** 16. 写入站点 Nginx 配置（自动备份 + 试载） */
  async save_nginx_config({ site, content }) {
    if (!site || !content)
      return { success: false, data: null, message: '需要提供 site 与 content' };
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

  /** 22. 修改 DNS 记录 */
  async update_dns_record({ zone_id, domain, record_id, name, type, content, proxied }) {
    if (content === undefined && proxied === undefined) {
      return {
        success: false,
        data: null,
        message: 'content 与 proxied 至少要给一个，否则没有要改的内容',
      };
    }
    const cf = cloudflareService.createClient();
    const zoneId = await resolveZoneId({ zone_id, domain });

    // 没给 record_id 就用 name（+可选 type）定位
    let recordId = record_id;
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
  async purge_cloudflare_cache({ zone_id, domain, urls }) {
    const zoneId = await resolveZoneId({ zone_id, domain });
    const res = await cloudflareService.createClient().purgeCache(zoneId, { urls });
    return ok(
      res,
      res.mode === 'everything' ? '已提交全量缓存清理' : `已提交 ${urls.length} 个 URL 的缓存清理`
    );
  },

  /** 24. 区域详情 */
  async get_zone_info({ zone_id, domain }) {
    const zoneId = await resolveZoneId({ zone_id, domain });
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

/** 把 AI 传的条数夹在 1..30 —— 它经常会传 100 这种值 */
function clampLimit(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(30, Math.max(1, Math.round(n)));
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
