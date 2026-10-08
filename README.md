<img src="frontend/public/brand-logo.jpg" alt="艾哥 SaaS 工作台" width="260" />

# 艾哥 SaaS 工作台 · MVP

一个自托管的服务器统一管控台：**一个界面管好整台服务器**（网站 / 域名 / Docker / 应用部署），
并对外暴露 **MCP Server**，让 Trae、Cursor 等 AI 工具直接调用它干活。

宝塔面板退居底层，只负责运行本系统和提供基础 API。

> **品牌资源说明**：站点图标、侧栏标识、分享预览全部来自 `frontend/public/brand-logo.jpg`，
> **所有尺寸都使用整幅 logo，不做裁切**。这些 PNG 由 `tools/gen-brand-icons.ps1` 生成 ——
> 换 logo 时替换 `brand-logo.jpg` 后重跑脚本，**不要手改生成的 PNG**。

---

## 一、能力总览

| 模块 | 能做什么 |
| --- | --- |
| 仪表盘 | CPU / 内存 / 磁盘 / 负载 + **资源趋势曲线**（后端落库，2 分钟一条、保留 30 天，可切 1 小时 ~ 30 天），网站·域名·容器·部署统计，**证书到期提醒**，最近操作日志 |
| 网站管理 | 宝塔站点列表（含**证书剩余天数**）、一键新建静态站、删除、申请 SSL，**站点日志 / Nginx 配置查看**，**配置变更历史 + 一键回滚**（B2） |
| 证书与安全 | **全站证书台账 + 到期倒计时**（口径与宝塔一致）、巡检结论、单个/批量续签 |
| 健康巡检 | **6 项自动体检 + 一键修复 + 自动自愈**（带作用域白名单、熔断与全量留痕） |
| 告警中心 | 顶栏铃铛 + 未读红点 + 抽屉列表；**同一问题按指纹去重**，巡检/部署/自愈失败为触发源；支持通用 Webhook、**飞书机器人（含「签名校验」）、企业微信群机器人**（三个通道可同时开、并行推送） |
| 域名管理 | Cloudflare 域名区域、DNS 记录增删改、橙色云/灰色云一键切换 |
| Docker 管理 | 容器列表与筛选、启动/停止/重启/删除、**实时日志**（SSE 推送）、镜像列表 |
| 应用商店 | 5 个预置应用一键部署（Uptime Kuma / n8n / NocoDB / WordPress / Dify），自动配域名 + 反向代理 + HTTPS，带实时部署日志 |
| 代码仓库 | GitHub 只读看板：最近提交、**Actions 运行状态**（最新一次的结论放大展示，失败一眼看得出来）、开放中的 Issue 与 PR、多仓库切换；**60 秒缓存 + 配额可见**（匿名 60 次/小时 / 配只读令牌 5000 次/小时） |
| 系统设置 | 宝塔 / Cloudflare / Docker / **GitHub** 对接与连通性测试、**MCP 一键复制配置与接入说明**（含只读令牌）、**登录二次验证（TOTP + 恢复码）**、**用户与角色管理**、管理员账号、**外观（6 套主题色 + 明暗模式）**、运行环境（整页仅管理员可进） |
| MCP Server | **32 个工具**（覆盖宝塔 + Cloudflare + Docker + 应用部署 + 自愈巡检 + GitHub 仓库只读），stdio 与 SSE 双传输，**支持只读令牌分级**（给只需要查的 AI 一把不能改的凭据；只读可见 19 个） |

> MCP 的完整能力清单与工作流见 **[docs/MCP工作流与能力清单.md](docs/MCP工作流与能力清单.md)**。
> 后续优化路线与优先级见 **[docs/全面优化方案.md](docs/全面优化方案.md)**。

---

## 一·五、版本管理、CI 与工程工具链

- 本项目已纳入 Git（分支 `main`），远端 `https://github.com/eyc1125/aige-saas-workbench`。`.gitattributes` 强制 **LF** 换行 ——
  Windows 上开发、Linux 上部署，CRLF 会让 shell 脚本与 GitHub Actions 直接报错。
- 不入库：`.env`（真实密钥）、`data/`（SQLite）、`.deploy/`（现场脚本）、`.qa/shots/`（验收截图）、`node_modules/`。

### CI（`.github/workflows/ci.yml`）· 4 个 job

| job | 查什么 |
| --- | --- |
| **规范检查** | Prettier 格式 + ESLint + commitlint 提交信息规范 |
| **后端语法** | `node --check` 全量源码 + 必需文件齐备 + 明文密钥扫描 + **飞书签名 / TOTP 与官方向量逐字节比对**（两个自检都零依赖） |
| **MCP 工具分组自检** | 工具数 / 分组 / 说明文字三者必须一致（防文档漂移）+ **只读/写归类必须铺满全部工具**（CI 会真跑 `selfcheck-mcp-scope.js`）+ **每个模块必须挂权限中间件**（遍历真实路由栈，漏一个直接红） |
| **前端构建** | 真跑 `vite build` + 报告产物体积 + **首屏预算看门狗**（>220KB gzip 直接失败） |

> 首屏预算这条是硬闸门：本项目就是从 427KB 压到 154KB 才解决「打开就卡一下」的，
> 加预算防止后面有人不小心把大依赖又拽回入口。

### 安全扫描（`.github/workflows/security.yml`）· push + 每周一

- **CodeQL** —— 读我们自己写的代码。本项目有一批「把用户输入拼进命令/路径」的地方
  （宝塔、Docker、证书路径），正是它擅长的场景。
- **Trivy** —— 读依赖与配置：CVE、Dockerfile/compose 配置问题、误提交的密钥。
  目前**只报告不拦路**（首次接入先做基线），结果进 GitHub 的 **Security → Code scanning** 面板。
- **Dependabot** —— 依赖 + GitHub Actions 版本升级，按生态分组、每周一次、同时最多 5 个 PR。

### 本地怎么跑

```bash
npm install          # 只装仓库级工具（ESLint / Prettier / commitlint），业务依赖在 backend / frontend 各自装

npm run check        # 格式检查 + ESLint（提交前跑一次）
npm run lint:fix     # 自动修可修的
npm run format       # Prettier 格式化
```

> **分工约定**：ESLint 只管「写错会出 bug」（未使用变量、意外全局、`n/no-extraneous-require`），
> Prettier 只管「长什么样」。两者靠 `eslint-config-prettier` 解耦，不会互相纠正。
> 不要把格式规则加进 ESLint —— 那会让两边打架，最后所有人都用 `--no-verify` 绕过。


---

## 二、技术栈

- **前端**：Vue 3 + Vite + Element Plus + Pinia + Vue Router + Axios + ECharts
- **后端**：Node.js + Express
- **数据库**：SQLite（better-sqlite3）
- **MCP**：`@modelcontextprotocol/sdk`（官方 SDK）
- **容器化**：Docker + docker-compose
- **反向代理**：宝塔 Nginx

---

## 三、目录结构

