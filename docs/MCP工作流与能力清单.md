# MCP 工作流与能力清单 · 艾哥 SaaS 工作台

> 目标：**任何 AI 开发工具（Trae / Cursor / Claude Desktop / Windsurf / VS Code …）接上这一个 MCP，
> 就能接管这台服务器的全部日常运维**——不需要再额外挂「宝塔面板 MCP」或「Cloudflare MCP」。
>
> 本文是「人看的说明书」；AI 侧的等价说明在 `backend/src/mcp/instructions.js`，
> 客户端连接时会自动读到，界面上也能一键复制。

---

## 一、30 秒接入（复制即用）

打开 **系统设置 → MCP 连接 → 复制 MCP 配置**，把得到的那段 JSON 贴进 AI 工具的 MCP 配置里：

```json
{
  "mcpServers": {
    "aige-workbench": {
      "url": "https://aige-saas-mcp.miaocaieyc.com.cn/sse",
      "headers": {
        "Authorization": "Bearer <你的 MCP 令牌>"
      }
    }
  }
}
```

- 令牌不用手填：界面上的「复制 MCP 配置」已经带上真实令牌，粘贴即可用。
- 保存后**重启 AI 工具**，即可看到名为 `aige-workbench` 的 MCP 服务器。
- 健康检查：`GET https://aige-saas-mcp.miaocaieyc.com.cn/health`（返回工具数与当前会话数）。
- 传输协议：SSE。令牌支持三种传法，任选其一：`Authorization: Bearer <token>` / `x-mcp-token: <token>` / `?token=<token>`。

---

## 一·五、只读令牌（给「只需要看」的 AI）

令牌分两档，**级别由「用哪把令牌」决定**，与客户端自称什么无关：

| 令牌 | 能调用的工具 | 怎么来 |
| --- | --- | --- |
| **全权令牌** | 全部 35 个 | 默认就有；「重新生成令牌」可换一把 |
| **只读令牌** | 22 个（下表列出的那些） | **系统设置 → MCP 连接 → 生成只读令牌** |

**只读令牌能用的 22 个**：`get_server_status`、`list_ssl_certs`、`run_health_checks`、
`list_websites`、`get_site_logs`、`get_nginx_config`、`read_file`、`list_directory`、
`list_backups`、`list_domains`、`list_dns_records`、`get_zone_info`、`list_containers`、
`get_container_logs`、`list_images`、`list_app_templates`、`get_deploy_logs`、
`list_repo_commits`、`get_ci_status`、`list_distributed_apps`、`get_distributed_app`、
`list_crontabs`。

**被挡在门外的 13 个写操作**：`create_website`、`delete_website`、`apply_ssl`、
`save_nginx_config`、`add_dns_record`、`update_dns_record`、`delete_dns_record`、
`purge_cloudflare_cache`、`restart_container`、`manage_container`、`deploy_app`、
`apply_health_fix`、`call_bt_api`。

AI 在只读连接下看到的工具清单里**根本没有这 13 个**（不会白试）；即使强行业务调用，
服务端也会返回 `isError: true` 与「只读令牌无权调用…」。

> `run_health_checks` 归只读是个**有意的取舍**：它会写告警记录、可能外发通知，
> 但不碰服务器本身，而它正是只读 AI 最该干的事；告警有指纹去重 + 30 分钟静默窗口，
> 反复触发也刷不了屏。真正会改服务器的是 `apply_health_fix`（写）。

> 🛠 维护须知：工具归类在 `backend/src/mcp/tools.js` 的 `READONLY_TOOLS` / `WRITE_TOOLS`，
> **两份名单必须恰好铺满全部工具且互不重叠**，否则 CI 会红
> （`backend/scripts/selfcheck-mcp-scope.js`，本地 `npm run check:scope`）。

---

## 二、能力清单（35 个工具 · 按用途分组）

### ① 巡检与自愈

