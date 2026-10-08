<template>
  <div class="page">
    <!-- ==================== 对接配置 ==================== -->
    <section v-for="group in connectionGroups" :key="group.key" class="surface section">
      <header class="section__head">
        <span class="section__glyph" :style="{ color: group.color, background: group.bg }">
          <el-icon><component :is="group.icon" /></el-icon>
        </span>
        <div class="section__titles">
          <h2 class="section__title">
            {{ group.title }}
            <span class="section__state" :class="group.configured ? 'is-on' : 'is-off'">
              {{ group.configured ? '已配置' : '未配置' }}
            </span>
          </h2>
          <p class="section__sub">{{ group.desc }}</p>
        </div>
      </header>

      <div class="section__body">
        <el-form label-position="top" class="form-grid">
          <el-form-item
            v-for="field in group.fields"
            :key="field.key"
            :label="field.label"
            :class="{ 'span-2': field.wide }"
          >
            <el-input
              v-model="form[field.key]"
              :type="field.secret ? 'password' : 'text'"
              :show-password="field.secret"
              :placeholder="placeholderOf(field)"
              clearable
            />
            <p v-if="field.tip" class="field-tip">{{ field.tip }}</p>
          </el-form-item>
        </el-form>

        <div class="section__actions">
          <el-button :loading="testing === group.key" @click="testConnection(group)">
            <el-icon><Link /></el-icon>测试连接
          </el-button>
          <el-button
            type="primary"
            :loading="saving === group.key"
            :disabled="!isDirty(group.keys)"
            @click="saveKeys(group.keys, group.key)"
          >
            保存
          </el-button>
        </div>

        <p
          v-if="testResults[group.key]"
          class="test-result"
          :class="testResults[group.key].ok ? 'is-ok' : 'is-fail'"
        >
          <el-icon
            ><component :is="testResults[group.key].ok ? 'CircleCheckFilled' : 'CircleCloseFilled'"
          /></el-icon>
          <span>{{ testResults[group.key].message }}</span>
        </p>
      </div>
    </section>

    <!-- ==================== 应用部署参数 ==================== -->
    <section class="surface section">
      <header class="section__head">
        <span class="section__glyph" style="color: var(--warning); background: var(--warning-soft)">
          <el-icon><Grid /></el-icon>
        </span>
        <div class="section__titles">
          <h2 class="section__title">应用部署参数</h2>
          <p class="section__sub">一键部署应用时使用的默认值，改完即时生效</p>
        </div>
      </header>

      <div class="section__body">
        <el-form label-position="top" class="form-grid">
          <el-form-item label="服务器公网 IP">
            <el-input
              v-model="form.server_public_ip"
              placeholder="留空则部署时自动探测并回写"
              clearable
            />
            <p class="field-tip">部署应用时用于创建指向本服务器的 A 记录</p>
          </el-form-item>

          <el-form-item label="应用容器网络">
            <el-input v-model="form.deploy_network" placeholder="aige-apps" clearable />
            <p class="field-tip">所有部署的应用容器接入此网络，容器之间可用容器名互访</p>
          </el-form-item>

          <el-form-item label="应用数据目录（容器内）">
            <el-input v-model="form.deploy_data_dir" placeholder="/app/data/apps" clearable />
            <p class="field-tip">工作台容器内部的路径，一般不需要改</p>
          </el-form-item>

          <el-form-item label="宿主机数据目录（建议填写）">
            <el-input
              v-model="form.host_data_dir"
              placeholder="例如 /root/aige-saas-workbench/data/apps"
              clearable
            />
            <p class="field-tip">
              ⚠️ 后端跑在容器里，但交给 Docker
              的挂载路径必须是「宿主机路径」。填了就用目录挂载（数据可直接备份查看）； 留空则改用
              Docker 命名卷。
            </p>
          </el-form-item>

          <el-form-item label="Docker 镜像加速地址" class="span-2">
            <el-input
              v-model="form.registry_mirror"
              placeholder="例如 https://docker.m.daocloud.io"
              clearable
            />
            <p class="field-tip">
              国内服务器建议填写，可显著加快应用镜像拉取速度；留空则使用 Docker 默认配置
            </p>
          </el-form-item>
        </el-form>

        <div class="section__actions">
          <el-button
            type="primary"
            :loading="saving === 'deploy'"
            :disabled="!isDirty(DEPLOY_KEYS)"
            @click="saveKeys(DEPLOY_KEYS, 'deploy')"
          >
            保存
          </el-button>
        </div>
      </div>
    </section>

    <!-- ==================== 代码仓库（B4） ==================== -->
    <section class="surface section">
      <header class="section__head">
        <span class="section__glyph" style="color: var(--info); background: var(--info-soft)">
          <el-icon><FolderOpened /></el-icon>
        </span>
        <div class="section__titles">
          <h2 class="section__title">
            代码仓库
            <span class="section__state" :class="githubHasToken ? 'is-on' : 'is-off'">
              {{ githubHasToken ? '已配令牌' : '匿名访问' }}
            </span>
          </h2>
          <p class="section__sub">「代码仓库」页要看的提交与 CI 状态</p>
        </div>
      </header>

      <div class="section__body">
        <el-form label-position="top" class="form-grid">
          <el-form-item label="关注的仓库" class="span-2">
            <el-input
              v-model="form.github_repos"
              placeholder="eyc1125/aige-saas-workbench"
              clearable
            />
            <p class="field-tip">多个仓库用英文逗号分隔，格式为 owner/repo</p>
          </el-form-item>

          <el-form-item label="GitHub 令牌（选填）" class="span-2">
            <el-input
              v-model="form.github_token"
              type="password"
              show-password
              :placeholder="placeholderOf({ key: 'github_token', secret: true })"
              clearable
            />
            <p class="field-tip">
              ⚠️ 留空 = <strong>匿名访问</strong>：公开仓库也能看，但配额只有
              <strong>60 次 / 小时</strong>（按服务器出口 IP 算，全服务器共用），刷十几次就会用完。
              填一个<strong>只读</strong>的 Fine-grained PAT 可提升到
              <strong>5000 次 / 小时</strong>。 只需
              Metadata（必选）、Contents、Actions、Issues、Pull requests 的<strong>读</strong>权限
              —— 不要用 classic 的全量 repo（那是读写权限，泄露可改代码）。
            </p>
          </el-form-item>
        </el-form>

        <div class="section__actions">
          <el-button
            type="primary"
            :loading="saving === 'github'"
            :disabled="!isDirty(GITHUB_KEYS)"
            @click="saveKeys(GITHUB_KEYS, 'github')"
          >
            保存
          </el-button>
        </div>
      </div>
    </section>

    <!-- ==================== MCP 连接 ==================== -->
    <section class="surface section">
      <header class="section__head">
        <span class="section__glyph" style="color: var(--brand); background: var(--brand-soft)">
          <el-icon><Connection /></el-icon>
        </span>
        <div class="section__titles">
          <h2 class="section__title">
            MCP 连接
            <span class="section__state" :class="mcp?.enabled ? 'is-on' : 'is-off'">
              {{ mcp?.enabled ? '已启用' : '未启用' }}
            </span>
          </h2>
          <p class="section__sub">
            让 Trae / Cursor / Claude 等任意 AI 工具直接操作本工作台，共
            {{ mcp?.tools?.length || 0 }} 个工具
          </p>
        </div>
      </header>

      <div class="section__body">
        <div class="mcp-grid">
          <div class="mcp-info">
            <div class="kv">
              <span class="kv__k">SSE 地址</span>
              <span class="kv__v mono">{{ mcp?.sseUrl || '—' }}</span>
            </div>
            <div class="kv">
              <span class="kv__k">连接令牌</span>
              <span class="kv__v mono">{{ mcp?.tokenMasked || '未设置' }}</span>
            </div>
            <div class="kv">
              <span class="kv__k">健康检查</span>
              <span class="kv__v mono">{{ mcp?.healthUrl || '—' }}</span>
            </div>
          </div>

          <div class="mcp-actions">
            <el-button
              type="primary"
              @click="copyText(mcpConfigText, 'MCP 配置已复制，粘贴到 AI 工具即可用')"
            >
              <el-icon><DocumentCopy /></el-icon>复制 MCP 配置
            </el-button>
            <el-button @click="copyText(mcp?.quickstart || '', '接入说明已复制')">
              <el-icon><Files /></el-icon>复制接入说明
            </el-button>
            <el-button @click="regenerateToken">
              <el-icon><RefreshRight /></el-icon>重新生成令牌
            </el-button>
          </div>
        </div>

        <el-alert
          class="mcp-note"
          type="success"
          :closable="false"
          show-icon
          title="一个 MCP 就够，不用再挂宝塔 / Cloudflare 的官方 MCP"
          description="网站、域名、DNS、Docker、应用部署、站点日志、Nginx 配置、备份与证书已全部封装在这一个 MCP 里；官方 MCP 覆盖不到的能力（计划任务、防火墙等）用 call_bt_api 兜底。"
        />

        <pre class="code-block">{{ mcpConfigText }}</pre>

        <el-collapse class="tools-collapse">
          <el-collapse-item
            :title="`能力清单（${mcp?.tools?.length || 0} 个工具，按用途分组）`"
            name="groups"
          >
            <div v-for="group in mcp?.toolGroups || []" :key="group.group" class="tool-group">
              <h4 class="tool-group__title">{{ group.group }}</h4>
              <ul class="tools">
                <li v-for="tool in group.tools" :key="tool.name">
                  <code>{{ tool.name }}</code>
                  <span>{{ tool.description }}</span>
                </li>
              </ul>
            </div>
          </el-collapse-item>

          <el-collapse-item title="给 AI 工具看的接入说明（一键复制）" name="quickstart">
            <p class="field-tip">
              下面这段可以直接贴给任意 AI 工具（Trae / Cursor / Claude / Windsurf / VS Code 通用），
              它读完就知道这个 MCP 能干什么、该怎么调用。
            </p>
            <pre class="code-block code-block--soft">{{ mcp?.quickstart || '加载中…' }}</pre>
            <el-button @click="copyText(mcp?.quickstart || '', '接入说明已复制')">
              <el-icon><DocumentCopy /></el-icon>复制这份说明
            </el-button>
          </el-collapse-item>
        </el-collapse>

        <p class="field-tip">
          说明：远程连接请把上面的 JSON 填到 AI 工具的 MCP 配置里（已含真实令牌，复制即用）； 若 AI
          工具就在服务器本机，也可用 stdio 方式：<code>{{ mcp?.stdioCommand }}</code>
        </p>

        <!-- 只读令牌（D2）：把「只需要查」的 AI 与全权 AI 分开 -->
        <div class="ro-card">
          <div class="ro-card__head">
            <div class="ro-card__titles">
              <span class="ro-card__badge">只读</span>
              <span class="ro-card__title">只读令牌</span>
              <span class="section__state" :class="mcp?.readonly?.configured ? 'is-on' : 'is-off'">
                {{ mcp?.readonly?.configured ? '已生成' : '未生成' }}
              </span>
            </div>
            <div class="ro-card__actions">
              <el-button
                v-if="mcp?.readonly?.configured"
                type="primary"
                @click="copyText(readonlyConfigText, '只读配置已复制，粘贴到 AI 工具即可用')"
              >
                <el-icon><DocumentCopy /></el-icon>复制只读配置
              </el-button>
              <el-button @click="generateReadonlyToken">
                <el-icon><RefreshRight /></el-icon>
                {{ mcp?.readonly?.configured ? '重新生成' : '生成只读令牌' }}
              </el-button>
              <el-button
                v-if="mcp?.readonly?.configured"
                type="danger"
                plain
                @click="revokeReadonlyToken"
              >
                吊销
              </el-button>
            </div>
          </div>

          <p class="ro-card__desc">
            给「只需要查、不需要改」的 AI 用：只能调用其中
            {{ mcp?.readonly?.toolCount || 0 }} 个只读工具。写操作（新建 / 删除站点、改 DNS、 改
            Nginx 配置、重启容器、部署应用、自愈修复、call_bt_api 等）会被服务端直接拒绝 ——
            工具清单里根本没有它们，AI 硬调也执行不了。全权令牌不受影响，两把可以同时用。
          </p>

          <div v-if="mcp?.readonly?.configured" class="ro-card__body">
            <div class="kv">
              <span class="kv__k">只读令牌</span>
              <span class="kv__v mono">{{ mcp?.readonly?.tokenMasked }}</span>
            </div>
            <pre class="code-block code-block--soft">{{ readonlyConfigText }}</pre>
            <el-collapse class="tools-collapse">
              <el-collapse-item
                :title="`只读令牌能用的工具（${mcp?.readonly?.toolCount || 0} / ${mcp?.readonly?.totalCount || 0}）`"
                name="ro-tools"
              >
                <div
                  v-for="group in mcp?.readonly?.toolGroups || []"
                  :key="group.group"
                  class="tool-group"
                >
                  <h4 class="tool-group__title">{{ group.group }}</h4>
                  <ul class="tools">
                    <li v-for="tool in group.tools" :key="tool.name">
                      <code>{{ tool.name }}</code>
                      <span>{{ tool.description }}</span>
                    </li>
                  </ul>
                </div>
              </el-collapse-item>
            </el-collapse>
          </div>

          <p v-else class="ro-card__desc">
            还没生成。点「生成只读令牌」会创建一把只读凭据 —— 明文只显示这一次，请立即复制到 AI
            工具的配置里。
          </p>
        </div>
      </div>
    </section>

    <!-- ==================== 告警通知 ==================== -->
    <section class="surface section">
      <header class="section__head">
        <span class="section__glyph" style="color: var(--warning); background: var(--warning-soft)">
          <el-icon><Bell /></el-icon>
        </span>
        <div class="section__titles">
          <h2 class="section__title">
            告警通知
            <span class="section__state" :class="isAlertOn ? 'is-on' : 'is-off'">
              {{ isAlertOn ? '已配外部通道' : '仅站内' }}
            </span>
          </h2>
          <p class="section__sub">
            巡检异常、部署失败、自愈失败都会生成告警；这里配置往站外推的通道
          </p>
        </div>
      </header>

      <div class="section__body">
        <el-alert
          class="mcp-note"
          type="info"
          :closable="false"
          show-icon
          title="站内告警始终开启"
          description="顶栏铃铛就是站内告警中心：未读亮红点，问题消失后自动关闭。下面的外部通道是可选的 —— 不配就只有打开页面才看得到。"
        />

        <el-form label-position="top">
          <el-form-item label="飞书机器人 Webhook（可选，推荐）">
            <el-input
              v-model="form.alert_feishu_webhook"
              :placeholder="
                settingsMeta.alert_feishu_webhook?.hasValue
                  ? `已保存（${settingsMeta.alert_feishu_webhook.value}），留空表示不修改`
                  : 'https://open.feishu.cn/open-apis/bot/v2/hook/xxxx'
              "
              clearable
            />
            <p class="field-tip">
              飞书群里「设置 → 群机器人 → 添加机器人 → 自定义机器人」，建好后复制它的 Webhook
              地址（形如 <code>https://open.feishu.cn/open-apis/bot/v2/hook/</code>
              后面跟一串字符）。
            </p>
          </el-form-item>

          <el-form-item label="飞书签名密钥（可选，仅当机器人开了「签名校验」才需要）">
            <el-input
              v-model="form.alert_feishu_secret"
              :placeholder="
                settingsMeta.alert_feishu_secret?.hasValue
                  ? `已保存（${settingsMeta.alert_feishu_secret.value}），留空表示不修改`
                  : '机器人开着签名校验时，把那里的「密钥」粘到这里'
              "
              clearable
            />
            <p class="field-tip">
              两边的开关必须一致：机器人开了签名校验 → 这里必须填密钥；机器人没开 → 这里留空。
              不一致的话飞书会拒收，并回 <code>errcode 19021</code>。
            </p>
          </el-form-item>

          <el-form-item label="企业微信群机器人（可选）">
            <el-input
              v-model="form.alert_wecom_webhook"
              :placeholder="
                settingsMeta.alert_wecom_webhook?.hasValue
                  ? `已保存（${settingsMeta.alert_wecom_webhook.value}），留空表示不修改`
                  : 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx'
              "
              clearable
            />
            <p class="field-tip">
              企业微信里打开任意「群聊」→「群设置 → 群机器人 → 添加机器人」，复制它的 Webhook
              地址即可。推的是 markdown 卡片，紧急/警告会标成橙色。
            </p>
          </el-form-item>

          <el-form-item label="通用 Webhook（可选）">
            <el-input
              v-model="form.alert_webhook_url"
              :placeholder="
                settingsMeta.alert_webhook_url?.hasValue
                  ? `已保存（${settingsMeta.alert_webhook_url.value}），留空表示不修改`
                  : 'https://你的地址/alert'
              "
              clearable
            />
            <p class="field-tip">
              告警产生时向该地址 POST 一段 JSON（含 level / title / detail /
              时间），方便接你自己的系统。
            </p>
          </el-form-item>
        </el-form>

        <el-alert
          class="mcp-note"
          type="warning"
          :closable="false"
          show-icon
          title="飞书与企业微信的地址不能混填"
          description="两者是不同协议：飞书是 {msg_type, content}，企业微信是 {msgtype, markdown}，成功判定也不同（code vs errcode）。填错位置会一直推送失败。三个通道可以同时配，会并行推送、互不影响。"
        />

        <p class="field-tip">
          防刷屏机制：同一问题 30 分钟内只推一次；问题重复出现只累加次数（不会刷出一堆重复告警）。
        </p>

        <div class="section__actions">
          <el-button :loading="testing === 'alert'" @click="testAlert">
            <el-icon><Bell /></el-icon>发送测试告警
          </el-button>
          <el-button
            type="primary"
            :loading="saving === 'alert'"
            :disabled="!isDirty(ALERT_KEYS)"
            @click="saveKeys(ALERT_KEYS, 'alert')"
          >
            保存
          </el-button>
        </div>
      </div>
    </section>

    <!-- ==================== 管理员账号 ==================== -->
    <section class="surface section">
      <header class="section__head">
        <span
          class="section__glyph"
          style="color: var(--text-secondary); background: var(--bg-subtle)"
        >
          <el-icon><UserFilled /></el-icon>
        </span>
        <div class="section__titles">
          <h2 class="section__title">管理员账号</h2>
          <p class="section__sub">当前登录：{{ auth.displayName }}（{{ auth.roleText }}）</p>
        </div>
      </header>

      <div class="section__body">
        <el-form
          ref="adminFormRef"
          :model="adminForm"
          :rules="adminRules"
          label-position="top"
          class="form-grid"
        >
          <el-form-item label="用户名" prop="username">
            <el-input v-model="adminForm.username" placeholder="登录用户名" clearable />
          </el-form-item>

          <el-form-item label="昵称">
            <el-input v-model="adminForm.nickname" placeholder="显示名称" clearable />
          </el-form-item>

          <el-form-item label="新密码" prop="password" class="span-2">
            <el-input
              v-model="adminForm.password"
              type="password"
              show-password
              placeholder="留空表示不修改"
              clearable
            />
            <p class="field-tip">至少 6 位；修改用户名或密码后需要重新登录</p>
          </el-form-item>
        </el-form>

        <div class="section__actions">
          <el-button type="primary" :loading="savingAdmin" @click="saveAdmin"
            >保存账号信息</el-button
          >
        </div>
      </div>
    </section>

    <!-- ==================== 登录二次验证（D1） ==================== -->
    <section class="surface section">
      <header class="section__head">
        <span class="section__glyph" style="color: var(--brand); background: var(--brand-soft)">
          <el-icon><Key /></el-icon>
        </span>
        <div class="section__titles">
          <h2 class="section__title">
            登录二次验证
            <span class="section__state" :class="totp.enabled ? 'is-on' : 'is-off'">
              {{ totp.enabled ? '已启用' : '未启用' }}
            </span>
          </h2>
          <p class="section__sub">登录时除了密码，再要一次验证器 App 上的动态码</p>
        </div>
      </header>

      <div class="section__body">
        <el-alert
          class="role-note"
          :type="totp.enabled ? 'success' : 'warning'"
          :closable="false"
          show-icon
          :title="
            totp.enabled ? '已开启 —— 密码泄露也进不来' : '面板暴露在公网，目前密码是唯一防线'
          "
          :description="
            totp.enabled
              ? `绑定于 ${totp.boundAt || '—'}，还有 ${totp.recoveryLeft} 个恢复码可用。`
              : '开启后，即使密码泄露，对方没有你的手机也登不进来。支持 Google Authenticator、微软验证器、1Password 等任意 TOTP 应用。'
          "
        />

        <div class="section__actions">
          <el-button
            v-if="!totp.enabled"
            class="totp-bind-btn"
            type="primary"
            :loading="totpBusy"
            @click="startTotpSetup"
          >
            <el-icon><Key /></el-icon>开始绑定
          </el-button>
          <template v-else>
            <el-button :loading="totpBusy" @click="regenRecovery">重新获取恢复码</el-button>
            <el-button type="danger" plain :loading="totpBusy" @click="disableVisible = true">
              关闭二次验证
            </el-button>
          </template>
        </div>
      </div>
    </section>

    <!-- ==================== 用户与角色（B5） ==================== -->
    <section class="surface section">
      <header class="section__head">
        <span class="section__glyph" style="color: var(--brand); background: var(--brand-soft)">
          <el-icon><UserFilled /></el-icon>
        </span>
        <div class="section__titles">
          <h2 class="section__title">
            用户与角色
            <span class="section__state" :class="users.length ? 'is-on' : 'is-off'">
              {{ users.length }} 个账号
            </span>
          </h2>
          <p class="section__sub">给同事开号并分配角色 · 只有管理员能进这一页</p>
        </div>
      </header>

      <div class="section__body">
        <el-alert
          class="role-note"
          type="info"
          :closable="false"
          show-icon
          title="三种角色能做什么"
          description="管理员：全部功能，含本页与系统设置；运维：能操作网站 / DNS / 容器 / 部署 / 巡检修复，但改不了系统配置、也管不了账号；只读：只能看，任何写操作都会被服务端直接拒绝（不只是按钮藏起来）。"
        />

        <!-- 窄屏用卡片：Element Plus 表格在手机上会出现"横向滚动条地狱"，
             而且它的表头是靠 JS 跟着表体滚的，没法用 overflow 兜住。
             项目其它列表页也都是"窄屏换卡片"，这里保持一致。 -->
        <ul v-if="isNarrow" class="u-cards">
          <li v-for="u in users" :key="u.id" class="u-card">
            <div class="u-card__head">
              <strong>{{ u.nickname }}</strong>
              <el-tag :type="roleTag(u.role)" effect="light" size="small">{{ u.roleText }}</el-tag>
            </div>
            <div class="u-card__meta mono">@{{ u.username }}</div>
            <div class="u-card__meta">最近登录：{{ u.lastLoginAt || '—' }}</div>
            <div class="u-card__actions">
              <el-button size="small" @click="openUserDialog(u)">编辑</el-button>
              <el-button size="small" @click="resetPassword(u)">重置密码</el-button>
              <el-button
                size="small"
                type="danger"
                plain
                :disabled="u.id === auth.user?.id"
                @click="removeUser(u)"
              >
                删除
              </el-button>
            </div>
          </li>
        </ul>

        <!-- 宽屏用表格 -->
        <div v-else class="user-table__wrap">
          <el-table v-loading="loadingUsers" :data="users" size="small" class="user-table">
            <el-table-column prop="username" label="用户名" min-width="120" />
            <el-table-column prop="nickname" label="显示名" min-width="110" />
            <el-table-column label="角色" width="120">
              <template #default="{ row }">
                <el-tag :type="roleTag(row.role)" effect="light" size="small">
                  {{ row.roleText }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="最近登录" min-width="150">
              <template #default="{ row }">{{ row.lastLoginAt || '—' }}</template>
            </el-table-column>
            <el-table-column label="操作" width="220" align="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openUserDialog(row)">编辑</el-button>
                <el-button link type="warning" @click="resetPassword(row)">重置密码</el-button>
                <el-button
                  link
                  type="danger"
                  :disabled="row.id === auth.user?.id"
                  :title="row.id === auth.user?.id ? '不能删除自己的账号' : ''"
                  @click="removeUser(row)"
                >
                  删除
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <div class="section__actions">
          <el-button type="primary" @click="openUserDialog(null)">
            <el-icon><Plus /></el-icon>新建用户
          </el-button>
        </div>
      </div>
    </section>

    <!-- ==================== 外观 ==================== -->
    <section class="surface section">
      <header class="section__head">
        <span class="section__glyph" style="color: var(--brand); background: var(--brand-soft)">
          <el-icon><Sunny /></el-icon>
        </span>
        <div class="section__titles">
          <h2 class="section__title">外观</h2>
          <p class="section__sub">
            主题色与明暗模式 · 选择只保存在本机浏览器（默认「{{ theme.brandName }}」）
          </p>
        </div>
      </header>

      <div class="appearance">
        <div class="appearance__row">
          <span class="appearance__label">主题色</span>
          <div class="swatches" role="radiogroup" aria-label="主题色">
            <button
              v-for="item in theme.brandPresets"
              :key="item.id"
              type="button"
              class="swatch"
              :class="{ 'is-active': theme.brand === item.id }"
              role="radio"
              :aria-checked="theme.brand === item.id ? 'true' : 'false'"
              :title="`${item.name} · ${item.hint}`"
              @click="theme.setBrand(item.id)"
            >
              <span class="swatch__dot" :style="{ background: item.color }" aria-hidden="true">
                <el-icon v-if="theme.brand === item.id"><Check /></el-icon>
              </span>
              <span class="swatch__name">{{ item.name }}</span>
            </button>
          </div>
        </div>

        <div class="appearance__row">
          <span class="appearance__label">明暗模式</span>
          <div class="mode-switch" role="radiogroup" aria-label="明暗模式">
            <button
              v-for="mode in MODES"
              :key="mode.id"
              type="button"
              class="mode-switch__btn"
              :class="{ 'is-active': theme.theme === mode.id }"
              role="radio"
              :aria-checked="theme.theme === mode.id ? 'true' : 'false'"
              @click="setThemeMode(mode.id)"
            >
              <el-icon><component :is="mode.icon" /></el-icon>
              {{ mode.label }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- ==================== 运行环境 ==================== -->
    <section class="surface section">
      <header class="section__head">
        <span class="section__glyph" style="color: var(--info); background: var(--info-soft)">
          <el-icon><Cpu /></el-icon>
        </span>
        <div class="section__titles">
          <h2 class="section__title">运行环境</h2>
          <p class="section__sub">只读信息，用于排查部署问题</p>
        </div>
      </header>

      <div class="runtime">
        <div v-for="item in runtimeRows" :key="item.label" class="runtime__item">
          <span class="runtime__k">{{ item.label }}</span>
          <span class="runtime__v">{{ item.value }}</span>
        </div>
      </div>
    </section>

    <!-- ==================== 绑定验证器弹窗（D1） ==================== -->
    <el-dialog
      v-model="totpDialogVisible"
      :title="totpMode === 'bind' ? '绑定验证器' : '新的恢复码'"
      width="min(540px, 92vw)"
      :close-on-click-modal="false"
      @closed="clearTotpSecrets"
    >
      <template v-if="totpMode === 'bind'">
        <div class="totp-step">
          <h4>1. 用验证器 App 扫码</h4>
          <p>扫不了二维码，就在 App 里选「手动输入密钥」，把这串填进去。</p>
          <div class="totp-qr">
            <img v-if="totpQr" :src="totpQr" alt="TOTP 绑定二维码" />
            <span v-else class="totp-qr__loading">正在生成二维码…</span>
          </div>
          <div class="totp-secret">
            <span class="mono">{{ totpData.secretText }}</span>
            <CopyBtn :text="totpData.secret" title="复制密钥" ok-message="密钥已复制" />
          </div>
        </div>

        <div class="totp-step">
          <h4>2. 把恢复码抄下来（这一步别跳过）</h4>
          <p class="totp-tip">
            手机丢了或验证器被卸载时，这些码是唯一的进路。每个只能用一次，
            请存进密码管理器或写在纸上。
          </p>
          <ul class="totp-codes">
            <li v-for="c in totpData.recoveryCodes" :key="c" class="mono">{{ c }}</li>
          </ul>
          <CopyBtn
            :text="totpData.recoveryCodes.join('\n')"
            title="复制全部恢复码"
            ok-message="恢复码已复制"
          />
        </div>

        <div class="totp-step">
          <h4>3. 输入验证器上显示的 6 位码，完成绑定</h4>
          <el-input
            v-model="totpCode"
            placeholder="6 位数字"
            maxlength="6"
            class="totp-code-input"
            @keyup.enter="confirmTotpEnable"
          />
        </div>
      </template>

      <template v-else>
        <el-alert
          type="warning"
          :closable="false"
          show-icon
          title="旧恢复码已全部作废"
          description="请立刻把下面这些抄到安全的地方 —— 关掉这个窗口就再也看不到了。"
        />
        <ul class="totp-codes totp-codes--wide">
          <li v-for="c in totpData.recoveryCodes" :key="c" class="mono">{{ c }}</li>
        </ul>
        <CopyBtn
          :text="totpData.recoveryCodes.join('\n')"
          title="复制全部恢复码"
          ok-message="恢复码已复制"
        />
      </template>

      <template #footer>
        <el-button @click="totpDialogVisible = false">
          {{ totpMode === 'bind' ? '稍后再说' : '我已保存' }}
        </el-button>
        <el-button
          v-if="totpMode === 'bind'"
          type="primary"
          :loading="totpBusy"
          @click="confirmTotpEnable"
        >
          完成绑定
        </el-button>
      </template>
    </el-dialog>

    <!-- ==================== 关闭二次验证弹窗 ==================== -->
    <el-dialog
      v-model="disableVisible"
      title="关闭二次验证"
      width="min(440px, 92vw)"
      :close-on-click-modal="false"
    >
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="关闭后只剩密码这一道防线"
        description="需要同时提供密码与当前动态码 —— 避免登录会话被盗之后，被人一键关掉二次验证。"
      />
      <el-form label-position="top" class="disable-form">
        <el-form-item label="当前密码">
          <el-input
            v-model="disableForm.password"
            type="password"
            show-password
            placeholder="登录密码"
          />
        </el-form-item>
        <el-form-item label="验证器上的 6 位码">
          <el-input v-model="disableForm.code" maxlength="6" placeholder="6 位数字" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="disableVisible = false">取消</el-button>
        <el-button type="danger" :loading="totpBusy" @click="confirmDisable">确认关闭</el-button>
      </template>
    </el-dialog>

    <!-- ==================== 用户编辑弹窗 ==================== -->
    <el-dialog
      v-model="userDialogVisible"
      :title="userForm.id ? '编辑用户' : '新建用户'"
      width="min(480px, 92vw)"
      :close-on-click-modal="false"
    >
      <el-form ref="userFormRef" :model="userForm" :rules="userRules" label-width="86px">
        <el-form-item label="用户名" prop="username">
          <el-input
            v-model="userForm.username"
            :disabled="!!userForm.id"
            placeholder="登录用的用户名，至少 3 位"
            clearable
          />
          <p v-if="userForm.id" class="field-tip">用户名创建后不可修改。</p>
        </el-form-item>

        <el-form-item label="显示名" prop="nickname">
          <el-input
            v-model="userForm.nickname"
            placeholder="比如：小王（可留空，默认用用户名）"
            clearable
          />
        </el-form-item>

        <el-form-item v-if="!userForm.id" label="初始密码" prop="password">
          <el-input
            v-model="userForm.password"
            type="password"
            show-password
            placeholder="至少 6 位"
          />
        </el-form-item>

        <el-form-item label="角色" prop="role">
          <el-select
            v-model="userForm.role"
            :disabled="userForm.id === auth.user?.id"
            style="width: 100%"
          >
            <el-option v-for="r in roleOptions" :key="r.value" :label="r.label" :value="r.value">
              <span>{{ r.label }}</span>
              <span class="role-opt__hint">{{ r.hint }}</span>
            </el-option>
          </el-select>
          <p v-if="userForm.id === auth.user?.id" class="field-tip">
            不能修改自己的角色 —— 防止把自己降级后再也进不来。
          </p>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="userDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="savingUser" @click="saveUser">保存</el-button>
      </template>
    </el-dialog>

    <!-- ==================== 新令牌弹窗 ==================== -->
    <el-dialog
      v-model="tokenVisible"
      :title="tokenScope === 'readonly' ? '新的 MCP 只读令牌' : '新的 MCP 令牌'"
      width="min(520px, 92vw)"
      :close-on-click-modal="false"
    >
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="请立即复制保存"
        :description="
          tokenScope === 'readonly'
            ? '只读令牌只显示这一次，关闭后无法再查看。旧的只读令牌已失效，全权令牌不受影响。'
            : '令牌只显示这一次，关闭后无法再查看。旧令牌已同时失效，请同步更新 AI 工具里的配置。'
        "
      />
      <div class="token-box mono">{{ newToken }}</div>
      <template #footer>
        <el-button @click="tokenVisible = false">我已保存</el-button>
        <el-button type="primary" @click="copyText(newToken, '令牌已复制')">
          <el-icon><DocumentCopy /></el-icon>复制令牌
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, reactive, ref } from 'vue';
// 深路径导入：不要改回 'element-plus'（barrel 入口会阻止 tree-shaking，详见 main.js）
import { ElMessage } from 'element-plus/es/components/message/index';
import { ElMessageBox } from 'element-plus/es/components/message-box/index';
// 两级降级的复制实现（https 剪贴板 API → execCommand 兜底），避免 http 访问时点了没反应
import { copyText } from '@/composables/useCopy';
import { useNarrow } from '@/composables/useNarrow';
import { settingApi, alertApi, userApi, authApi } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { useThemeStore } from '@/stores/theme';

const auth = useAuthStore();
const theme = useThemeStore();

/** 窄屏下用户列表改用卡片（与项目其它列表页一致），断点与侧栏收起点保持一致 */
const isNarrow = useNarrow(900);

/** 明暗模式选项（图标走 main.js 里的全局注册） */
const MODES = [
  { id: 'light', label: '浅色', icon: 'Sunny' },
  { id: 'dark', label: '深色', icon: 'Moon' },
];

function setThemeMode(mode) {
  if (theme.theme === mode) return;
  theme.theme = mode;
  theme.apply();
}

const loading = ref(true);
const settingsMeta = ref({});
const runtime = ref({});
const mcp = ref(null);

/** 表单绑定值 */
const form = reactive({
  bt_panel_url: '',
  bt_api_key: '',
  cf_api_token: '',
  cf_account_email: '',
  docker_host: '',
  server_public_ip: '',
  deploy_network: '',
  deploy_data_dir: '',
  host_data_dir: '',
  registry_mirror: '',
  // 告警外部通道（敏感项，留空=不修改）
  alert_webhook_url: '',
  alert_feishu_webhook: '',
  alert_feishu_secret: '',
  alert_wecom_webhook: '',
  // 代码仓库（B4）：令牌是敏感项，仓库列表是普通项
  github_token: '',
  github_repos: '',
});

/** 保存时的初始快照，用于判断「是否有改动」 */
const snapshot = ref({});

const saving = ref('');
const testing = ref('');
const testResults = reactive({});

const DEPLOY_KEYS = [
  'server_public_ip',
  'deploy_network',
  'deploy_data_dir',
  'host_data_dir',
  'registry_mirror',
];
/** 告警外部通道（四个都是敏感项，留空表示不修改） */
const ALERT_KEYS = [
  'alert_webhook_url',
  'alert_feishu_webhook',
  'alert_feishu_secret',
  'alert_wecom_webhook',
];

/** 是否已配置任一外部通道（只用于界面上的状态徽标） */
const isAlertOn = computed(() => ALERT_KEYS.some((key) => settingsMeta.value[key]?.hasValue));

/** 代码仓库（B4）：令牌是敏感项，仓库列表是普通项 */
const GITHUB_KEYS = ['github_repos', 'github_token'];
/** 有令牌 = 5000 次/小时；没有 = 匿名 60 次/小时。界面上的徽标用 */
const githubHasToken = computed(() => !!settingsMeta.value.github_token?.hasValue);

// ---------------- 分组定义 ----------------
const connectionGroups = computed(() => [
  {
    key: 'baota',
    title: '宝塔面板',
    desc: '读取服务器状态、管理网站、写反向代理配置',
    icon: 'Monitor',
    color: 'var(--brand)',
    bg: 'var(--brand-soft)',
    configured: !!settingsMeta.value.bt_api_key?.hasValue,
    keys: ['bt_panel_url', 'bt_api_key'],
    fields: [
      {
        key: 'bt_panel_url',
        label: '面板地址',
        wide: false,
        tip: '本机部署一般填 http://127.0.0.1:8888',
      },
      {
        key: 'bt_api_key',
        label: 'API 密钥',
        secret: true,
        wide: false,
        tip: '宝塔面板 → 设置 → API 接口 → 密钥，并记得把本机 IP 加入白名单',
      },
    ],
  },
  {
    key: 'cloudflare',
    title: 'Cloudflare',
    desc: '管理域名区域与 DNS 解析记录',
    icon: 'Connection',
    color: 'var(--info)',
    bg: 'var(--info-soft)',
    configured: !!settingsMeta.value.cf_api_token?.hasValue,
    keys: ['cf_api_token', 'cf_account_email'],
    fields: [
      {
        key: 'cf_api_token',
        label: 'API Token',
        secret: true,
        wide: true,
        tip: '使用 API Token（不是 Global API Key），权限需要 Zone:Read 与 DNS:Edit',
      },
      {
        key: 'cf_account_email',
        label: '账号邮箱（选填）',
        wide: false,
        tip: '仅用于核对账号，不影响 API 调用',
      },
    ],
  },
  {
    key: 'docker',
    title: 'Docker 引擎',
    desc: '容器与镜像管理、应用一键部署',
    icon: 'Box',
    color: 'var(--success)',
    bg: 'var(--success-soft)',
    configured: !!settingsMeta.value.docker_host?.hasValue,
    keys: ['docker_host'],
    fields: [
      {
        key: 'docker_host',
        label: '连接地址',
        wide: true,
        tip: '容器内部署填 unix:///var/run/docker.sock（docker-compose 已挂载）；远程 Docker 填 tcp://IP:2375',
      },
    ],
  },
]);

const isDirty = (keys) => keys.some((k) => (form[k] ?? '') !== (snapshot.value[k] ?? ''));

/** 敏感项已配置时，空输入框给掩码作为提示 */
function placeholderOf(field) {
  if (field.secret && settingsMeta.value[field.key]?.hasValue) {
    return `已保存（${settingsMeta.value[field.key].value}），留空表示不修改`;
  }
  return '请输入';
}

// ---------------- 加载 ----------------
async function loadSettings() {
  loading.value = true;
  try {
    const data = await settingApi.get();
    settingsMeta.value = data.settings || {};
    runtime.value = data.runtime || {};

    Object.keys(form).forEach((key) => {
      // 敏感项不回填明文（后端只给掩码），留空表示不修改
      const meta = settingsMeta.value[key];
      form[key] = meta && !meta.secret ? meta.value || '' : '';
    });
    snapshot.value = { ...form };
  } catch {
    /* 拦截器已提示 */
  } finally {
    loading.value = false;
  }
}

async function loadMcp() {
  try {
    mcp.value = await settingApi.mcp();
  } catch {
    mcp.value = null;
  }
}

// ---------------- 保存 ----------------
async function saveKeys(keys, groupKey) {
  saving.value = groupKey;
  const patch = {};
  keys.forEach((k) => {
    patch[k] = form[k] ?? '';
  });

  try {
    const data = await settingApi.save(patch);
    ElMessage.success(
      data.changed?.length ? `已保存 ${data.changed.length} 项配置` : '配置未发生变化'
    );
    await loadSettings();
    if (keys.includes('docker_host')) await loadMcp();
  } catch {
    /* 拦截器已提示 */
  } finally {
    saving.value = '';
  }
}

// ---------------- 测试连接 ----------------
async function testConnection(group) {
  testing.value = group.key;
  delete testResults[group.key];
  try {
    // 用表单里当前填的值测试：用户改完可以先测再保存
    const payload = {};
    group.keys.forEach((k) => {
      if (form[k]) payload[k] = form[k];
    });
    const data = await settingApi.test(group.key, payload);
    testResults[group.key] = data;
    ElMessage.success(data.message);
  } catch (err) {
    testResults[group.key] = { ok: false, message: err.message || '连接失败' };
  } finally {
    testing.value = '';
  }
}

// ---------------- MCP ----------------
const tokenVisible = ref(false);
const newToken = ref('');
// 弹窗是「刚生成了哪把令牌」——全权与只读共用同一个弹窗，靠它区分文案
const tokenScope = ref('full');

const mcpConfigText = computed(() => JSON.stringify(mcp.value?.templateUrl?.trae || {}, null, 2));
// 只读令牌的现成配置（后端未生成只读令牌时为 null，此时不展示）
const readonlyConfigText = computed(() =>
  JSON.stringify(mcp.value?.readonly?.config || {}, null, 2)
);

async function regenerateToken() {
  try {
    await ElMessageBox.confirm(
      '重新生成后，旧令牌立即失效。所有已连接本工作台的 AI 工具都需要更新配置，确定继续吗？',
      '重新生成 MCP 令牌',
      { confirmButtonText: '继续生成', cancelButtonText: '取消', type: 'warning' }
    );
  } catch {
    return;
  }

  try {
    const data = await settingApi.mcpToken({ scope: 'full' });
    newToken.value = data.token;
    tokenScope.value = 'full';
    tokenVisible.value = true;
    loadMcp();
  } catch {
    /* 拦截器已提示 */
  }
}

async function generateReadonlyToken() {
  const already = mcp.value?.readonly?.configured;
  if (already) {
    try {
      await ElMessageBox.confirm(
        '重新生成后，旧的只读令牌立即失效，已配好只读连接的 AI 工具需要更新配置。全权令牌不受影响。确定继续吗？',
        '重新生成只读令牌',
        { confirmButtonText: '继续生成', cancelButtonText: '取消', type: 'warning' }
      );
    } catch {
      return;
    }
  }

  try {
    const data = await settingApi.mcpToken({ scope: 'readonly' });
    newToken.value = data.token;
    tokenScope.value = 'readonly';
    tokenVisible.value = true;
    loadMcp();
  } catch {
    /* 拦截器已提示 */
  }
}

async function revokeReadonlyToken() {
  try {
    await ElMessageBox.confirm(
      '吊销后这把只读令牌立即失效，已用它连接的 AI 工具会连不上（全权令牌不受影响）。确定吊销吗？',
      '吊销只读令牌',
      { confirmButtonText: '确定吊销', cancelButtonText: '取消', type: 'warning' }
    );
  } catch {
    return;
  }

  try {
    const data = await settingApi.mcpToken({ scope: 'readonly', revoke: true });
    ElMessage.success(data.message || '只读令牌已吊销');
    loadMcp();
  } catch {
    /* 拦截器已提示 */
  }
}

async function testAlert() {
  testing.value = 'alert';
  try {
    const r = await alertApi.test();
    if (r.ok) ElMessage.success(r.message);
    else ElMessage.warning(r.message);
  } catch {
    /* 拦截器已提示 */
  } finally {
    testing.value = '';
  }
}

// ---------------- 管理员 ----------------
const adminFormRef = ref(null);
const savingAdmin = ref(false);
const adminForm = reactive({ username: '', nickname: '', password: '' });

const adminRules = {
  username: [
    { required: true, message: '用户名不能为空', trigger: 'blur' },
    { min: 3, message: '用户名至少 3 位', trigger: 'blur' },
  ],
  password: [
    {
      validator: (_rule, value, callback) =>
        !value || value.length >= 6 ? callback() : callback(new Error('密码至少 6 位')),
      trigger: 'blur',
    },
  ],
};

async function saveAdmin() {
  try {
    await adminFormRef.value.validate();
  } catch {
    return;
  }

  savingAdmin.value = true;
  try {
    const payload = { nickname: adminForm.nickname };
    if (adminForm.username && adminForm.username !== auth.user?.username)
      payload.username = adminForm.username;
    if (adminForm.password) payload.password = adminForm.password;

    const data = await settingApi.updateAdmin(payload);
    ElMessage.success(data.message || '账号信息已更新');
    adminForm.password = '';
    await auth.fetchProfile();
  } catch {
    /* 拦截器已提示 */
  } finally {
    savingAdmin.value = false;
  }
}

// ---------------- 登录二次验证（D1） ----------------
const totp = reactive({ enabled: false, boundAt: '', recoveryLeft: 0 });
const totpBusy = ref(false);
/** bind = 完整的绑定三步流程；recovery = 只展示新生成的恢复码 */
const totpMode = ref('bind');
const totpDialogVisible = ref(false);
const totpData = reactive({ secret: '', secretText: '', otpauthUrl: '', recoveryCodes: [] });
const totpQr = ref('');
const totpCode = ref('');
const disableVisible = ref(false);
const disableForm = reactive({ password: '', code: '' });

async function loadTotp() {
  try {
    Object.assign(totp, await authApi.totpStatus());
  } catch {
    /* 取不到就按未启用显示，不影响其它设置 */
  }
}

async function startTotpSetup() {
  totpBusy.value = true;
  try {
    const data = await authApi.totpSetup();
    Object.assign(totpData, data);
    totpMode.value = 'bind';
    totpQr.value = '';
    totpCode.value = '';
    totpDialogVisible.value = true;

    // 二维码按需加载：qrcode 库只在打开这个弹窗时才下载，不进首屏
    const { default: QRCode } = await import('qrcode');
    totpQr.value = await QRCode.toDataURL(data.otpauthUrl, { margin: 1, width: 220 });
  } catch {
    /* 拦截器已提示 */
  } finally {
    totpBusy.value = false;
  }
}

async function confirmTotpEnable() {
  if (!/^\d{6}$/.test(totpCode.value.trim())) {
    ElMessage.warning('请输入验证器上显示的 6 位数字');
    return;
  }

  totpBusy.value = true;
  try {
    const data = await authApi.totpEnable(totpCode.value.trim());
    ElMessage.success(data.message || '已启用二次验证');
    totpDialogVisible.value = false;
    await loadTotp();
  } catch {
    /* 拦截器已提示（验证码不对、已启用等） */
  } finally {
    totpBusy.value = false;
  }
}

async function regenRecovery() {
  let code;
  try {
    const r = await ElMessageBox.prompt(
      '重新生成后，旧的恢复码全部作废。请输入验证器上的 6 位码确认。',
      '重新获取恢复码',
      {
        confirmButtonText: '生成',
        cancelButtonText: '取消',
        inputPattern: /^\d{6}$/,
        inputErrorMessage: '请输入 6 位数字',
      }
    );
    code = r.value;
  } catch {
    return; // 用户取消
  }

  totpBusy.value = true;
  try {
    const data = await authApi.totpRecovery(code);
    totpData.recoveryCodes = data.recoveryCodes;
    totpMode.value = 'recovery';
    totpDialogVisible.value = true;
    ElMessage.success('新的恢复码已生成 —— 旧的已作废');
    await loadTotp();
  } catch {
    /* 拦截器已提示 */
  } finally {
    totpBusy.value = false;
  }
}

async function confirmDisable() {
  if (!disableForm.password || !/^\d{6}$/.test(disableForm.code.trim())) {
    ElMessage.warning('请填写当前密码和 6 位动态码');
    return;
  }

  totpBusy.value = true;
  try {
    const data = await authApi.totpDisable({
      password: disableForm.password,
      code: disableForm.code.trim(),
    });
    ElMessage.success(data.message || '已关闭二次验证');
    disableVisible.value = false;
    disableForm.password = '';
    disableForm.code = '';
    await loadTotp();
  } catch {
    /* 拦截器已提示 */
  } finally {
    totpBusy.value = false;
  }
}

/** 弹窗关闭后立刻清掉密钥/恢复码 —— 别让它们一直留在内存里 */
function clearTotpSecrets() {
  totpData.secret = '';
  totpData.secretText = '';
  totpData.otpauthUrl = '';
  totpData.recoveryCodes = [];
  totpQr.value = '';
  totpCode.value = '';
}

// ---------------- 用户与角色（B5 · 仅管理员） ----------------
const users = ref([]);
const loadingUsers = ref(false);
const userDialogVisible = ref(false);
const savingUser = ref(false);
const userFormRef = ref(null);
const userForm = reactive({ id: null, username: '', nickname: '', password: '', role: 'viewer' });

/** 角色说明：写清「能不能改系统设置」，比只给个名字有用得多 */
const roleOptions = [
  { value: 'viewer', label: '只读', hint: '只能看，写操作会被拒' },
  { value: 'operator', label: '运维', hint: '能操作，改不了系统设置' },
  { value: 'admin', label: '管理员', hint: '全部权限' },
];

const roleTag = (role) => ({ admin: 'success', operator: 'warning' })[role] || 'info';

const userRules = {
  username: [
    { required: true, message: '用户名不能为空', trigger: 'blur' },
    { min: 3, message: '用户名至少 3 位', trigger: 'blur' },
  ],
  password: [
    { required: true, message: '初始密码不能为空', trigger: 'blur' },
    { min: 6, message: '密码至少 6 位', trigger: 'blur' },
  ],
};

async function loadUsers() {
  loadingUsers.value = true;
  try {
    const data = await userApi.list();
    users.value = data.list || [];
  } catch {
    users.value = [];
  } finally {
    loadingUsers.value = false;
  }
}

function openUserDialog(row) {
  Object.assign(userForm, {
    id: row?.id || null,
    username: row?.username || '',
    nickname: row?.nickname || '',
    password: '',
    role: row?.role || 'viewer',
  });
  userDialogVisible.value = true;
  // 清掉上一次留下的校验红字，否则「新建」会带着上次的报错打开
  nextTick(() => userFormRef.value?.clearValidate());
}

async function saveUser() {
  try {
    await userFormRef.value.validate();
  } catch {
    return;
  }

  savingUser.value = true;
  try {
    const data = userForm.id
      ? await userApi.update(userForm.id, { nickname: userForm.nickname, role: userForm.role })
      : await userApi.create({
          username: userForm.username,
          nickname: userForm.nickname,
          password: userForm.password,
          role: userForm.role,
        });
    ElMessage.success(data.message || '已保存');
    userDialogVisible.value = false;
    await loadUsers();
  } catch {
    /* 拦截器已提示 */
  } finally {
    savingUser.value = false;
  }
}

async function resetPassword(row) {
  let value;
  try {
    const r = await ElMessageBox.prompt(
      `给「${row.username}」设置新密码（至少 6 位）`,
      '重置密码',
      {
        confirmButtonText: '确定重置',
        cancelButtonText: '取消',
        inputType: 'password',
        inputPattern: /.{6,}/,
        inputErrorMessage: '密码至少 6 位',
      }
    );
    value = r.value;
  } catch {
    return; // 用户取消
  }

  try {
    const data = await userApi.update(row.id, { password: value });
    ElMessage.success(data.message || '密码已重置');
  } catch {
    /* 拦截器已提示 */
  }
}

async function removeUser(row) {
  try {
    await ElMessageBox.confirm(
      `删除后「${row.username}」将立即无法登录（他手上的登录令牌也会马上失效）。确定删除吗？`,
      '删除用户',
      { confirmButtonText: '确定删除', cancelButtonText: '取消', type: 'warning' }
    );
  } catch {
    return;
  }

  try {
    const data = await userApi.remove(row.id);
    ElMessage.success(data.message || '已删除');
    await loadUsers();
  } catch {
    /* 拦截器已提示 */
  }
}

// ---------------- 运行环境 ----------------
const systemInfo = ref({});
const runtimeRows = computed(() => [
  { label: 'Node 版本', value: systemInfo.value.nodeVersion || '—' },
  { label: '运行平台', value: systemInfo.value.platform || '—' },
  { label: '部署方式', value: systemInfo.value.deployMode || '—' },
  { label: 'API 端口', value: systemInfo.value.apiPort ?? '—' },
  { label: 'MCP 端口', value: systemInfo.value.mcpPort ?? '—' },
  { label: '已运行', value: formatUptime(systemInfo.value.uptimeSeconds) },
  {
    label: '进程内存',
    value: systemInfo.value.memoryUsageMb != null ? `${systemInfo.value.memoryUsageMb} MB` : '—',
  },
  { label: '数据库文件', value: systemInfo.value.dbPath || '—' },
  { label: '宿主机数据目录', value: systemInfo.value.hostDataDir || '—' },
]);

function formatUptime(seconds) {
  const s = Number(seconds) || 0;
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分钟`;
  return `${Math.floor(s / 86400)} 天 ${Math.floor((s % 86400) / 3600)} 小时`;
}

onMounted(async () => {
  await loadSettings();
  loadMcp();
  // 用户列表只有管理员能取（后端会 403），这一页本身也只有管理员能进
  loadUsers();
  loadTotp();
  try {
    systemInfo.value = await settingApi.system();
  } catch {
    /* 运行信息取不到不影响使用 */
  }
  adminForm.username = auth.user?.username || '';
  adminForm.nickname = auth.user?.nickname || '';
});
</script>

<style scoped>
.section {
  overflow: hidden;
}

.section__head {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: var(--sp-4) var(--sp-5);
  border-bottom: 1px solid var(--border-hairline);
}

.section__glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  border-radius: var(--r-md);
  font-size: 16px;
}

.section__titles {
  min-width: 0;
}

.section__title {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text-primary);
}

.section__state {
  padding: 0 7px;
  border-radius: var(--r-full);
  font-size: 11px;
  font-weight: 500;
  line-height: 17px;
}

.section__state.is-on {
  background: var(--success-soft);
  color: var(--success);
}

.section__state.is-off {
  background: var(--warning-soft);
  color: var(--warning);
}

.section__sub {
  margin-top: 2px;
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}

.section__body {
  padding: var(--sp-5);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 var(--sp-5);
}

.form-grid :deep(.el-form-item) {
  margin-bottom: var(--sp-4);
}

.span-2 {
  grid-column: span 2;
}

.field-tip {
  margin-top: 4px;
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-tertiary);
  overflow-wrap: anywhere;
}

.field-tip code {
  padding: 1px 5px;
  border-radius: var(--r-xs);
  background: var(--bg-subtle);
  font-family: 'SFMono-Regular', Consolas, Menlo, monospace;
}

.section__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border-hairline);
}

.test-result {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
  font-size: var(--fs-sm);
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.test-result.is-ok {
  color: var(--success);
}

.test-result.is-fail {
  color: var(--danger);
}

.test-result .el-icon {
  margin-top: 3px;
  flex: 0 0 auto;
}

/* ---------------- MCP ---------------- */
.mcp-grid {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-5);
  flex-wrap: wrap;
  margin-bottom: var(--sp-4);
}

.mcp-info {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-width: 0;
}

.kv {
  display: flex;
  gap: var(--sp-3);
  font-size: var(--fs-sm);
}

.kv__k {
  flex: 0 0 84px;
  color: var(--text-tertiary);
}

.kv__v {
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.mcp-actions {
  display: flex;
  gap: var(--sp-2);
  flex-wrap: wrap;
}

.code-block {
  margin: 0 0 var(--sp-4);
  padding: var(--sp-4);
  border-radius: var(--r-md);
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
  color: var(--text-secondary);
  font-family: 'SFMono-Regular', Consolas, Menlo, monospace;
  font-size: 12px;
  line-height: 1.7;
  overflow-x: auto;
}

.tools-collapse {
  margin-bottom: var(--sp-3);
}

/* 「一个 MCP 就够」提示：插在配置与工具清单之间，做视觉分隔 */
.mcp-note {
  margin-bottom: var(--sp-4);
}

/* ---------------- 只读令牌（D2） ----------------
   视觉上刻意比上面的全权配置「轻一档」：虚线边 + 浅底，表示它是可选的第二把凭据，
   而不是又一个主配置区。*/
.ro-card {
  margin-top: var(--sp-5);
  padding: var(--sp-4);
  border-radius: var(--r-md);
  background: var(--bg-subtle);
  border: 1px dashed var(--border-hairline);
}

.ro-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  flex-wrap: wrap;
}

.ro-card__titles {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}

.ro-card__badge {
  padding: 2px 8px;
  border-radius: var(--r-full);
  background: var(--brand-soft);
  color: var(--brand);
  font-size: var(--fs-xs);
  font-weight: 600;
}

.ro-card__title {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-primary);
}

.ro-card__actions {
  display: flex;
  gap: var(--sp-2);
  flex-wrap: wrap;
}

.ro-card__desc {
  margin-top: var(--sp-3);
  font-size: var(--fs-xs);
  line-height: 1.7;
  color: var(--text-secondary);
}

.ro-card__body {
  margin-top: var(--sp-3);
}

/* ---------------- 登录二次验证（D1） ---------------- */
.totp-step + .totp-step {
  margin-top: var(--sp-5);
  padding-top: var(--sp-4);
  border-top: 1px solid var(--border-hairline);
}

.totp-step h4 {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-primary);
}

.totp-step p {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-xs);
  line-height: 1.7;
  color: var(--text-secondary);
}

.totp-tip {
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  background: var(--bg-subtle);
}

.totp-qr {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 220px;
  height: 220px;
  margin: 0 auto var(--sp-3);
  border-radius: var(--r-md);
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
}

.totp-qr img {
  width: 100%;
  height: 100%;
  border-radius: var(--r-md);
}

.totp-qr__loading {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
}

.totp-secret {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  background: var(--bg-subtle);
  border: 1px dashed var(--border-hairline);
  font-size: var(--fs-sm);
  overflow-wrap: anywhere;
}

.totp-codes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--sp-2);
  margin: 0 0 var(--sp-3);
  padding: 0;
  list-style: none;
}

.totp-codes li {
  padding: 4px var(--sp-2);
  border-radius: var(--r-md);
  background: var(--bg-subtle);
  font-size: var(--fs-sm);
  text-align: center;
  color: var(--text-primary);
  /* 恢复码是要手抄的，允许一键选中整串 */
  user-select: all;
}

.totp-codes--wide {
  margin-top: var(--sp-3);
}

.totp-code-input :deep(.el-input__inner) {
  font-family: 'SFMono-Regular', Consolas, Menlo, monospace;
  letter-spacing: 0.25em;
  text-align: center;
}

.disable-form {
  margin-top: var(--sp-4);
}

/* 窄屏下恢复码改单列，免得两列挤成看不清 */
@media (max-width: 480px) {
  .totp-codes {
    grid-template-columns: 1fr;
  }
}

/* ---------------- 用户与角色（B5） ---------------- */
.role-note {
  margin-bottom: var(--sp-4);
}

.user-table {
  margin-bottom: var(--sp-4);
}

/* 表格比屏幕宽时自己滚，不要把整页带出横向滚动条
   （用 clip 会连带干掉 el-table 自己的滚动，所以这里只能是 auto） */
.user-table__wrap {
  overflow-x: auto;
}

/* 窄屏的用户卡片（替代表格） */
.u-cards {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  margin: 0 0 var(--sp-4);
  padding: 0;
  list-style: none;
}

.u-card {
  padding: var(--sp-3);
  border-radius: var(--r-md);
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
}

.u-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  margin-bottom: 4px;
}

.u-card__head strong {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-primary);
}

.u-card__meta {
  font-size: var(--fs-xs);
  line-height: 1.7;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.u-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}

/* 角色下拉里跟在名称后面的小字说明 */
.role-opt__hint {
  margin-left: var(--sp-2);
  color: var(--text-tertiary);
  font-size: var(--fs-xs);
}

/* 能力清单按用途分组，长表单里靠小标题分段，避免一坨纯文字 */
.tool-group + .tool-group {
  margin-top: var(--sp-4);
  padding-top: var(--sp-4);
  border-top: 1px solid var(--border-hairline);
}

.tool-group__title {
  margin-bottom: var(--sp-2);
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text-primary);
}

/* 接入说明原文比较长，用更浅的底并把高度限住，避免把页面撑得很长 */
.code-block--soft {
  max-height: 420px;
  overflow-y: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.tools {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.tools li {
  display: flex;
  gap: var(--sp-3);
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-secondary);
}

.tools code {
  flex: 0 0 150px;
  color: var(--brand);
  font-family: 'SFMono-Regular', Consolas, Menlo, monospace;
  overflow-wrap: anywhere;
}

.token-box {
  margin-top: var(--sp-4);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-md);
  background: var(--bg-subtle);
  border: 1px dashed var(--brand-soft-border);
  color: var(--text-primary);
  font-size: var(--fs-sm);
  word-break: break-all;
  user-select: all;
}

/* ---------------- 外观 ---------------- */
.appearance {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
  padding: var(--sp-5);
}

.appearance__row {
  display: flex;
  align-items: center;
  gap: var(--sp-5);
  flex-wrap: wrap;
}

.appearance__label {
  flex: 0 0 64px;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

/* 主题色选择：色点 + 名称，选中态用外圈 + 勾号双重表达
   （只靠颜色区分对色觉障碍不友好，所以必须有勾号这一层） */
.swatches {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2) var(--sp-4);
}

.swatch {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 6px 10px 6px 6px;
  border: 1px solid transparent;
  border-radius: var(--r-full);
  background: transparent;
  font: inherit;
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease);
}

.swatch:hover {
  background: var(--bg-hover);
}

.swatch.is-active {
  border-color: var(--brand-soft-border);
  background: var(--brand-soft);
}

.swatch:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 1px;
}

.swatch__dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex: 0 0 22px;
  border-radius: var(--r-full);
  box-shadow: 0 0 0 1px var(--border-hairline);
  color: #fdfefe;
  font-size: 12px;
}

.swatch__name {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

.swatch.is-active .swatch__name {
  color: var(--brand);
  font-weight: 500;
}

/* 明暗模式：与仪表盘的范围切换用同一套分段控件语言 */
.mode-switch {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--border-hairline);
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
}

.mode-switch__btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border: 0;
  border-radius: calc(var(--r-sm) - 2px);
  background: transparent;
  font: inherit;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.mode-switch__btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.mode-switch__btn.is-active {
  background: var(--bg-surface);
  color: var(--brand);
  font-weight: 500;
  box-shadow: var(--shadow-sm);
}

.mode-switch__btn:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 1px;
}

/* ---------------- 运行环境 ---------------- */
.runtime {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 1px;
  background: var(--border-hairline);
}

.runtime__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--sp-4) var(--sp-5);
  background: var(--bg-surface);
}

.runtime__k {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}

.runtime__v {
  font-size: var(--fs-sm);
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

@media (max-width: 768px) {
  .form-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .span-2 {
    grid-column: span 1;
  }

  .section__head,
  .section__body {
    padding-left: var(--sp-4);
    padding-right: var(--sp-4);
  }

  .runtime__item {
    padding: var(--sp-3) var(--sp-4);
  }

  /* 外观选择器在手机上也要够高，手指点得准 */
  .swatch,
  .mode-switch__btn {
    min-height: 44px;
  }

  .appearance {
    padding: var(--sp-4);
  }

  .tools li {
    flex-direction: column;
    gap: 2px;
  }

  .tools code {
    flex: none;
  }
}
</style>