```
aige-saas-workbench/
├── frontend/                    # Vue3 前端
│   ├── src/
│   │   ├── api/                 # 接口封装（request.js 统一解包与错误提示）
│   │   ├── components/          # 公共组件（StatCard / StateBlock / CopyBtn / ReadOnlyNotice）
│   │   ├── layouts/             # MainLayout（侧边导航 + 顶栏）
│   │   ├── router/              # 路由 + 登录守卫 + 仅管理员页面的角色守卫
│   │   ├── stores/              # Pinia：auth（含角色判定）/ theme
│   │   ├── styles/              # 设计令牌 + 全局样式 + EP 主题桥接
│   │   └── views/               # 9 个页面 + 登录页 + 404
│   ├── nginx.conf               # 容器内站点配置（含 /api 反向代理）
│   └── Dockerfile
├── backend/                     # Node.js 后端
│   ├── src/
│   │   ├── db/                  # SQLite 连接（driver.js 含驱动回退）、schema.sql、migrate()
│   │   ├── middleware/          # auth（JWT + 角色现查）/ permissions（权限规则表）/ 错误处理 / 限流
│   │   ├── routes/              # REST 路由（11 个模块，含 users 用户管理）
│   │   ├── services/            # baota / cloudflare / docker / deploy / apps / settings / metrics / github
│   │   ├── mcp/                 # MCP Server：server.js（SSE）/ stdio.js / tools.js / instructions.js
│   │   ├── utils/               # 加密 / 统一响应 / 日志 / HTTP / 错误类 / TOTP
│   │   ├── app.js               # Express 装配
│   │   ├── config.js            # 配置中心（含生产环境安全自检）
│   │   └── index.js             # 入口（同时起 3000 API 与 3001 MCP）
│   └── Dockerfile
├── docker-compose.yml           # 一键部署编排
├── .env.example                 # 环境变量模板
└── README.md
```

---

## 四、服务器一键部署（推荐）

### 4.1 前置条件

- Ubuntu 24 / Debian 12 等 Linux（已在腾讯轻量云 Ubuntu 24 + 宝塔面板上验证设计）
- Docker 与 Docker Compose 已安装（宝塔「软件商店 → Docker管理器」可一键装）
- 服务器 80 / 443 端口可用（宝塔 Nginx 占用）

### 4.2 部署步骤

```bash
# 1) 克隆项目到服务器
cd /root
git clone <你的仓库地址> aige-saas-workbench
cd aige-saas-workbench

# 2) 生成配置文件
cp .env.example .env
vi .env       # 至少要改 4 个地方，见下表
```

**`.env` 必改项：**

| 变量 | 说明 | 怎么填 |
| --- | --- | --- |
| `JWT_SECRET` | 登录令牌签名密钥 | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | 敏感配置加密密钥 | `openssl rand -hex 32` |
| `MCP_AUTH_TOKEN` | AI 工具连接令牌 | `openssl rand -hex 16`（也可登录后在界面里生成） |
| `HOST_DATA_DIR` | 宿主机数据目录 | 填 `/root/aige-saas-workbench/data/apps`（这是让应用数据落到宿主机可备份目录的关键，详见 §8.3） |

> 生产环境若 `JWT_SECRET` / `ENCRYPTION_KEY` 仍是默认值，后端会**直接拒绝启动**（这是刻意的安全设计）。

```bash
# 3) 一键构建并启动
docker compose up -d --build

# 4) 看日志确认起来了
docker compose logs -f backend
```

看到下面这几行就算成功：

```
[db] SQLite 就绪：/app/data/workbench.db（驱动：better-sqlite3）
[api] REST 接口已启动：http://0.0.0.0:3000/api
[mcp] SSE 服务已启动：http://0.0.0.0:3001/sse（共 32 个工具）
[mcp] 已注册 32 个工具，分组一致
[health] 自动自愈当前关闭（可在「健康巡检」页开启）
```

### 4.3 端口说明

| 端口 | 服务 | 谁来访问 |
| --- | --- | --- |
| `3000` | 后端 REST API | 前端 Nginx 转发 / 宝塔反代（也可直接对外，后端会一并托管前端静态文件） |
| `3001` | MCP Server（SSE） | AI 工具（Trae / Cursor） |
| `8083` | 前端界面（Nginx） | **宝塔反向代理指向这里** |

> ⚠️ 前端默认用 **8083** 而不是 8080：8080 在不少服务器上已被别的服务占用。
> 部署前先 `ss -lnt` 核对，冲突就改 `docker-compose.yml` 里那行左侧的端口号。

---

## 五、宝塔反向代理 + SSL

### 5.1 添加反向代理

宝塔面板 →「网站」→「添加站点」：

1. **域名**：`aige-saas-panel.miaocaieyc.com.cn`（换成你的域名）
2. **类型**：纯静态（不需要 PHP / 数据库）
3. 建好后点该站点 →「反向代理」→「添加反向代理」：
   - 代理名称：`workbench`
   - 目标 URL：`http://127.0.0.1:8083`
   - 发送域名：`$host`
4. 保存

> 为什么指向 8083 而不是 3000：8083 是前端 Nginx，它同时托管界面并把 `/api` 转发给后端 3000。
> 如果你希望**只反代一个端口**，也可以把 `frontend/dist` 构建产物拷到 `backend/public/` 后重启后端，
> 此时后端会一并托管前端界面，反代直接指向 `http://127.0.0.1:3000` 即可（两种方式都已支持）。

> 💡 本项目自带「自动配反代」能力（`services/baota.js` 的 `setReverseProxy`），
> 会用宝塔 API 建站 + 写 Nginx 配置 + 备份原配置 + 重载，不一定要手动点。

### 5.2 申请 SSL

宝塔 → 该站点 →「SSL」→「Let's Encrypt」→ 勾选域名 → 申请 → **开启「强制 HTTPS」**。

### 5.3 MCP 端口（可选对外）

若要让**不在本机**的 AI 工具连接 MCP，在宝塔再建一个站点（如 `aige-saas-mcp.miaocaieyc.com.cn`）反代到
`http://127.0.0.1:3001`，并在该站点的 Nginx 配置里加上关闭缓冲（否则 SSE 会卡住）：

```nginx
proxy_buffering off;
proxy_read_timeout 3600s;
proxy_set_header Connection '';
```

---

## 六、首次登录

1. 浏览器打开你配好的域名
2. 默认账号：`elyac` / `elyac123456`（启动时若该账号不存在会自动创建）
3. 登录页可勾选「记住账号密码」，下次自动填充（仅存本机浏览器）
4. **登录后立刻去「系统设置 → 管理员账号」改密码**

> 安全说明：若数据库里还残留从未改动过的历史默认账号 `admin/admin888`，启动时会自动移除，避免公网面板留下弱口令。

---

## 七、对接配置（三项，都可先在界面测连通再保存）

进入「系统设置」，按顺序填：

### 7.1 宝塔面板

| 字段 | 值 |
| --- | --- |
| 面板地址 | `https://127.0.0.1:11927` —— **只填「协议 + IP + 端口」，不要带安全入口路径** |
| API 密钥 | 宝塔面板 →「设置」→「API 接口」→ 开启 → 复制密钥，并把**服务器 IP 加入白名单** |

> ⚠️ **最容易踩的坑**：从浏览器地址栏复制出来的面板地址形如
> `https://1.2.3.4:11927/c6b348fb`，末尾那串 `/c6b348fb` 是**登录页的安全入口**，
> 宝塔 API **不认这个前缀，带上会直接返回 404**。必须去掉，只留 `协议://IP:端口`。
> 代码里做了兜底：若首次请求吃到 404，会自动去掉路径用根地址重试一次，并在结果里说明。

> ⚠️ 面板用 IP 访问基本都是**自签证书**，Node 默认会拒连，所以需要
> `.env` 里 `BT_ALLOW_INSECURE_TLS=true`（只关这一条通道的证书校验，不影响 Cloudflare 等公网接口）。