| 工具 | 参数 | 做什么 |
| --- | --- | --- |
| `get_server_status` | — | CPU / 内存 / 磁盘 / 负载 + 网站、域名、容器数量，一句话体检 |
| `list_ssl_certs` | — | 全站证书台账：签发者、生效/到期时间、**剩余天数**、状态（ok / expiring / expired） |
| `run_health_checks` | — | **跑一遍自愈巡检**（13 项），每项返回结论 + 是否可一键修复 + 该项的熔断预算 |
| `apply_health_fix` | `checkId` | **执行某项修复**（如 `ssl_expiring` / `container_down` / `disk_watermark`），受熔断约束 |

### ② 网站（宝塔）

| 工具 | 关键参数 | 做什么 |
| --- | --- | --- |
| `list_websites` | `search` `page` `limit` | 站点列表（域名、目录、状态、PHP 版本、备注） |
| `create_website` | `domain` `path?` `ps?` | 新建静态站点，**自动查重**，不覆盖已存在的站 |
| `delete_website` | `domain` | 删除站点（含网站目录）⚠️ 不可恢复 |
| `apply_ssl` | `domain` `mode?` `domains?` | 申请 / 部署证书（默认 Let's Encrypt 自动签发） |
| `get_site_logs` | `site` `type(access\|error)` `lines?` | 读站点访问日志 / 错误日志（尾部 N 行） |
| `get_nginx_config` | `site` | 读站点 Nginx 配置全文 |
| `save_nginx_config` | `site` `content` | 覆盖写配置 ⚠️ 写前自动备份 + 写完 `nginx -t` 试载 |

### ③ 文件与备份

| 工具 | 关键参数 | 做什么 |
| --- | --- | --- |
| `read_file` | `path` `lines?` | 读服务器文件；给 `lines` 即按 tail 只取末尾（看日志用） |
| `list_directory` | `path` | 列目录（名称 / 大小 / 时间 / 权限 / 属主） |
| `list_backups` | — | 宝塔备份台账（`/www/backup` 下按用途分子目录） |

### ④ 域名与 DNS（Cloudflare）

| 工具 | 关键参数 | 做什么 |
| --- | --- | --- |
| `list_domains` | — | 已托管的域名区域（zone）列表 |
| `list_dns_records` | `zone_id?` `domain?` `type?` `search?` | 某区域的解析记录 |
| `add_dns_record` | `type` `name` `content` `proxied?` | 添加解析；**同名同类型自动复用**，不重复创建 |
| `update_dns_record` | `record_id?` / `name` `content?` `proxied?` | 改记录值或切代理开关（比删了重建安全） |
| `delete_dns_record` | `zone_id` `record_id` | 删除解析 ⚠️ 不可恢复 |
| `get_zone_info` | `zone_id?` `domain?` | 区域详情：状态、套餐、DNS 服务器、**SSL 模式** |
| `purge_cloudflare_cache` | `zone_id?` `domain?` `urls?` | 清边缘缓存（不传 `urls` 即全量清） |

### ⑤ Docker

| 工具 | 关键参数 | 做什么 |
| --- | --- | --- |
| `list_containers` | `all?` `state?` `search?` `managed?` | 容器列表，并标记哪些由本工作台部署 |
| `restart_container` | `container_id` | 重启容器（最常用的单动作） |
| `manage_container` | `container` `action(start\|stop\|restart\|remove)` | 完整的启停删 |
| `get_container_logs` | `container` `lines?` | 容器日志（排查启动失败必用） |
| `list_images` | — | 镜像列表（标签 / 大小 / 被引用数） |

### ⑥ 应用部署（本系统独有，宝塔/Cloudflare MCP 都没有）

| 工具 | 关键参数 | 做什么 |
| --- | --- | --- |
| `list_app_templates` | — | 可一键部署的模板（WordPress / NocoDB / Dify / n8n / Uptime Kuma …） |
| `deploy_app` | `app_name` `domain` `wait?` | 一键部署，自动串起「DNS 解析 → 拉镜像 → 起容器 → 申请证书 → 反向代理」 |
| `get_deploy_logs` | `task_id` `since_id?` | 部署进度与增量日志 |

### ⑦ 代码仓库（GitHub · **只读**）

