<template>
  <div class="page">
    <!-- ==================== 工具条 ==================== -->
    <section class="surface toolbar">
      <div class="toolbar__left">
        <el-icon class="toolbar__icon"><Cellphone /></el-icon>
        <span class="toolbar__name">蒲公英内测分发</span>
        <span v-if="summary" class="toolbar__meta">
          {{ summary.totalApps }} 个应用 · {{ summary.totalBuilds }} 个版本
        </span>
      </div>
      <div class="toolbar__right">
        <span v-if="lastLoadedAt" class="muted-xs">
          {{ relTime(lastLoadedAt) }}刷新 · 数据缓存 {{ config.cacheTtlSeconds || 60 }} 秒
        </span>
        <el-button :loading="loading" @click="loadAll">
          <el-icon><Refresh /></el-icon>刷新
        </el-button>
      </div>
    </section>

    <!-- ==================== 上传路径说明（只读页，说清去哪儿传） ==================== -->
    <section v-if="state === 'ready'" class="surface notice">
      <el-icon class="notice__icon"><WarningFilled /></el-icon>
      <div class="notice__body">
        <p class="notice__title">这一页是只读的：看版本、取下载页与二维码</p>
        <p class="notice__desc">
          <strong>上传安装包</strong>请用蒲公英官方工具链（它跑在你本机，能直接读本地 APK）：<br />
          官方 MCP：<code>npx -y pgyer-mcp-server</code> + 环境变量 <code>PGYER_API_KEY</code>；
          官方 CLI：<code>npm i -g @pgyer/cli</code> 后 <code>pgyer upload ./app-release.apk</code>
        </p>
      </div>
    </section>

    <!-- ==================== 状态 ==================== -->
    <section v-if="state === 'loading'" class="surface">
      <StateBlock state="loading" loading-text="正在读取蒲公英上的应用…" />
    </section>

    <section v-else-if="state === 'error'" class="surface">
      <StateBlock
        state="error"
        title="读取失败"
        :description="errorMsg"
        action-text="重试"
        @action="loadAll"
      />
    </section>

    <section v-else-if="state === 'unconfigured'" class="surface">
      <StateBlock
        state="empty"
        title="还没配置蒲公英"
        description="到「系统设置 → 应用分发」填写蒲公英 API Key（在蒲公英后台 → 账户菜单 → API 信息 里获取），填完回到这里就能看到应用与版本。"
        :action-text="auth.isAdmin ? '去系统设置' : ''"
        @action="goSettings"
      />
    </section>

    <section v-else-if="state === 'empty'" class="surface">
      <div class="blank">
        <span class="blank__glyph"
          ><el-icon><Cellphone /></el-icon
        ></span>
        <p class="blank__title">蒲公英账号下还没有安装包</p>
        <p class="blank__desc">
          在当前电脑上装一次官方 CLI 就能传（它会自己打开安卓工程的构建产物目录）：
        </p>
        <pre class="blank__code">