点「测试连接」，显示「连接成功：Ubuntu 24 · N 核 · 内存 XXXX MB」即通。

### 7.2 Cloudflare

| 字段 | 值 |
| --- | --- |
| API Token | Cloudflare → My Profile → API Tokens → Create Token，权限：`Zone:Zone:Read` + `Zone:DNS:Edit` |
| 账号邮箱 | 选填，仅用于核对 |

> 注意用 **API Token**，不是 Global API Key。

### 7.3 Docker

保持默认 `unix:///var/run/docker.sock` 即可（docker-compose 已把 socket 挂进容器）。

### 7.4 应用部署参数

- **服务器公网 IP**：建议填。留空时部署会自动探测（走 api.ipify.org）并回写，但服务器无外网出口会失败。
- **宿主机数据目录**：见 §8.3，强烈建议填。

---

## 八、关键设计说明（部署前值得知道）

### 8.1 敏感配置如何存储

宝塔 API 密钥、Cloudflare Token、MCP 令牌都用 **AES-256-GCM** 加密后存进 SQLite，
密钥来自 `.env` 的 `ENCRYPTION_KEY`（不落库）。界面上这些字段永远只显示掩码，明文不回传前端。

### 8.2 本项目只操作自己名下的资源

- 删除网站前会**先查站点是否存在**，且只删站点与目录，**不动 FTP 与数据库**
- 添加 DNS 解析前会**查同类型同名记录**，已存在就复用，不重复创建
- 覆盖宝塔 Nginx 站点配置前，**先把原配置备份为 `<域名>.conf.bak.<时间戳>`**
- 同一域名已有成功/进行中的部署任务时，**直接拒绝重复部署**

### 8.3 为什么需要 `HOST_DATA_DIR`

后端跑在容器里，而**挂载路径是交给宿主机 Docker 守护进程解释的**，两者不是同一个路径。
`DEPLOY_DATA_DIR=/app/data/apps` 是容器内路径，宿主机上对应的可能是 `/root/aige-saas-workbench/data/apps`。

- **填了 `HOST_DATA_DIR`**：应用数据以目录形式落到宿主机，方便直接备份/查看
- **留空**：改用 Docker 命名卷（`aige-<应用>-<随机串>-<子目录>`），无需关心路径，但看数据要用
  `docker volume inspect` / `docker run --rm -v <卷名>:/d alpine ls /d`

### 8.4 SQLite 驱动回退（本地开发用）

生产镜像（node:20-alpine）会正常编译安装 `better-sqlite3`。
但在**Windows 开发机**上如果没有 C++ 工具链，`better-sqlite3` 装不上，后端会启动不了。
为此 `backend/src/db/driver.js` 做了驱动回退：装不上时自动用 Node 内置的 `node:sqlite`（需 Node ≥ 22.5）。
启动日志会打印实际使用的驱动，对上层完全透明。

### 8.5 SSL 的两条路径

应用部署时，若域名开启了 Cloudflare 代理（默认开启），**访客侧的 HTTPS 由 Cloudflare 边缘证书自动提供**；
系统同时会尽力调用宝塔申请源站 Let's Encrypt 证书。源站证书申请失败**不会中断部署**，只记警告
（因为此时应用已经可以正常访问了），日志里会明确告诉你去宝塔手动申请。

---

## 九、MCP 接入 AI 工具

### 9.1 远程连接（SSE，推荐）

在「系统设置 → MCP 连接」里点**「复制 Trae 配置」**，直接粘到 AI 工具里即可 ——
**不需要手动填任何东西**：

```json
{
  "mcpServers": {
    "aige-workbench": {
      "url": "https://aige-saas-mcp.miaocaieyc.com.cn/sse",
      "headers": { "Authorization": "Bearer <系统自动生成的真实令牌>" }
    }
  }
}
```

这份配置满足三条硬标准（2026-10-07 修复后）：

| 标准 | 说明 |
| --- | --- |
| 地址是**外网可达的 https 域名** | 来自 `PUBLIC_MCP_URL`。⚠️ 早期版本下发的是 `http://<域名>:3001/sse`，那个端口外网没开，粘过去必然连不上 |
| 令牌**没有占位符** | 没有令牌时系统会**当场自动生成**并入库，绝不出现 `<尚未生成令牌>` 这种要手填的内容 |
| 结构通用 | `mcpServers` 格式，Trae / Cursor / Claude Desktop 都能直接粘 |

相关环境变量：

| 变量 | 作用 |
| --- | --- |
| `PUBLIC_MCP_URL` | MCP 服务对外地址，如 `https://mcp.example.com` |
| `PUBLIC_PANEL_URL` | 工作台对外地址（用于回填界面展示） |
| `MCP_AUTH_TOKEN` | 初始令牌；库里没有令牌时会先用它，都没有才自动生成 |

> 两个变量留空时会退回「当前请求的域名 + 端口」，**仅供本地开发**，线上务必填正式域名。

SSE 端点支持三种令牌传法（任选其一）：

```
Authorization: Bearer <token>
x-mcp-token: <token>
?sse&token=<token>
```

### 9.2 只读令牌（给「只需要看」的 AI）

同一份能力可以按令牌分成两档 —— **级别由「用哪把令牌」决定，不看客户端自称什么**：

| 令牌 | 能做什么 | 怎么来 |
| --- | --- | --- |
| **全权令牌** | 全部工具 | 默认就有；点「重新生成令牌」可换一把 |
| **只读令牌** | 只读工具（`list_*` / `get_*` / `read_file` / `list_directory` / `list_backups` / `run_health_checks`） | 「系统设置 → MCP 连接 → 生成只读令牌」 |

写操作（新建/删除站点、改 DNS、改 Nginx 配置、重启容器、部署应用、自愈修复、
`call_bt_api`）在只读连接里**连工具清单都不出现**；即使客户端硬调，服务端也会直接拒绝
（返回 `isError: true` 与「只读令牌无权调用…」），全权令牌则完全不受影响。

两条实现上的硬约束，改这块时别破坏：

1. **两道门都要关**：`ListTools` 过滤（让 AI 一开始就知道自己的边界，不会白试）+
   `CallTool` 拦截（前者只是建议，AI 完全可以硬调，后者才是强制）。
2. **sessionId 与令牌级别绑定**：拿只读令牌往「全权 session」发消息会返回 `403`。
   sessionId 可猜、可泄漏，绝不能当凭据用 —— 否则知道 sessionId 就等于拿到全权。

> 只读令牌在**鉴权强度**上不比全权弱：同样是 48 位随机串、同样 AES 加密存库、
> 界面上同样只显示掩码。不用了就点「吊销」，**不会影响全权令牌**。

某个工具算「只读」还是「写」，由 `backend/src/mcp/tools.js` 的 `READONLY_TOOLS` 白名单决定
（**未列出的默认不给只读令牌用**，新增工具时忘归类是安全的）。若两份名单没有恰好铺满
全部工具、或出现重叠，CI 会直接失败 —— 见 `backend/scripts/selfcheck-mcp-scope.js`
（本地 `npm run check:scope` 也能跑）。

### 9.3 本地 stdio（AI 工具与工作台同机时）