| 工具 | 关键参数 | 做什么 |
| --- | --- | --- |
| `list_repo_commits` | `repo?` `limit?` | 仓库最近提交（作者 / 时间 / 提交信息首行 / 短 SHA）+ 默认分支、语言、最近推送时间 |
| `get_ci_status` | `repo?` `limit?` | GitHub Actions 最近若干次运行的结论、分支、触发方式、耗时 |
| — | — | `repo` 省略时用「系统设置 → 代码仓库」里配置的**第一个**仓库；`limit` 夹在 1–30 |

> ⚠️ 这一组**只能读**，改不了 GitHub 上任何东西。没配令牌时走匿名访问，
> 配额只有 **60 次/小时且按服务器出口 IP 算**（全服务器共用）—— 别拿它做轮询。
> 配一个 Fine-grained 只读 PAT 可升到 5000 次/小时（见 README §16.3）。

### ⑧ 应用分发（蒲公英 · **MCP 侧只读，上传走 REST**）

| 工具 | 关键参数 | 做什么 |
| --- | --- | --- |
| `list_distributed_apps` | `limit?` | 账号下的应用清单：当前版本号 / 版本编号 / 体积 / 上传时间 + **下载页与二维码地址** |
| `get_distributed_app` | `appKey` | 某个应用的全部历史版本（appKey 从上面那个工具拿） |

> ⚠️ **这一组只能读**（蒲公英的写接口里有「上传」和「删除应用」，本工作台刻意没有把它们
> 暴露成 MCP 工具，避免 AI 误删应用）。但**上传安装包是支持的**，走 REST 接口而**不是** MCP 工具：
>
> ```bash
> curl -X POST "https://aige-saas-panel.miaocaieyc.com.cn/api/distribute/upload?fileName=app-release.apk" \
>   -H "Authorization: Bearer <你的登录令牌>" \
>   -H "Content-Type: application/octet-stream" \
>   --data-binary @./app-release.apk
> ```
>
> · 文件**直接作为请求体**（不要用 multipart），单包 ≤ **100MB**（`.apk / .ipa / .hap`）
> · 后端只在内存过一遍就转给蒲公英，**不落服务器磁盘**
> · 没有终端时，在「应用分发」页用拖拽上传区传也一样

### ⑨ 计划任务（宝塔 · **只读**）

| 工具 | 关键参数 | 做什么 |
| --- | --- | --- |
| `list_crontabs` | `owner?` / `keyword?` / `limit?` | 服务器上的**全部**定时任务：名称、周期、启用状态、执行身份、分类，并标 `owner`（own=本项目 / foreign=其他项目）与「疑似排障遗留」 |

> ⚠️ 三条边界，回答「服务器上有什么定时任务在跑」时必须守住：
> 1. 这是**整台机器**的清单，不是本项目的 —— 实测 36 条**全部属于其他项目**；
> 2. **只读**：没有启停 / 删除 / 新增（动任何一个都是动别人的资源）；
> 3. **不含脚本正文**（宝塔返回里那个 `sBody`）：其他项目的脚本里有**明文密钥**，
>    所以字段用白名单挑出来，不是把整条任务丢出去。要看正文请让用户去宝塔面板。
>
> ⚠️ 别答错一件事：**本工作台自己的定时清理不在这个清单里**（它在后端进程里用 `setInterval` 跑），
> 所以「清单里没有 aige 的任务」不代表「工作台什么都没在清理」。

### ⑩ 万能兜底

| 工具 | 关键参数 | 做什么 |
| --- | --- | --- |
| `call_bt_api` | `endpoint` `params?` `method?` | 直接调宝塔任意 API（计划任务、防火墙、FTP、数据库、文件压缩等未封装能力） |

端点参考：<https://www.bt.cn/api-doc/>

---

## 三、常见工作流（AI 照这个顺序调就行）

### 0. 先体检，有问题顺手修掉（推荐每次运维前先做）