npm i -g @pgyer/cli
pgyer auth login
pgyer upload ./app-release.apk</pre>
        <p class="blank__desc">
          或者让 AI 助手代劳 —— 配好蒲公英官方 MCP 后，直接说「把 xxx.apk 传上去」即可。
        </p>
      </div>
    </section>

    <!-- ==================== 应用列表 ==================== -->
    <div v-else-if="state === 'ready'" class="apps">
      <article v-for="app in apps" :key="app.appKey" class="surface app">
        <div class="app__id">
          <img v-if="app.icon" class="app__icon" :src="app.icon" :alt="app.name" loading="lazy" />
          <span v-else class="app__icon app__icon--ph">{{ (app.name || '?').slice(0, 1) }}</span>
          <div class="app__names">
            <h3 class="app__name">{{ app.name }}</h3>
            <p class="app__ident mono">{{ app.latest.identifier || '未知包名' }}</p>
          </div>
        </div>

        <dl class="app__facts">
          <div>
            <dt>当前版本</dt>
            <dd>
              <strong>{{ app.latest.version }}</strong>
              <span class="app__vno">({{ app.latest.versionNo }})</span>
            </dd>
          </div>
          <div>
            <dt>体积</dt>
            <dd>{{ bytesText(app.latest.fileSize) }}</dd>
          </div>
          <div>
            <dt>上传于</dt>
            <dd>{{ relTime(app.latest.createdAt) }}</dd>
          </div>
          <div>
            <dt>历史版本</dt>
            <dd>{{ app.versionCount }} 个</dd>
          </div>
        </dl>

        <div class="app__qr">
          <img
            v-if="app.latest.qrCodeUrl && !brokenQr[app.appKey]"
            class="app__qr-img"
            :src="app.latest.qrCodeUrl"
            :alt="`${app.name} 二维码`"
            loading="lazy"
            @error="brokenQr[app.appKey] = true"
          />
          <span v-else class="app__qr-fallback">二维码暂不可用</span>
          <span class="app__qr-hint">扫码安装</span>
        </div>

        <div class="app__actions">
          <a
            v-if="app.latest.downloadPage"
            class="app__link"
            :href="app.latest.downloadPage"
            target="_blank"
            rel="noopener"
          >
            下载页<el-icon><Link /></el-icon>
          </a>
          <span v-else class="muted-xs">下载页地址未取到</span>
          <el-button
            v-if="app.latest.downloadPage"
            text
            @click="copyDownloadPage(app.latest.downloadPage)"
          >
            <el-icon><DocumentCopy /></el-icon>复制
          </el-button>
        </div>

        <p v-if="app.latest.updateDescription" class="app__changelog">
          更新说明：{{ app.latest.updateDescription }}
        </p>
      </article>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
// 深路径导入：不要改回 'element-plus'（barrel 入口会阻止 tree-shaking，详见 main.js）
import { ElMessage } from 'element-plus/es/components/message/index';
import StateBlock from '@/components/StateBlock.vue';
import { distributeApi } from '@/api';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();

// loading | error | unconfigured | empty | ready
const state = ref('loading');
const errorMsg = ref('');
const loading = ref(false);
const apps = ref([]);
const summary = ref(null);
const config = ref({ configured: false, cacheTtlSeconds: 60 });
const lastLoadedAt = ref(null);
/** 二维码图挂了就退回文字，别在页面上留一个破图 */
const brokenQr = reactive({});

function relTime(input) {
  if (!input) return '未知';
  // 蒲公英返回的是 `2025-01-01 10:00:00`，Safari 对空格分隔的日期解析不友好，换成 ISO 风格
  const normalized = typeof input === 'string' ? input.replace(' ', 'T') : input;
  const value = new Date(normalized).getTime();
  if (!Number.isFinite(value)) return String(input);
  const diffMin = Math.floor((Date.now() - value) / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const hours = Math.floor(diffMin / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return input.slice(0, 10);
}

function bytesText(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function copyDownloadPage(url) {
  try {
    await navigator.clipboard.writeText(url);
    ElMessage.success('下载页地址已复制');
  } catch {
    // 非 https 或用户拒绝授权时会走到这里，给个能用的退路
    ElMessage.warning(`复制失败，请手动复制：${url}`);
  }
}

function goSettings() {
  if (auth.isAdmin) window.location.hash = '#/settings';
}

async function loadAll() {
  loading.value = true;
  state.value = 'loading';
  try {
    config.value = await distributeApi.config();
    if (!config.value.configured) {
      state.value = 'unconfigured';
      return;
    }

    const data = await distributeApi.apps();
    apps.value = data.items || [];
    summary.value = data;
    lastLoadedAt.value = new Date();
    state.value = apps.value.length ? 'ready' : 'empty';
  } catch (err) {
    errorMsg.value = err.message || '未知错误';
    state.value = 'error';
  } finally {
    loading.value = false;
  }
}

onMounted(loadAll);
</script>

<style scoped>
/* ---------------- 工具条 ---------------- */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
  flex-wrap: wrap;
  padding: var(--sp-3) var(--sp-5);
}

.toolbar__left,
.toolbar__right {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-width: 0;
  flex-wrap: wrap;
}

.toolbar__icon {
  color: var(--brand);
}

.toolbar__name {
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text-primary);
}

.toolbar__meta {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}

/* ---------------- 只读说明条 ---------------- */
.notice {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: var(--sp-4) var(--sp-5);
  background: var(--info-soft);
  border-color: color-mix(in srgb, var(--info) 20%, transparent);
}

.notice__icon {
  margin-top: 2px;
  color: var(--info);
}

.notice__body {
  flex: 1;
  min-width: 0;
}

.notice__title {
  font-size: var(--fs-sm);
  font-weight: 500;
  color: var(--text-primary);
}

.notice__desc {
  margin-top: var(--sp-1);
  font-size: var(--fs-xs);
  line-height: 1.8;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.notice__desc code {
  padding: 1px 5px;
  border-radius: var(--r-xs);
  background: var(--bg-surface);
  border: 1px solid var(--border-hairline);
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 11px;
  color: var(--text-primary);
}

/* ---------------- 空账号 ---------------- */
.blank {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-7) var(--sp-5);
  text-align: center;
}

.blank__glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: var(--r-lg);
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
  font-size: 20px;
  color: var(--text-tertiary);
}