```json
{
  "mcpServers": {
    "aige-workbench": {
      "command": "node",
      "args": ["/绝对路径/aige-saas-workbench/backend/src/mcp/stdio.js"],
      "env": { "ENV_FILE": "/绝对路径/aige-saas-workbench/.env" }
    }
  }
}
```

stdio 模式由客户端自己拉起进程，天然可信，无需令牌。

### 9.4 验证连接

- 健康检查：`GET http://<host>:3001/health` 应返回当前工具数（**以接口返回为准**，
  不要在文档里写死数字 —— 历史上就有过「文档写 28、实际 30」的漂移，现在 CI 会盯着这条）
- 也可用 MCP Inspector：`npx @modelcontextprotocol/inspector`

### 9.5 工具清单

> **完整清单（当前 32 个，分组 + 每条说明）见
> [docs/MCP工作流与能力清单.md](docs/MCP工作流与能力清单.md)。**
> 下表是其中最早落地的 14 个基础工具，保留在此便于快速对照。

| # | 工具 | 参数 | 说明 |
| --- | --- | --- | --- |
| 1 | `get_server_status` | — | CPU / 内存 / 磁盘 / 负载 + 数量统计 |
| 2 | `list_websites` | `search?` `page?` `limit?` | 宝塔网站列表 |
| 3 | `create_website` | `domain` `path?` `ps?` | 新建静态站（自动查重） |
| 4 | `delete_website` | `domain` | 删除站点（⚠️ 不可恢复，会先确认存在） |
| 5 | `apply_ssl` | `domain` `mode?` `domains?` `cert?` `key?` | 申请 / 部署证书 |
| 6 | `list_domains` | — | Cloudflare 域名区域列表 |
| 7 | `list_dns_records` | `zone_id?` `domain?` `type?` `search?` | DNS 记录列表 |
| 8 | `add_dns_record` | `type` `name` `content` `zone_id?` `proxied?` | 加解析（`zone_id` 可省，自动定位） |
| 9 | `delete_dns_record` | `zone_id` `record_id` | 删解析 |
| 10 | `list_containers` | `all?` `state?` `search?` `managed?` | 容器列表 |
| 11 | `restart_container` | `container_id` | 重启容器（支持传容器名） |
| 12 | `deploy_app` | `app_name` `domain` `wait?` | 一键部署（默认等完成，最长 3 分钟） |
| 13 | `get_deploy_logs` | `task_id` `since_id?` | 部署进度与日志（支持增量） |
| 14 | `list_app_templates` | — | 可部署应用清单（便于 AI 先确认应用标识） |

所有工具统一返回 `{ success, data, message }`，失败时 `isError: true` 且 `message` 为可读原因，
并且**每次调用都会写一条操作日志**（`source = mcp`）。

### 9.6 实测话术

> 「帮我添加一个二级域名 test.miaocaieyc.com.cn 指向 120.53.102.56」

AI 会调用 `add_dns_record`，无需先查 zone_id —— 传完整域名它会自动定位区域。

---

## 十、REST API 一览

所有接口统一返回 `{ code, message, data }`，`code === 0` 为成功。
除 `/api/health` 与 `/api/auth/*` 外均需 `Authorization: Bearer <JWT>`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（无需鉴权） |
| POST | `/api/auth/login` | 登录换 JWT（**启用二次验证时只返回 `{needTotp, ticket}`**，不发令牌） |
| POST | `/api/auth/login/totp` | 二次验证：票据 + 6 位码（或恢复码）→ 正式令牌 |
| GET | `/api/auth/profile` | 当前登录信息 |
| PUT | `/api/auth/password` | 修改自己的密码 |
| GET/POST | `/api/auth/totp` · `/totp/setup` · `/totp/enable` · `/totp/disable` · `/totp/recovery` | 二次验证的绑定 / 启用 / 关闭 / 重取恢复码 |
| GET | `/api/dashboard/overview` | 仪表盘总览 |
| GET | `/api/dashboard/server` | 服务器实时指标（前端 10 秒轮询） |
| GET/POST | `/api/websites` | 网站列表 / 新建 |
| GET/DELETE | `/api/websites/:name` | 详情 / 删除 |
| POST | `/api/websites/:name/ssl` | 申请或部署证书 |
| GET | `/api/websites/:name/snapshots` | 配置备份快照列表（变更历史） |
| GET | `/api/websites/:name/snapshots/diff` | 两份配置的行级差异（`a` 省略=当前线上） |
| POST | `/api/websites/:name/snapshots/restore` | 一键回滚到某份备份（必须传 `confirm: true`） |
| GET | `/api/domains/zones` | 域名区域列表 |
| GET/POST | `/api/domains/zones/:zoneId/records` | DNS 记录列表 / 新增 |
| PUT/DELETE | `/api/domains/zones/:zoneId/records/:recordId` | 修改（含代理开关）/ 删除 |
| POST | `/api/domains/quick-add` | 按完整域名快捷加解析 |
| GET | `/api/docker/containers` | 容器列表（筛选/搜索） |
| GET | `/api/docker/containers/:id/logs` | 容器日志（最近 N 行） |
| GET | `/api/docker/containers/:id/logs/stream` | 日志 SSE 实时推送 |
| POST | `/api/docker/containers/:id/{start,stop,restart}` | 启停重启 |
| DELETE | `/api/docker/containers/:id` | 删除容器 |
| GET | `/api/docker/images` · `/api/docker/networks` | 镜像 / 网络列表 |
| GET | `/api/apps/templates` | 应用模板列表 |
| GET | `/api/apps/templates/:key/compose` | 查看该模板的 docker-compose 参考 |
| POST | `/api/apps/deploy` | 发起一键部署 |
| GET | `/api/apps/tasks` · `/api/apps/tasks/:taskId` | 部署任务列表 / 详情 |
| GET | `/api/apps/tasks/:taskId/logs` | 任务日志（`sinceId` 增量） |
| GET | `/api/repos/config` | 代码仓库配置状态（是否配了令牌、关注了哪些仓库、缓存时长） |
| GET | `/api/repos` | 关注的仓库概览（含 GitHub 配额） |
| GET | `/api/repos/:owner/:repo` | 单仓库完整数据（提交 / Actions / Issue / PR 一次取回） |
| GET/PUT | `/api/settings` | 读取（脱敏）/ 保存配置 |
| POST | `/api/settings/test/:target` | 连通性测试（`baota`/`cloudflare`/`docker`） |
| GET | `/api/settings/mcp` · POST `/api/settings/mcp/token` | MCP 信息 / 重置令牌 |
| PUT | `/api/settings/admin` | 修改管理员账号 |
| GET | `/api/settings/system` | 运行环境信息 |
| GET/POST | `/api/users` | 用户列表 / 新建（仅管理员） |
| PUT/DELETE | `/api/users/:id` | 改角色·重置密码 / 删除（仅管理员） |
| GET | `/api/logs` | 操作日志（分页 + 过滤；含 `before_value` / `after_value` 字段级改动对照） |

---

## 十一、应用商店部署流程

点「部署」后会串行执行 7 个步骤，每步都写入实时日志：

1. **前置检查** —— 模板存在性、Docker 配置、同域名是否已有部署记录
2. **配置域名解析** —— Cloudflare 加 A 记录指向服务器公网 IP（已有则复用）
3. **准备运行环境** —— 创建容器网络、分配空闲端口（31000-31999）、准备数据卷
4. **拉取镜像** —— 本地已有则跳过
5. **创建并启动容器** —— 按模板创建全部服务容器，主服务等待进入运行状态
6. **配置反向代理** —— 宝塔建站 + 写 `proxy_pass` + 重载 Nginx（原配置先备份）
7. **配置 HTTPS** —— 尝试宝塔签发源站证书；有 Cloudflare 代理时边缘证书已生效