```
run_health_checks                    ← 13 项体检：证书到期 / 未部署证书 / 证书链 / 站点 HTTPS 配置 / CF SSL 模式 / DNS 解析 / CF 缓存漂移 / 容器状态 / 重启循环 / 磁盘 / 内存 / 日志膨胀 / 口令自查
apply_health_fix  checkId=ssl_expiring    ← 证书临期批量续签（已过期 + 7 天内到期）
apply_health_fix  checkId=container_down  ← 启动本项目停掉的容器（其他项目容器不会被碰）
apply_health_fix  checkId=disk_watermark  ← 清理 dangling 镜像释放空间
```

- 只有 `fix` 非空的项才可修；`cf_ssl_mode`、`weak_credentials` 故意不提供自动修复 ——
  它们的影响面超出本项目（zone 级 SSL 模式会影响该域名下其他项目的站点），必须由人判断。
- 每项都带 `budget`（熔断预算）：同一动作 30 分钟内最多 3 次。被熔断就说明没真修好，
  应该去查根因而不是继续重试。

### 1. 新增一个二级域名并让它能访问

```
list_dns_records      ← 先查重（同名记录已存在就别建）
add_dns_record        ← type=A, name=完整域名, content=服务器IP, proxied=true
create_website        ← 建站点（自动查重）
apply_ssl             ← 签发证书（需域名已解析到本机且 80 端口可达）
```

### 2. 部署一个新应用

```
list_app_templates    ← 拿到 app_name
deploy_app            ← app_name + domain；默认等部署结束并返回访问地址
get_deploy_logs       ← 想看中途进度时用（传 task_id）
```

### 3. 某个网站打不开了

```
get_site_logs         ← type=error 先看错误日志
get_nginx_config      ← 看配置有没有被改坏（和上次对比）
list_containers       ← 如果是容器应用
get_container_logs    ← 看容器为什么起不来
restart_container     ← 确认是偶发崩溃后重启
```

### 4. 证书巡检 / 续签

```
list_ssl_certs        ← 一次看全：daysLeft + status
apply_ssl             ← 对 expiring / expired 的站点逐个续签
```

### 5. 改了内容但访客还是旧版

```
purge_cloudflare_cache ← 传 domain 全量清；只想清单个页面就传 urls
```

### 6. 磁盘快满了

```
get_server_status     ← 确认磁盘使用率
list_images           ← 找出占空间的镜像
list_containers       ← 找出占空间的容器
list_backups          ← 看老备份能不能清
call_bt_api           ← 走宝塔的清理接口做进一步处理
```

---

## 四、它相对「宝塔 MCP + Cloudflare MCP」覆盖了什么

| 能力 | 宝塔官方 MCP | Cloudflare 官方 MCP | 本工作台 MCP |
| --- | --- | --- | --- |
| 站点列表 / 增删 | ✅ | ✖ | ✅ |
| 站点日志（访问 + 错误） | ✅ | ✖ | ✅ |
| Nginx 配置读写 | ✅ | ✖ | ✅ |
| 文件读取 / 目录列举 | ✅ | ✖ | ✅ |
| 备份台账 | ✅ | ✖ | ✅ |
| 证书台账（剩余天数） | 部分 | ✖ | ✅ |
| 万能 API 兜底 | ✅ | ✖ | ✅ |
| DNS 增 / 改 / 删 | ✖ | 仅增 | ✅ |
| 区域详情 / SSL 模式 | ✖ | ✅ | ✅ |
| 清边缘缓存 | ✖ | ✅ | ✅ |
| 容器启停 / 日志 | ✖ | ✖ | ✅ |
| **一键部署应用（含自动配 HTTPS）** | ✖ | ✖ | ✅ |
| **自愈巡检 + 一键修复（带熔断）** | ✖ | ✖ | ✅ |
| **计划任务清单（只读，不含脚本正文）** | ✖ | ✖ | ✅ |

结论：**只需要接这一个 MCP**。

---

## 五、约定与边界（AI 必须遵守）

1. **参数宽松，不用先查 ID**：`add_dns_record` 只给完整域名即可自动定位区域；
   `manage_container` / `restart_container` 支持容器名或 ID 前几位；`update_dns_record` 可只给记录名。
