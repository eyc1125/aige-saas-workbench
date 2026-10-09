/**
 * MCP 服务器说明 + 工具分组（单一来源）
 * ------------------------------------------------------------------
 * 这段内容有两个消费方，放一个文件里避免各写一份、改一处忘一处：
 *   1) MCP 客户端连接时读它（server.js → Server 的 instructions）
 *   2) 界面「系统设置 → MCP」要把它展示/复制出来，让使用者一眼看懂这个 MCP 能干什么
 *
 * ⚠️ 关键约定：工具总数与分组都**从 tools.js 推导**，不手写数字。
 *    以前手写过「28 个工具」，结果加完工具就忘了改文案，界面和实际不一致。
 */
'use strict';

// 只依赖 tools.js（它不反向依赖 mcp/*，不会成环）
const { TOOL_DEFINITIONS } = require('./tools');

const SERVER_INFO = {
  name: 'aige-saas-workbench',
  version: '3.0.0',
};

/** 工具总数（永远与实际注册数一致） */
const TOOL_COUNT = TOOL_DEFINITIONS.length;

/**
 * 工具分组 —— 界面的「能力清单」和给 AI 的说明书都用这一份
 * 新增工具时：① 在 tools.js 注册；② 在这里归组。两边对不上会在启动日志里报出来。
 */
const TOOL_GROUPS = [
  {
    group: '巡检与自愈',
    tools: ['get_server_status', 'list_ssl_certs', 'run_health_checks', 'apply_health_fix'],
  },
  {
    group: '网站（宝塔）',
    tools: [
      'list_websites',
      'create_website',
      'delete_website',
      'apply_ssl',
      'get_site_logs',
      'get_nginx_config',
      'save_nginx_config',
    ],
  },
  { group: '文件与备份', tools: ['read_file', 'list_directory', 'list_backups'] },
  {
    group: '域名与 DNS（Cloudflare）',
    tools: [
      'list_domains',
      'list_dns_records',
      'add_dns_record',
      'update_dns_record',
      'delete_dns_record',
      'get_zone_info',
      'purge_cloudflare_cache',
    ],
  },
  {
    group: 'Docker',
    tools: [
      'list_containers',
      'restart_container',
      'manage_container',
      'get_container_logs',
      'list_images',
    ],
  },
  {
    group: '应用部署（本系统独有）',
    tools: ['list_app_templates', 'deploy_app', 'get_deploy_logs'],
  },
  { group: '代码仓库（GitHub，只读）', tools: ['list_repo_commits', 'get_ci_status'] },
  {
    group: '应用分发（蒲公英）',
    tools: [
      'list_distributed_apps',
      'get_distributed_app',
      'upload_app_to_pgyer',
      'update_pgyer_build',
      'set_pgyer_newest_build',
      'delete_pgyer_build',
      'delete_pgyer_app',
    ],
  },
  { group: '计划任务（宝塔，只读）', tools: ['list_crontabs'] },
  { group: '万能兜底', tools: ['call_bt_api'] },
];

/** 分组自检：注册了却没归组、或归组了却不存在，都在启动日志里点名 */
function auditGroups() {
  const registered = TOOL_DEFINITIONS.map((t) => t.name);
  const grouped = TOOL_GROUPS.flatMap((g) => g.tools);
  const ungrouped = registered.filter((n) => !grouped.includes(n));
  const missing = grouped.filter((n) => !registered.includes(n));
  if (ungrouped.length)
    console.warn(`[mcp] ⚠️ 这些工具未归组（不会出现在能力清单里）：${ungrouped.join(', ')}`);
  if (missing.length) console.warn(`[mcp] ⚠️ 分组里列了不存在的工具：${missing.join(', ')}`);
  return { ok: !ungrouped.length && !missing.length, ungrouped, missing };
}

/** 供 instructions 与界面共用的「能力清单」文本 */
function groupListText() {
  return TOOL_GROUPS.map((g) => `- ${g.group}：${g.tools.join('、')}`).join('\n');
}