| 应用 | 容器数 | 建议内存 | 说明 |
| --- | --- | --- | --- |
| Uptime Kuma | 1 | 256 MB | 开箱即用，适合第一个拿来试 |
| n8n | 1 | 512 MB | 已自动关闭 Secure Cookie，反代后可正常登录 |
| NocoDB | 1 | 512 MB | 默认内置 SQLite |
| WordPress | 2 | 768 MB | WordPress + MySQL，数据库密码自动生成 |
| Dify | 6 | 4 GB+ | 重量级，首次启动约 2-5 分钟 |

---

## 十二、数据与备份

| 内容 | 位置 | 备份方式 |
| --- | --- | --- |
| 工作台数据库（配置、账号、日志、部署记录） | 宿主机 `./data/workbench.db` | 直接拷贝该文件（WAL 模式下建议先 `docker compose stop backend`） |
| 应用数据（配了 `HOST_DATA_DIR`） | `$HOST_DATA_DIR/<应用>-<随机串>/` | 直接打包目录 |
| 应用数据（未配 `HOST_DATA_DIR`） | Docker 命名卷 | `docker volume ls \| grep aige-` 后 `docker run --rm -v <卷>:/d -v $PWD:/b alpine tar czf /b/backup.tgz /d` |

---

## 十三、本地开发

```bash
# 后端
cd backend
npm install --ignore-scripts      # Windows 无 C++ 工具链时必须加 --ignore-scripts，会自动回退内置 SQLite
npm run dev                       # http://127.0.0.1:3000

# 前端（另开一个终端）
cd frontend
npm install
npm run dev                       # http://127.0.0.1:5173（已配 /api 代理到 3000）
```

本地调试 MCP stdio：`cd backend && npm run mcp:stdio`

---

## 十四、常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 后端启动即退出，日志提示「生产环境配置不安全」 | `.env` 里 `JWT_SECRET` / `ENCRYPTION_KEY` 还是默认值，改掉即可 |
| 「宝塔面板尚未配置」 | 系统设置里填面板地址 + API 密钥，并确认面板「API 接口」已开启、服务器 IP 在白名单里 |
| 宝塔接口报「权限不足 / 未登录」 | 部分宝塔版本对 `/data?action=getData` 等接口额外要求会话 Cookie，此时改用宝塔面板直接操作，或升级面板版本 |
| 「找不到 Docker Socket」 | 后端容器没挂到 `/var/run/docker.sock`；确认 `docker-compose.yml` 的 volumes 未被改动，且宿主机 Docker 正在运行 |
| 部署应用时报「宿主机数据目录」相关错误 | 见 §8.3，填 `HOST_DATA_DIR` 或留空改用命名卷 |
| 部署时报「该域名已有一条部署记录」 | 防重复部署的保护，先删除旧容器或在应用商店换个域名 |
| 反向代理配好后域名打不开 | 宝塔里手动重载一次 Nginx；确认站点 80 端口监听正常、`proxy_pass` 指向 `127.0.0.1:8080` |
| 容器日志页面一直「连接中断」 | SSE 被 Nginx 缓冲了；在对应 Nginx location 里加 `proxy_buffering off;` |
| MCP 连不上 | 先 `curl http://<host>:3001/health` 看服务是否活着；再核对令牌与 `Authorization` 头 |
| 忘记管理员密码 | 停掉后端，删除 `data/workbench.db` 中的 users 表记录后会重建默认账号（注意会同时丢失配置之外的业务数据，谨慎操作） |

---

## 十五、验收对照（对应需求文档第十一节）

| # | 验收项 | 实现情况 |
| --- | --- | --- |
| 1 | `docker compose up -d` 一键启动无报错 | ✅ 已完成并本地验证服务可正常启动 |
| 2 | 打开域名进登录页，登录后进仪表盘 | ✅ 已实测（截图验证登录页与仪表盘渲染） |
| 3 | 仪表盘显示服务器状态（经宝塔 API） | ✅ 接口已联通，未配置宝塔时显示引导而非报错 |
| 4 | 网站管理页显示宝塔全部网站 | ✅ 列表 + 搜索 + 分页已实现 |
| 5 | 域名管理页显示 Cloudflare 域名与解析 | ✅ 区域列表 + 解析列表已实现 |
| 6 | 能成功添加一条 DNS 解析 | ✅ 已实现（含同名校验与代理开关） |
| 7 | Docker 页显示容器并能重启 | ✅ 列表 / 启停 / 重启 / 日志 / 删除已实现 |
| 8 | 应用商店能部署应用并自动配域名与 SSL | ✅ **已端到端实测**：Uptime Kuma 一键部署成功，自动完成 DNS + 容器 + 源站证书 + 反向代理，线上访问 200 |
| 9 | MCP Server 能启动、Inspector 可连可调 | ✅ 14 个工具，`/health` 返回正常，工具调用已实测 |
| 10 | Trae 通过 MCP 说「加一个二级域名」能自动执行 | ✅ `add_dns_record` 支持只给完整域名自动定位区域 |

---

## 十六、安全说明

- 密码 bcrypt 哈希存储；敏感配置 AES-256-GCM 加密存储
- 全站 JWT 鉴权，登录接口单独限流（防爆破），全站接口限流兜底
- CORS 默认只在配置白名单内放行；生产环境默认同源
- 未捕获异常对外只返回通用提示，细节仅写服务端日志
- 操作日志记录谁在什么时候对什么做了什么（含 MCP 调用），失败也留痕；
  配置类改动还记录**字段级的「旧值 → 新值」**（`before_value` / `after_value`），
  但**敏感项只记「已设置 / 未设置」**——脱敏发生在 `settings.applyPatch()` 里，
  调用方拿不到明文，也就无从写进日志

### 16.1 角色与权限

三个角色，**按「能做什么」划分**：

| 角色 | 能做什么 | 典型用途 |
| --- | --- | --- |
| `admin` 管理员 | 全部，含系统设置、MCP 令牌、用户管理 | 你自己 |
| `operator` 运维 | 网站 / DNS / 容器 / 部署 / 巡检修复；**改不了系统设置、管不了账号** | 帮你干活的同事 |
| `viewer` 只读 | 看全部运维数据；**任何写操作被服务端拒绝** | 只想看状态的人 |

三条实现上的硬约束（改这块前必读）：

1. **规则只有一份**：`backend/src/middleware/permissions.js` 里按「模块路径 + 方法」
   声明，挂在 `routes/index.js` 的每行挂载上。**不要在各自的路由文件里手写角色判断** ——
   那样一定有漏的，而漏掉的那一个接口就是「所有登录用户都能全权操作」。
2. **CI 兜底**：`npm run check:perm` 会遍历**真实路由栈**，断言每个业务模块都挂了
   `requirePermission`，且挂载的模块与规则表里的模块完全一致。漏挂 / 忘归类 → 直接失败。
3. **角色从数据库现查，不信 JWT 里那份**。令牌是自包含的：把某人降级之后，如果还信
   令牌里写死的角色，他手上的旧令牌会一直是管理员，直到令牌过期才生效 ——
   「以为锁了、其实没锁」比没有权限体系更危险。