2. **删除类不可恢复**：`delete_website`（连站点目录一起删）、`delete_dns_record`、
   `manage_container(action=remove)` —— 执行前必须先向用户确认。
3. **改配置有自动保护**：`save_nginx_config` 写前备份原文件（返回 `backupPath`），写完 `nginx -t` 试载。
   强烈建议先 `get_nginx_config` 读一遍再改。
4. **`deploy_app` 默认等部署完成**才返回，单次调用可能耗时几分钟，属正常。
5. **不碰无关项目**：服务器上还跑着其他项目（koyca / tito-* / ogkur 等），
   除非用户明确要求，否则只操作与该需求相关的域名与站点。
6. **危险操作先报名再动手**：涉及删除、覆盖配置、改线上配置时，先说明「要做什么 + 影响范围」。
7. **每一次调用都有留痕**：Web 点击与 MCP 调用统一写入操作日志，
   可在「仪表盘 → 最近操作」或「操作日志」里查。
8. **自愈的边界**（重要）：`run_health_checks` 会把「其他项目的容器已停止」列成 `info` 级，
   那是**只报告**，不要对它执行修复。自动修复的作用域白名单只包含本项目自己的站点与容器。

---

## 六、巡检与自愈的设计说明

### 6.1 十三个检查项

| checkId | 检查什么 | 严重度依据 | 可否自动修 | 修法 |
| --- | --- | --- | --- | --- |
| `ssl_expiring` | 证书到期风险 | 已过期 / ≤7 天 = critical | ✅ 可自动 | 重新签发 Let's Encrypt（单批 ≤10 个，串行） |
| `ssl_missing` | 站点未部署证书 | info | ⚠️ 需确认 | 申请证书（可能因域名未解析失败） |
| `ssl_chain` | 证书链完整性（证书文件里有几张证书） | 证书文件读不到 = critical / 只有 1 张 = warning | ✅ 可自动 | 重新签发（LE 下发的 fullchain 自带中间证书） |
| `site_https_config` | 站点签了证书但 Nginx 没配 443 | warning | ✖ 仅报告 | 不提供 —— 重放证书要读私钥内容且会改站点行为，去宝塔点「部署」更稳妥 |
| `cf_ssl_mode` | CF SSL 模式与源站是否一致 | 回源明文 / 会 526 = critical | ✖ 仅报告 | 不提供 —— zone 级改动会影响其他项目 |
| `dns_drift` | 站点域名在本项目区域内没有解析记录 | warning | ⚠️ 需确认 | 补一条指向本机公网 IP 的 A 记录（**有按钮但不参与自动自愈**，改 DNS 直接影响可达性） |
| `cf_cache_drift` | 首页引用的 js/css 被当成 HTML 返回或 404 | critical | ✅ 可自动 | **按 URL 精确清**这几个资源（不做全量清，避免波及同区域其他项目） |
| `container_down` | 本项目容器是否在跑 | 停着 = critical | ✅ 可自动 | 启动容器（只动本项目 + 应用商店部署的） |
| `container_restart_loop` | 容器重启循环 | 正在重启中 critical / 疑似 warning | ✖ 仅报告 | 不提供 —— 能做的只有停容器或改重启策略，前者让站点下线、后者要重建容器 |
| `disk_watermark` | 磁盘水位 | ≥85% warning / ≥92% critical | ✅ 可自动 | 清理 dangling 镜像（不承载容器，零风险） |
| `memory_watermark` | 内存水位（近 5 分钟最低可用内存） | 可用 <10% critical / <15% warning | ✖ 仅报告 | 不提供 —— 真能释放内存的是重启吃内存的容器；告急时列出占用 Top 的容器供人判断 |
| `log_bloat` | 站点日志体积 | ≥500MB warning / ≥2GB critical | ✖ 仅报告 | 不提供 —— 只有「读/写整文件」能力，重写几 GB 日志会拖垮 2GB 的机器；去宝塔做日志切割 |
| `weak_credentials` | 口令与令牌自查 | 默认口令 / 无 MCP 令牌 = critical | ✖ 仅报告 | 不提供 —— 改密码人立刻登不上，必须由人做 |