.blank__title {
  font-size: var(--fs-base);
  font-weight: 500;
  color: var(--text-primary);
}

.blank__desc {
  max-width: 520px;
  font-size: var(--fs-sm);
  line-height: 1.7;
  color: var(--text-secondary);
}

.blank__code {
  margin: var(--sp-2) 0;
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-md);
  background: #071a12;
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #cfe6da;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  line-height: 1.9;
  text-align: left;
  overflow-x: auto;
}

/* ---------------- 应用卡 ---------------- */
.apps {
  display: grid;
  /* 横向排布的行卡，不是「图标+标题+段落」的方块卡，免得一眼看到一排等大格子 */
  grid-template-columns: repeat(auto-fit, minmax(min(460px, 100%), 1fr));
  gap: var(--sp-4);
}

.app {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--sp-4) var(--sp-5);
  padding: var(--sp-5);
  align-items: start;
  transition: box-shadow var(--dur-card) var(--ease);
}

.app:hover {
  box-shadow: var(--shadow-lg);
}

.app__id {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-width: 0;
}

.app__icon {
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  border-radius: var(--r-md);
  object-fit: cover;
  background: var(--bg-subtle);
}

.app__icon--ph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
}

.app__names {
  min-width: 0;
}

.app__name {
  font-size: var(--fs-md);
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.app__ident {
  margin-top: 2px;
  color: var(--text-tertiary);
  overflow-wrap: anywhere;
}

.app__facts {
  grid-column: 1;
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-5);
  margin: 0;
}

.app__facts div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.app__facts dt {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}

.app__facts dd {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-primary);
}

.app__vno {
  margin-left: 4px;
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}

/* 二维码：竖着占右列，与左侧信息形成不对称结构 */
.app__qr {
  grid-row: 1 / span 2;
  grid-column: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.app__qr-img {
  width: 96px;
  height: 96px;
  border-radius: var(--r-md);
  border: 1px solid var(--border-hairline);
  background: var(--bg-surface);
  object-fit: contain;
}

.app__qr-fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 96px;
  height: 96px;
  padding: var(--sp-2);
  border-radius: var(--r-md);
  border: 1px dashed var(--border-hairline);
  background: var(--bg-subtle);
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  text-align: center;
}

.app__qr-hint {
  font-size: 11px;
  color: var(--text-tertiary);
}

.app__actions {
  grid-column: 1;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}

.app__link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  /* 手机上文字链也要够点：44px 是项目统一的地板 */
  min-height: 44px;
  padding: 0 var(--sp-3);
  margin-left: calc(var(--sp-3) * -1);
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
  color: var(--brand);
  transition:
    color var(--dur-fast) var(--ease),
    background-color var(--dur-fast) var(--ease);
}

.app__link:hover {
  background: var(--brand-soft);
}

.app__changelog {
  grid-column: 1 / -1;
  padding-top: var(--sp-3);
  border-top: 1px dashed var(--border-hairline);
  font-size: var(--fs-xs);
  line-height: 1.7;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

@media (max-width: 768px) {
  .toolbar,
  .notice,
  .app {
    padding-left: var(--sp-4);
    padding-right: var(--sp-4);
  }

  /* 窄屏把二维码从右列拿下来，免得把左侧信息挤成一条缝 */
  .app {
    grid-template-columns: minmax(0, 1fr);
  }

  .app__qr {
    grid-row: auto;
    grid-column: 1;
    flex-direction: row;
    align-items: center;
    gap: var(--sp-3);
  }
}
</style>