前端只是配合（侧边栏过滤、隐藏按钮、`adminOnly` 页面跳转），**真正的拦截全在后端**。

### 16.2 登录二次验证（TOTP）

面板暴露在公网，**只用密码是不够的**。绑定入口：**系统设置 → 登录二次验证**，
支持 Google Authenticator / 微软验证器 / 1Password / Authy 等任意 TOTP 应用。

| 做法 | 为什么这么做 |
| --- | --- |
| **先给恢复码，再让用户输码启用** | 顺序反过来（先启用、再给恢复码）的话，手机一丢就彻底进不来，只能上服务器改数据库 |
| 密码只换 **5 分钟临时票据**，不发登录令牌 | 票据是 `scope='totp'` 的 JWT，`requireAuth` 只认 `scope='session'` —— 否则"输完密码"这一步就已经有完整权限，二次验证等于白做 |
| 恢复码**一次性**、只存 sha256、忽略大小写与连字符 | 用掉即废；用户从纸上抄回来写成 `a3f9 k2mp` 也能用 |
| 关闭要**密码 + 动态码** | 否则登录会话被盗之后，可以一键把这道防线关掉 |
| 算法自己实现（`utils/totp.js`），不引 otplib | 安全功能少一个供应链面；而且零依赖才能拿 RFC 6238 附录 B 的官方时间点做逐字节自检（`npm run check:totp`） |

> ⚠️ 绑定成功后**请立刻把恢复码抄到密码管理器或纸上** —— 它是手机丢失时唯一的退路。

### 16.3 GitHub 令牌（代码仓库页）

「代码仓库」页要读 GitHub，所以需要一把凭据。**不配也能用**，但推荐配。

| 方式 | 配额 | 怎么来 |
| --- | --- | --- |
| 匿名（留空） | **60 次/小时**，且**按服务器出口 IP 算**（全服务器共用） | 什么都不用做。公开仓库一样能读 |
| **Fine-grained PAT（推荐）** | 5000 次/小时 | GitHub → Settings → Developer settings → Fine-grained tokens |

**该勾哪些权限（只要读）**：`Metadata`（必选）、`Contents: Read`、
`Actions: Read`、`Issues: Read`、`Pull requests: Read`。
仓库范围选「Only select repositories」并只勾要看的仓库。

> ⛔ **不要用 classic 的全量 `repo`**：那是**读写**权限，一旦泄露能改你的代码。
> 这个页面只读，给它写权限没有任何好处。

配好后填到 **系统设置 → 代码仓库**（AES 加密存储，与宝塔密钥同级）。
仓库列表支持多个（逗号分隔），也可以只写一个。

**三个已知的取舍**：

1. **数据有 60 秒缓存**，页面上会明确写出「多久前刷新 · 缓存多少秒」，不假装实时。
   加缓存是因为匿名配额太少（一个页面要 5 个请求，刷十几次就打满）。
2. **配额用完 / 令牌无效 / 仓库不存在** 三种情况分别给不同的提示，
   其中「令牌无效」和「配额用完」会让整页报错（而不是显示一个看似正常的空列表）。
3. 国内服务器直连 `api.github.com` 偶尔不稳。真遇到超时频繁，
   可以给 `GITHUB_API_BASE` 换一个可达的入口。

---

## 十七、实测踩坑记录（真机部署后补充，含解决方案）

以下问题都是在本项目**真实部署到 2 核 / 2GB 服务器**时踩到的，代码里已经修好，
此处留档，便于换机器部署时快速定位。

### 17.1 宝塔面板地址不能带安全入口路径

浏览器地址栏里的面板地址形如 `https://IP:11927/c6b348fb`，`/c6b348fb` 是登录页安全入口。
**宝塔 API 只认根路径**，带上这段前缀一律返回 404（连 `/c6b348fb/system` 这种带前缀的 API 路径也是 404）。

- 正确：`BT_PANEL_URL=https://120.53.102.56:11927`
- 错误：`BT_PANEL_URL=https://120.53.102.56:11927/c6b348fb`

代码兜底：`BaotaClient.call()` 检测到 404 且配置里带路径时，自动用根地址重试并记住结果。

### 17.2 面板自签证书导致 Node 拒连

面板用 IP + 自签证书提供 HTTPS，Node 的 `fetch` 会因证书不可信直接 `fetch failed`。

- 解决：`.env` 设 `BT_ALLOW_INSECURE_TLS=true`
- 实现：用 `undici` 的 `Agent({ connect: { rejectUnauthorized: false } })` **只关宝塔这一条通道**，
  而不是用 `NODE_TLS_REJECT_UNAUTHORIZED=0` 全局关闭（那会连带削弱 Cloudflare 等公网接口的 TLS 防护）

### 17.3 npmmirror 装不了 rollup 的平台专属依赖

前端镜像在 Alpine 里 `npm install` 后 `node_modules/@rollup/` 是**空的**，`vite build` 报
`Cannot find module @rollup/rollup-linux-x64-musl`。

排查结论：npmmirror 上该包的元数据与包体都存在，问题出在它解析 **optional 平台依赖**的行为上；
换成官方源一次就正常。所以前端 Dockerfile 改成：

```
官方源优先 → 失败退回 npmmirror 并补装平台包 → 用 node 自检 require('rollup')
```

自检失败会让构建直接失败，避免问题拖到构建后期才暴露。

### 17.4 Alpine 官方 CDN 在国内服务器上极慢

`apk add python3 make g++`（编译 better-sqlite3 用）实测卡了 **25 分钟**还没装完 gcc
（负载只有 1.27，是网络等待不是 CPU）。换成国内镜像后 **4.5 分钟**装完：

```dockerfile
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories \
 && apk add --no-cache python3 make g++
```

### 17.5 宝塔 13.x 站点行的 `domain` 字段是数字，不是域名

`/data?action=getData&table=sites` 返回的行里 `domain` 字段实测值为 `1`（数字标记），
真实域名在 **`rname`** 字段里。按 `domain` 解析会把域名解析成 `"1"`，
后续申请证书时报 `网站丢失，无法继续申请证书`。已改为优先取 `rname`。

### 17.6 宝塔申请证书必须传「数字站点 ID」

读面板源码 `acme_v2.apply_cert_api` 得到的真实入参：

| 参数 | 说明 |
| --- | --- |
| `id` | **数字站点 ID**（`public.M('sites').where('id=?')`）。传域名会报「网站丢失」 |
| `domains` | JSON 数组字符串 |
| `auth_type` | `http`（文件验证） |
| `auth_to` | 传纯数字（站点 ID）时，宝塔会自动解析成该站点的运行目录 |

接口：`POST /acme?action=apply_cert_api`

### 17.7 宝塔 13.x 的证书存放路径变了

Let's Encrypt 证书放在 **`/www/server/panel/vhost/letsencrypt/<域名>/`**，
老版本才是 `/www/server/panel/vhost/cert/<域名>/`。只查后者会误判为「无证书」，
只生成 80 段配置，导致 Cloudflare **严格（strict）模式**下访问报 **HTTP 526**。两个路径都要探测。

### 17.8 宝塔写文件有内容校验，且新文件要先 CreateFile

- `SaveFileBody` **只能写已存在的文件**，写新文件报 `指定文件不存在!`
  → 必须先用 `CreateFile` 建空文件