> ⚠️ **多数项刻意不给一键修复**。给按钮之前先问一句「点下去真的能解决吗」：
> 「清 dangling 镜像」释放的是磁盘不是内存、「停止重试」没有不动容器的 API、
> 重写几 GB 日志会把这台 2GB 的机器拖垮 —— 这些都是写方案时想当然、实现时被推翻的动作。
> **宁可不给按钮，也不给一个点下去没用的按钮。**

### 6.2 五条安全护栏（「自愈别变自毁」）

1. **作用域白名单**：只对本项目自己的站点与容器自动修复；其他项目的资源只报告。
2. **探测与执行分离**：`inspect()` 只读、绝无副作用；`apply()` 才动手。
3. **熔断**：同一修复 30 分钟内最多 3 次 —— 反复起不来的容器反复重启只会把机器拖垮。
4. **全量留痕**：每次修复（无论成败）都写 `operation_logs`，含目标、动作、风险级别、耗时。
5. **固定注册表**：修复动作只来自代码里注册的 8 项，AI 也只能调 `apply_health_fix(checkId)`，
   不能构造任意指令。

### 6.3 自动自愈（可开关）

- 在「健康巡检」页打开开关即可，配置存在 `settings` 表（`auto_heal_enabled` / `auto_heal_interval_min`），重启后保持。
- 间隔最小 10 分钟，默认 60 分钟。
- **只执行 `fix.auto === true` 的项**（证书续签、启动本项目容器、清理无用镜像），
  其余（改 CF SSL 模式、改密码、补站点证书）始终留给人工确认。
- 每次自动执行的结论会保留在页面「最近一次自动执行」里，同时写入操作日志。

### 6.3.1 事件驱动自愈（C2 · 与自动自愈同生共死）

定时巡检最快也要等一个周期；容器崩了应该**立刻**知道。所以开关一打开，
后端会同时**订阅 Docker 事件流**（`GET /events`，长连接 NDJSON，过滤 `container die`）：

| 环节 | 做法 |
| --- | --- |
| 触发 | 收到事件 → 只看本项目自己的容器（`aige.managed=true` 标签或白名单容器名）→ 调一次 `container_down` 修复 |
| 复用而非另起一套 | 走的就是 `applyFix('container_down')`：同一套白名单、熔断、留痕。容器已被 restart 策略拉起时，`inspect()` 会看到它在运行 → 以「无需修复」结束，不会多余动作 |
| 防风暴 | ① 沿用同一熔断（30 分钟 3 次）；② 同容器 **3 分钟**冷却；③ 全局 **10 秒**防抖 |
| 断线 | 15 秒后自动重连；关掉自动自愈立即断开，不做无开关的常驻连接 |

页面上会显示「已接入 / 未接入」与本次运行已触发次数。

### 6.4 巡检接口（供界面与 AI 用）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/inspect` | 跑一遍巡检，返回各项结论 + 自动自愈 / 事件驱动状态 |
| POST | `/api/inspect/fix` | `{ checkId }` 执行某项修复 |
| PUT | `/api/inspect/auto` | `{ enabled, intervalMin }` 开关自动自愈（同时开关事件驱动） |
| POST | `/api/inspect/auto/run` | 立刻跑一轮自动自愈 |

### 6.5 操作日志保留策略

`operation_logs` 与指标、告警同一套模式：**保留 90 天 + 最多 20000 条**（双保险），
启动清一次 + 每天一次。此前这张表只写不清，MCP 高频调用几天就能堆上万行。

---

## 七、返回结构约定

所有工具统一返回 `{ success, data, message }`：

```json
{
  "success": true,
  "message": "已获取 3 个网站",
  "data": { "list": [], "total": 3 }
}
```

AI 侧同时能拿到一段人类可读的文本（`✅ <message>` + 结构化 JSON），
失败时 `success=false` 且 `isError=true`，`message` 里带可执行的修复提示。