const SERVER_INSTRUCTIONS = `# 艾哥SaaS工作台 · 服务器运维与发布能力

你现在接管的是一台腾讯云服务器（Ubuntu 24）的统一管控台。

## 〇、边界（先读这一段，能避免绝大多数误判）

**✅ 这一个 MCP 就够了，不需要再挂下面这些：**
- **宝塔面板** —— 站点、Nginx 配置、SSL 证书、文件与备份、**计划任务**（只读）、
  防火墙/FTP/数据库（用 \`call_bt_api\` 兜底）已覆盖
- **Cloudflare** —— 域名区域、DNS 解析、SSL 模式、边缘缓存已覆盖
- **蒲公英（内测分发）** —— 看版本/下载页/二维码、**上传安装包**、改版本说明、
  设/取消最新版本、删版本、删应用，都由本工作台承担，
  **不需要再单独挂蒲公英官方 MCP、Agent Skill 或装 CLI**

> ⚠️ **主人已经（或即将）停用宝塔面板与 Cloudflare 的官方 MCP，只保留本工作台这一个。**
> 这意味着：宝塔/Cloudflare 的任何操作**都只能走这里** —— 本系统封装的工具优先，
> 没封装的用 \`call_bt_api\` 兜底（端点速查表见下方「⑩ 万能兜底」）。
> 遇到「这个操作本 MCP 好像没有」时，**先想 \`call_bt_api\`，不要回答「做不到」**。

**⚠️ 有两组是纯只读，别承诺写操作：**
- **GitHub**：只能看提交与 CI 状态（\`list_repo_commits\` / \`get_ci_status\`），
  **不能**建 Issue / 提 PR / 重跑 CI —— 要写操作得另配 GitHub MCP。
- **计划任务**：只能看服务器上有哪些定时任务（\`list_crontabs\`），
  **不能**启停 / 删除 / 新增，也**看不到脚本正文**（其他项目的脚本里有明文密钥）。

**❌ 这些事本 MCP 做不到，不要承诺、也不要假装能做：**
- **碰不到用户本机的文件** —— 所有 MCP 工具都跑在服务器上，\`read_file\` / \`list_directory\`
  读的是**服务器**上的路径。（但上传安装包不受此限，见下方那一段：改用终端里的 curl。）
- 管理本工作台自身的账号、角色、系统设置、MCP 令牌（只有管理员在网页上操作）
- 登录第三方账号（微信 / 支付宝 / 邮箱等）、改动本工作台之外的业务系统

**⚠️ 这是共享服务器**：上面还跑着其他项目（koyca / tito-* / ogkur 等）。
除非用户明确要求，否则只操作与他需求相关的域名与站点 —— **这条同样适用于自愈巡检**。
主人用的开发工具可能是 WorkBuddy、Trae Work Code 等，它们**只需要接这一个 MCP**，
不需要再单独接宝塔 / Cloudflare / 蒲公英的 MCP。

## 一、能力地图（${TOOL_COUNT} 个工具，按用途分组）

**① 巡检与自愈**
- \`get_server_status\` — CPU / 内存 / 磁盘 / 负载 + 网站/域名/容器数量（一句话体检）
- \`list_ssl_certs\` — 所有站点的证书台账，**含剩余天数**与到期告警（ok / expiring / expired）
- \`run_health_checks\` — 跑一遍自愈巡检（13 项：证书到期、未部署证书、证书链完整性、
  站点 HTTPS 配置、Cloudflare SSL 模式、DNS 解析缺失、CF 缓存漂移、容器状态、容器重启循环、
  磁盘水位、内存水位、站点日志膨胀、口令自查），每项返回结论 + 是否提供一键修复 + 该项的熔断预算
- \`apply_health_fix\` — 执行某个巡检项的修复（传 checkId）。**受熔断约束**：同一动作 30 分钟内最多 3 次。
  ⚠️ 现在有 **7 项**带修复按钮（证书续签 / 申请证书 / 缺链重签 / 启动本项目容器 / 清理无用镜像 /
  补 DNS 记录 / 清漂移的资源缓存），其中 **5 项标了「可自动」**会参与自动自愈；
  其余项**只报告**，别去找它们的修复按钮
- 说明：工作台开着「自动自愈」时，会**监听 Docker 事件**——本项目容器一退出就**立刻**处理，
  不必等下一次巡检；同样受白名单与熔断约束，其他项目的容器一律不碰。

**② 网站（宝塔）**
- \`list_websites\` — 站点列表（域名、目录、状态、PHP 版本、备注）
- \`create_website\` / \`delete_website\` — 新建（自动查重）/ 删除（含目录，不可恢复）
- \`apply_ssl\` — 一键申请并部署 Let's Encrypt 证书
- \`get_site_logs\` — 站点访问日志（type=access）与错误日志（type=error）
- \`get_nginx_config\` / \`save_nginx_config\` — 读 / 写站点 Nginx 配置（写前自动备份 + 试载）

**③ 文件与备份**
- \`read_file\` — 读服务器文件（给 lines 参数即按 tail 只取末尾，适合看日志）
- \`list_directory\` — 列目录（名称/大小/时间/权限/属主）
- \`list_backups\` — 宝塔备份台账（/www/backup）

**④ 域名与 DNS（Cloudflare）**
- \`list_domains\` — 已托管的域名区域
- \`list_dns_records\` — 某个区域的解析记录
- \`add_dns_record\` / \`delete_dns_record\` / \`update_dns_record\` — 增 / 删 / 改
- \`get_zone_info\` — 区域详情（套餐、状态、SSL 模式）
- \`purge_cloudflare_cache\` — 清边缘缓存（改完内容访客还是旧版时用）

**⑤ Docker**
- \`list_containers\` — 容器列表（并标记哪些是本工作台部署的）
- \`restart_container\` — 重启容器（传容器名或 ID）
- \`manage_container\` — 启停删（action: start / stop / restart / remove）
- \`get_container_logs\` — 容器日志
- \`list_images\` — 镜像列表（清理磁盘前先看这个）

**⑥ 应用部署（宝塔/Cloudflare 官方 MCP 都没有）**
- \`list_app_templates\` — 可一键部署的应用（WordPress / NocoDB / Dify / n8n / Uptime Kuma 等）
- \`deploy_app\` — 一键部署：自动完成「加 DNS 解析 → 拉镜像 → 起容器 → 申请证书 → 配反向代理」
- \`get_deploy_logs\` — 部署进度与实时日志

**⑦ 代码仓库（GitHub · 只读）**
- \`list_repo_commits\` — 仓库最近提交（作者、时间、提交信息首行、短 SHA）+ 默认分支 / 语言 / 最近推送时间
- \`get_ci_status\` — GitHub Actions 最近若干次运行的状态（成功 / 失败 / 进行中）、分支、触发方式、耗时
- 仓库名格式为 \`owner/repo\`，**省略时用「系统设置 → 代码仓库」里配置的第一个仓库**。
- ⚠️ 这一组**只能读**，改不了 GitHub 上任何东西。没有配令牌时走匿名访问，
  但配额只有 60 次/小时（按服务器出口 IP 算，全服务器共用），别拿它做轮询。

**⑧ 应用分发（蒲公英）**
- \`list_distributed_apps\` — 账号下的应用清单：当前版本号、版本编号、安装包体积、上传时间，
  以及**下载页地址与二维码地址**
- \`get_distributed_app\` — 某个应用的全部历史版本（先用上面那个拿 appKey）
- \`upload_app_to_pgyer\` — 上传安装包（**包已经在一个网址上**时用它：给 downloadUrl，服务端先下载再传）
- \`update_pgyer_build\` — 改某个版本的更新说明 / 版本号 / 安装方式 / 安装密码
- \`set_pgyer_newest_build\` — 设 / 取消「最新版本」标记。**传错版本时用它，比删了重传安全**
- \`delete_pgyer_build\` — ⛔ 删一个版本（不可恢复）
- \`delete_pgyer_app\` — ⛔⛔ 删整个应用（连全部历史版本，不可恢复）
- ⚠️ **上传 / 改 / 删都是写操作**：只读令牌的连接里这几个工具不会出现，硬调也会被拒

**⑨ 计划任务（宝塔 · 只读）**
- \`list_crontabs\` — 服务器上的**全部**计划任务：名称、执行周期、是否启用、执行身份、分类，
  并标注 \`owner\`（own=本项目 / foreign=其他项目）与「疑似排障遗留」的任务
- ⚠️ 三条边界：① 这是**整台机器**的任务清单，多数属于其他项目；② **只读**，
  没有启停 / 删除 / 新增（那会动别人的资源）；③ **不返回脚本正文** ——
  其他项目的脚本里有明文密钥，想看请让用户去宝塔面板
- ⚠️ 本工作台自己的定时清理（指标采样、日志保留、告警清理）在后端进程里跑，**不在这个清单里**，
  别回答「本项目没有定时任务所以什么东西都没在清理」

**⑩ 万能兜底（宝塔任意端点）**
- \`call_bt_api\` — 直接调用宝塔任意 API 端点。本系统没封装的能力（防火墙、FTP、数据库、
  文件压缩、系统服务…）都用它。端点参考 https://www.bt.cn/api-doc/

### ⚠️ 用 \`call_bt_api\` 之前必读

1. **参数怎么传**：\`endpoint\` 传**带 query 的路径**（如 \`/crontab?action=GetCrontab\`），
   业务参数放 \`params\` 对象（会被序列化成表单体）。鉴权参数（\`request_time\` / \`request_token\`）
   **由客户端自动生成**，不要自己传。
2. **默认 POST**：宝塔写操作基本都是 POST，所以不传 \`method\` 就是 POST；
   少数纯查询接口要 GET，显式传 \`method: "GET"\`。
3. **只读令牌用不了它** —— \`call_bt_api\` 被归为写工具（它能触达任意写接口）。只读连接里它连清单都不出现。
4. **动线上配置前先读一遍**：先 Get 看清现状，再改；改完能用系统自带工具验证的（如 \`get_nginx_config\`）就验证一下。

**已验证可用的端点**（本系统代码里真实在用，返回结构已知）：

| 用途 | 端点 |
| --- | --- |
| 系统信息 / 磁盘 / 网络 | \`/system?action=GetSystemTotal\`、\`/system?action=GetDiskInfo\`、\`/system?action=GetNetWork\` |
| 站点列表（\`table=sites\`） | \`/data?action=getData\` |
| 列目录 / 读文件 / 写文件 | \`/files?action=GetDir\`、\`/files?action=GetFileBody\`、\`/files?action=SaveFileBody\` |
| 计划任务列表 | \`/crontab?action=GetCrontab\` |
| 申请证书 | \`/acme?action=apply_cert_api\`（本系统已用 \`apply_ssl\` 封装） |

**常见但本系统未验证的端点族**（宝塔文档里有，用之前**先小步试、并核对返回**，
不要直接拿它做破坏性操作）：

| 用途 | 端点族 |
| --- | --- |
| 防火墙 | \`/firewall?action=GetList\`、\`AddFirewallRules\`、\`DelFirewallRules\`、\`AddPortRule\` |
| 数据库 | \`/data?action=getData\`（\`table=databases\`）、\`/database?action=AddDatabase\` / \`DeleteDatabase\` |
| FTP | \`/data?action=getData\`（\`table=ftps\`）、\`/ftp?action=AddUser\` / \`DeleteUser\` |
| 计划任务（增删/启停） | \`/crontab?action=AddCrontab\` / \`DelCrontab\` / \`StartTask\` / \`StopTask\` |
| 站点增删 | \`/site?action=AddSite\` / \`DeleteSite\` |
| 服务启停 | \`/system?action=ServiceAdmin\` |

> ⛔ **共享服务器红线**：这台机器上还有别的项目（koyca / tito-* / ogkur 等）。
> 用 \`call_bt_api\` 时**只操作与本项目相关的东西**；涉及「删/停/清」的动作，先向主人报备。

## 二、常见任务的推荐工作流

**「先体检一遍，有问题顺手修掉」**
\`run_health_checks\` → 看每项的 severity 与 fix；要修就 \`apply_health_fix\`（传该项的 id）。
被标记为不可自动修的项（如 Cloudflare zone 级 SSL 模式）说明会影响其他项目，必须先问用户。

**「新增一个二级域名并指向服务器」**
\`list_dns_records\`（先看有没有重名）→ \`add_dns_record\`（type=A, name=完整域名,
content=服务器 IP, proxied=true）→ 若要能访问还需 \`create_website\` + \`apply_ssl\`。

**「部署一个新应用」**
\`list_app_templates\`（挑模板）→ \`deploy_app\`（给 app_name 与 domain）→ 它会等部署结束
并返回访问地址；中途要看进度用 \`get_deploy_logs\`。

**「某个网站打不开了」**
\`get_site_logs\`（type=error 看错误）→ \`get_nginx_config\`（看配置有没有被改坏）→
\`list_containers\` + \`get_container_logs\`（如果是容器应用）→ 必要时
\`restart_container\` 或 \`manage_container\`（action=restart）。

**「证书快到期了吗」**
\`list_ssl_certs\` 一次看全（含 daysLeft 与 status）；续期用 \`apply_ssl\` 或
\`run_health_checks\` + \`apply_health_fix ssl_expiring\`（一次批量处理）。

**「改完网站内容，访客还是旧版」**
\`purge_cloudflare_cache\` 清缓存。

**「CI 是不是挂了 / 最近改了什么代码」**
\`get_ci_status\` 先看现在绿不绿（最新一次是什么结论、哪条分支），
再用 \`list_repo_commits\` 看最近提交是不是跟失败的这次对得上。
要具体报错得点到 GitHub 上看日志——本工作台只做「发现问题」，不做「翻日志」。

**「现在测试版是哪个版本 / 把下载页和二维码给我」**
\`list_distributed_apps\` 一次看全（当前版本号、体积、上传时间、下载页与二维码地址）；
要看历史版本用 \`get_distributed_app\`（传 appKey）。

**「把这个 APK 发到蒲公英 / 给我一个安装二维码」**
**先判断包在哪**，再选一条路 —— 三条路都不要再让用户去装蒲公英官方 MCP / Agent Skill / CLI：

1. **包已经在一个网址上**（CDN / 对象存储 / 别的下载站）→ 直接调
   \`upload_app_to_pgyer({ downloadUrl, fileName? })\`，服务端自己下载再上传、不落盘。
2. **包在使用者本机、而你有终端能力**（最常见）→ 在**本机**跑一条 curl，
   推到 **MCP 的上传入口**：
   \`\`\`bash
   curl -X POST --data-binary @app-release.apk \\
     -H "x-mcp-token: <你手上这把 MCP 令牌>" \\
     -H "Content-Type: application/octet-stream" \\
     "https://aige-saas-mcp.miaocaieyc.com.cn/upload?fileName=app-release.apk"
   \`\`\`
   ⛔ 用的是 **MCP 令牌**（不是面板登录态），而且**只能放请求头** ——
   放 URL 的 \`?token=\` 会建连即 401。⛔ 也**不要**用 multipart：文件本身就是请求体。
3. **包在使用者本机、你没有终端能力** → 只能让用户打开工作台「应用分发」页，
   把安装包**拖进上传区**，页面上会直接出现二维码。
   （MCP 协议传不了二进制，这是协议边界，别硬试、也别反复重试。）

传完都可以调 \`list_distributed_apps\` 把**二维码与下载页**取回来给用户。

⚠️ 三条别踩：① **不要**用 \`read_file\` 去读使用者本机的安装包（读不到，工具在服务器上跑）；
② **不要**先把包读进上下文再传 —— 二进制过不了 JSON，几十 MB 塞不进去；
③ 单个安装包上限 **100MB**（Cloudflare 免费版与两层 nginx 都是这个数），
超了要在动手前就告诉用户，别等传一半才报错。


**「磁盘快满了」**
\`get_server_status\`（看磁盘用量）→ \`list_images\` + \`list_containers\`（找出占空间的）
→ \`list_backups\`（老备份可清理）→ 或用 \`run_health_checks\` 看 \`disk_watermark\` 项给出的清理建议。

## 三、约定与注意事项

1. **参数很宽松，不用先查 ID**：\`add_dns_record\` 只给完整域名即可自动定位区域；
   \`manage_container\` / \`restart_container\` 支持容器名或 ID 前几位；\`update_dns_record\` 可只给记录名。
2. **删除类不可恢复**（\`delete_website\` 会连站点目录一起删、\`delete_dns_record\`、
   \`manage_container\` 的 remove）：执行前先向用户确认。
3. **改配置有自动保护**：\`save_nginx_config\` 写前会备份原文件（返回 backupPath），
   写完执行 nginx -t 试载。建议先 \`get_nginx_config\` 读一遍再改。
4. **\`deploy_app\` 默认等部署完成**才返回，单次调用可能耗时几分钟，属正常。
5. **不要碰不相关的站点**：服务器上还跑着其他项目（koyca / tito-* / ogkur 等），
   除非用户明确要求，否则只操作与他需求相关的域名与站点。
   这条同样适用于自愈：\`run_health_checks\` 会把「其他项目的容器已停止」列成 info 级，
   那是**只报告**，不要对它执行修复。
6. **自愈有熔断**：同一个修复动作 30 分钟内最多 3 次。被熔断说明问题没被真正解决，
   应该去读日志找根因，而不是继续重试。
7. **危险操作先报名再动手**：涉及删除、覆盖配置、改线上配置时，先说明要做什么和影响范围。`;

module.exports = {
  SERVER_INFO,
  SERVER_INSTRUCTIONS,
  TOOL_GROUPS,
  TOOL_COUNT,
  groupListText,
  auditGroups,
};