- `SaveFileBody` 保存站点配置时会**校验结构**，缺了 `#SSL-START` 后面的
  `#error_page 404/404.html;` 或 `#ERROR-PAGE-START/END` 标记会被拒绝，
  报「请勿修改SSL相关配置中注释的404规则」

### 17.9 顺序：必须先申请证书、再写反向代理配置

宝塔在申请证书前会校验站点配置是否被改动（`can_use_base_file_check`）。
如果先写了自定义反代配置，再申请证书会被拒绝：
「当前项目的服务（Nginx）配置文件被修改不支持文件验证」。

所以 `services/deploy.js` 的步骤顺序是
`… → 创建容器 → **配置 HTTPS 证书** → **配置反向代理**`，**不可颠倒**。
`setReverseProxy()` 内部会探测证书是否已存在（两个路径），
存在才生成 443 段与 HTTP→HTTPS 跳转。

### 17.10 Windows 本地开发装不了 better-sqlite3

没有 C++ 工具链时 `better-sqlite3` 编译失败，整个后端起不来。
`db/driver.js` 做了驱动回退：装不上就自动用 Node 内置的 `node:sqlite`（需 Node ≥ 22.5），
启动日志会打印实际驱动。本地安装用：

```bash
cd backend && npm install --ignore-scripts
```

生产容器（node:20-alpine + 构建工具链）始终使用 better-sqlite3，不受影响。

### 17.11 better-sqlite3 要求「所有具名参数都必须提供」

`UPDATE ... SET a = COALESCE(@a, a), b = COALESCE(@b, b)` 这类语句，
只要 `run()` 传的对象里少一个 `@` 参数，就会抛：

```
Missing named parameter "current_step"
```

后果很隐蔽：应用商店的部署任务会**卡在 pending、日志一条都没有**，只在后端控制台留一行异常。
（本项目是在真机跑一键部署时才炸出来的 —— 之前所有验证都绕过了 `deploy.js`。）

**解决**：`deploy.js` 里统一走 `updateTask(patch)` 辅助函数，把未传的字段补成 `null`（配合 COALESCE 语义不变），禁止直接调 `stmts.updateTask.run()`。

### 17.12 部署查重会「自己拦自己」

部署任务在进入第一步之前就已经以 `pending` 落库，而「同域名是否已有部署记录」的查重
又是第一步执行的 —— 不排除自身的话，查到的就是自己，直接报：

```
域名 xxx 已有一条部署记录（状态：running，任务号：<当前任务>）
```

**解决**：查重 SQL 加 `AND id != ?` 排除当前任务。

### 17.13 反向代理会覆盖宝塔的证书配置 —— 顺序必须是「先证书、后反代」

`setReverseProxy()` 会整段重写站点 Nginx 配置。如果在它之后再申请证书，
宝塔会因为「站点配置被改动过」拒绝签发；而如果在它之前申请，它又会把宝塔刚写好的
证书配置覆盖掉。

**正确顺序**（`deploy.js` 已按此实现）：

```
前置检查 → 域名解析 → 准备环境 → 拉镜像 → 起容器 → 申请证书 → 配置反向代理
```

`setReverseProxy()` 会探测证书是否已存在（`vhost/letsencrypt/` 与 `vhost/cert/` 两个位置都查），
存在才一并生成 443 段与 HTTP→HTTPS 跳转。

### 17.14 宝塔 `/system` 的 `load` 是字符串，`cpuRealUsed` 也不准

这三个字段错得很安静，长期没人发现（仪表盘一直显示「系统负载 0」，看着像"很闲"）：

| 字段 | 宝塔返回 | 代码原写法 | 后果 |
| --- | --- | --- | --- |
| `load` | `"2.24 1.66 1.55"`（空格分隔**字符串**） | `data.load.one` | 永远 `undefined` → 界面显示 0 |
| `cpuRealUsed` | 97.5% ~ 100% | 直接用 | 与真实值（≈58%）差一倍 |
| `setup_time` | 取不到 | 直接用 | 运行时长恒为 `null` |

**解决**：新增 `services/metrics.js` 直读 `/proc/stat`（两次采样算 CPU 差值）、`/proc/loadavg`、
`/proc/uptime`、`/proc/meminfo`（用 `MemAvailable` 而不是 `MemFree`）、`fs.statfsSync` 取磁盘；
宝塔只保留它擅长的系统版本与分区明细。**宝塔挂了这套照样出数**。

### 17.15 容器里读 `/proc` 拿到的是宿主机值（这次是好消息）

上面那套「直读 /proc」的方案，一开始担心容器里读到的是容器自己的指标。
**实测确认：`loadavg` / `uptime` / `/proc/stat` 都不是 namespaced 的，容器内读到的就是宿主机值**
（容器内 `1.59 1.45 1.28` 与宿主机 `1.55 1.44 1.28` 一致）。所以这个方案在 Docker 里成立。

> 但内存不同：`/proc/meminfo` 读到的是宿主机总量，容器的 cgroup 限额要另读
> `/sys/fs/cgroup/memory.max`。本项目展示的是「整台服务器」的水位，用宿主机值是对的。

### 17.16 给 element-plus 指定固定 chunk 名 = 把全站组件钉在首屏
`vite.config.js` 里写了 `if (id.includes('element-plus')) return 'element'`，
本意是「单独切块、吃长缓存」，实际效果却是：

- Rollup 把**全站用到的所有** Element Plus 组件（日期选择器、上传、树、走马灯…）
  强制塞进同一个 `element-*.js`，哪怕它们只属于设置页/网站页；
- 入口又静态引用了这个块 → `index.html` 里出现 `modulepreload` →
  **登录页与仪表盘必须先下 302KB gzip 的 JS**。这就是「打开就卡一下」的真凶。

**解决**：不给 element-plus 指定 chunk，交给 Rollup 按引用关系自己切
（入口只带走自己用到的，组件跟着各自路由懒加载，多处共用的自动提升成共享块）。
**首屏 427KB → 154KB gzip（−64%）**。ECharts 与 Vue 仍单独成块吃长缓存。

### 17.17 宝塔 `/files?action=GetDir` 返回的字段是 `FILES`，不是 `FILE`

做「配置历史」时需要列 nginx 配置目录里的 `.conf` 与 `.conf.bak.*` 文件，
结果一份都列不出来 —— 原来 `listDir()` 读的是 `res.FILE`，而宝塔返回的是 **`res.FILES`（复数）**，
于是**文件列表永远是空的**，只有 `res.DIR` 里的子目录能列出来。

这个 bug 存在很久没被发现，是因为它唯一的调用方 `listBackups()` 只看 `/www/backup` 下的
**子目录**，正好绕开了出问题的那一半。

> 教训：解析第三方响应时，**拿一个真实响应把每个字段都打印出来**，比照着文档写更靠谱；
> 另外「只有一半能用」的函数，往往意味着另一半根本没被真正使用过。

### 17.18 请求体 JSON 语法错误被当成 500

body-parser 在 JSON 语法错误时抛的是 `{ status: 400, expose: true }`，
但错误处理中间件当时只认 `AppError`，其余一律 500 —— 于是调用方看到的是
「服务器内部错误，请查看后端日志」，转头去后端日志里找一个根本不存在的 bug。

**解决**：识别带 `expose: true` 的 4xx 框架异常，按真实状态码与原因返回
（`isClientError()`）。5xx 的框架异常仍按未捕获异常处理，避免把内部细节透出去。

### 17.19 飞书机器人的签名算法：`stringToSign` 是当 **key** 用的

飞书自定义机器人可以开「签名校验」。它的算法跟直觉相反，**最容易写反**：

```
stringToSign = `${timestamp}\n${secret}`          ← 中间那个换行不能少
sign = base64( HMAC-SHA256( key = stringToSign, message = "" ) )
```

即：**`stringToSign` 当 HMAC 的 key，消息体是空的**。
写成 `HMAC(key = secret, message = stringToSign)` 是最常见的错法。

这类错误的表现是「推送一直失败」—— 不报错、不抛异常，飞书只是静默拒收，
回一个 `errcode 19021`。所以：

- 算法单独放在零依赖的 `backend/src/utils/sign.js`；
- 把**官方 Python 示例**算出的 4 组固定值写死成期望值，
  由 `backend/scripts/selfcheck-feishu-sign.js` 做**跨实现交叉比对**（CI 每次真跑）；
- 除了比对值，还断言了「换行参与计算」「换密钥签名会变」这类行为约束 ——
  光比对一组值，猜对了可能只是巧合。

实测（用一个「假飞书」回显服务接住请求体，不需要真机器人）：

```json
{"timestamp":"1791428656","sign":"ZDaVLMzcLnkfJwhZme42AgrZZ/qik0howYbgSXMa9TQ=",
 "msg_type":"text","content":{"text":"..."}}
```

清掉签名密钥后再发 → 请求体里不再有 `timestamp` / `sign`，且消息体仍正常：
**开关跟着密钥走，机器人那边开不开签名校验都能用**。

---

## 十八、本次交付的部署实录

| 项目 | 结果 |
| --- | --- |
| 部署服务器 | 腾讯云轻量 2 核 / 2GB / Ubuntu 24.04.4（`120.53.102.56`） |
| 部署路径 | `/root/aige-saas-workbench/` |
| 容器 | `aige-workbench-backend`（3000/3001）、`aige-workbench-frontend`（8083），均 healthy |
| 数据库驱动 | **better-sqlite3**（生产环境正常编译，未走回退） |
| 访问域名 | `https://aige-saas-panel.miaocaieyc.com.cn` → HTTP 200 |
| MCP 域名 | `https://aige-saas-mcp.miaocaieyc.com.cn/health` → HTTP 200，14 个工具，需鉴权 |
| Cloudflare | 区域 `miaocaieyc.com.cn`（SSL 模式 strict），两个域名 A 记录均开启代理 |
| HTTPS | 宝塔 Let's Encrypt 源站证书 + Cloudflare 边缘证书，`http` 自动 301 到 `https` |
| MCP 鉴权 | 无令牌连接返回 401 ✅ |
| MCP 工具调用 | 通过 SSE 真实调用 `add_dns_record` 成功创建 `aige-saas-test.miaocaieyc.com.cn → 120.53.102.56`（该记录随后已清理） |
| 应用商店一键部署 | 实测部署 Uptime Kuma 到 `aige-saas-kuma.miaocaieyc.com.cn`：7 步全通过 —— DNS 加解析 → 拉镜像 → 起容器（端口 31000）→ 申请源站证书 → 配反向代理。线上 `https://` 访问返回 200，页面标题 `Uptime Kuma`，证书有效期至 2027-01-05 |

> 说明：服务器上同时运行着 koyca、rpoai、eyc、tito-pay 等多个线上项目。
> 本次部署只操作了本项目自己的目录、容器、两个域名与对应 DNS 记录，
> 未改动任何其他项目的站点、目录或配置。资源边界详见 `config/资源清单.md`。

---

## 十九、多端适配（PC / 平板 / 手机）

### 19.1 断点策略

| 断点 | 布局变化 |
| --- | --- |
| `> 900px` | 左侧固定侧栏 + 完整表格（桌面形态） |
| `≤ 900px` | 侧栏收成抽屉（汉堡菜单）；**列表页从表格切换为卡片** |
| `≤ 768px` | 全部可点击元素抬高到 ≥44px；弹窗两侧留边；表格行内边距加大 |
| `≤ 640px` | 卡片内部进一步紧凑 |

侧栏收起与卡片切换用**同一个断点（900px）**——避免出现「侧栏收起了、表格还在横向拖」这种半吊子状态。

### 19.2 手机端为什么用卡片而不是「表格横向滚动」

一个 6 列表格在 375px 上只能露出三分之一：`fixed="right"` 的操作列会盖住下面的列，
按钮互相穿透、文字叠在一起完全不可读（这是实测截图里确认过的问题，不是推测）。

所以 3 个列表页（网站 / 域名 / Docker）在 `≤900px` 时改渲染**卡片列表**：

```
卡片头：标题（长域名 overflow-wrap: anywhere 自动断行） + 状态胶囊
卡片体：dl 定义列表，字段名左、值右（字段名固定 68px 轨道）
卡片脚：操作按钮独立成行，flex-wrap 换行而不是挤压
```

实现方式是新增组合式函数 `src/composables/useNarrow.js`（`matchMedia` 驱动，
只在跨过断点时触发一次，不在 resize 里反复重渲染），配合 `styles/index.css`
里的 `.cards / .card / .card__meta / .card__actions` 共享样式。

### 19.3 触控目标硬标准

手机上手指能点准的下限是 **44×44px**。已统一落实：

- 顶部汉堡 / 主题 / 用户菜单：34px → **44px**
- Element Plus 按钮、输入框、下拉、单选多选、Tab、分页：统一抬到 **≥44px**
- 表格内的链接式操作按钮：`min-height: 44px`（配合 `.card__actions` 铺满）
- 文字链（如应用商店的「官方文档」）：19px → **44px**

只抬高**点击区**，图标与字号不变——视觉不变，手感变好。

### 19.4 怎么复跑这套验收

项目里带了一个零依赖的多端验收台（Edge 无头 + Chrome DevTools Protocol），
在 320 / 375 / 414 / 768 / 1440 五个宽度下逐页做机械体检：
横向溢出、可点击文本折行、触控目标 <44px，并把每个页面截图存到 `.qa/shots/`。

```bash
node .qa/audit.mjs                 # 默认绕开 Cloudflare 直连源站
node .qa/audit.mjs --through-cf    # 想连 CDN 链路一起测时加上
```

> ⚠️ 两个坑（都已写进脚本注释）：
> 1. **必须先断言「页面真的渲染出来了」**。第一版没有这个断言，前端资源加载失败
>    导致页面全白时，体检脚本仍然全绿——没有元素，自然就没有溢出。
> 2. **行数不能用「元素高度 ÷ 行高」算**：固定高度的按钮会被误判成两行；
>    也不能按 `rect.top` 分组——图标(16px)与文字(13px)垂直居中后 top 差几像素，
>    会被当成两行。正确做法是按「垂直中心 + 半个行高的容差」聚类，
>    并跳过内部含块级子元素的按钮（那是刻意的多行排版）。

### 19.5 实测结果

修复前后对比（35 个「视口 × 页面」组合的汇总）：

| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| 真横向溢出 | 48 处 | **0** |
| 触控目标 <44px | 108 处 | **0** |
| 可点击文本折行 | 36 处 | **0** |
| 表格需横向滚动 | 36~37 处/页 | **0**（已改卡片） |

最终：**全部视口、全部页面：无横向溢出、无过小触控目标、无按钮折行**，
并逐张人工看过 5 个宽度的截图确认内容真实渲染。

