<template>
  <div class="shell">
    <!-- ==================== 侧边导航（桌面） ==================== -->
    <aside v-if="!isMobile" class="side" :class="{ 'side--collapsed': collapsed }">
      <div class="side__brand">
        <BrandMark :size="34" />
        <span v-if="!collapsed" class="side__brand-text">
          <strong>SaaS 工作台</strong>
          <em>服务器统一管控</em>
        </span>
      </div>

      <nav class="nav" aria-label="主导航">
        <router-link
          v-for="item in navItems"
          :key="item.path"
          :to="item.path"
          class="nav__item"
          :class="{ 'nav__item--active': isActive(item.path) }"
          :title="collapsed ? item.title : ''"
        >
          <el-icon class="nav__icon"><component :is="item.icon" /></el-icon>
          <span v-if="!collapsed" class="nav__text">{{ item.title }}</span>
        </router-link>
      </nav>

      <div class="side__foot">
        <button class="side__collapse" type="button" @click="toggleCollapse">
          <el-icon><component :is="collapsed ? 'Expand' : 'Fold'" /></el-icon>
          <span v-if="!collapsed">收起导航</span>
        </button>
      </div>
    </aside>

    <!-- ==================== 侧边导航（移动端抽屉） ==================== -->
    <el-drawer
      v-model="drawerOpen"
      direction="ltr"
      size="248px"
      :with-header="false"
      class="side-drawer"
    >
      <div class="side__brand side__brand--drawer">
        <BrandMark :size="34" />
        <span class="side__brand-text">
          <strong>SaaS 工作台</strong>
          <em>服务器统一管控</em>
        </span>
      </div>
      <nav class="nav" aria-label="主导航">
        <router-link
          v-for="item in navItems"
          :key="item.path"
          :to="item.path"
          class="nav__item"
          :class="{ 'nav__item--active': isActive(item.path) }"
          @click="drawerOpen = false"
        >
          <el-icon class="nav__icon"><component :is="item.icon" /></el-icon>
          <span class="nav__text">{{ item.title }}</span>
        </router-link>
      </nav>
    </el-drawer>

    <!-- ==================== 主区 ==================== -->
    <div class="main">
      <header class="topbar">
        <div class="topbar__left">
          <button
            v-if="isMobile"
            class="topbar__icon-btn"
            type="button"
            aria-label="打开导航"
            @click="drawerOpen = true"
          >
            <el-icon><Menu /></el-icon>
          </button>
          <div class="topbar__titles">
            <h1 class="topbar__title">{{ route.meta?.title || '工作台' }}</h1>
            <p v-if="route.meta?.subtitle" class="topbar__subtitle">{{ route.meta.subtitle }}</p>
          </div>
        </div>

        <div class="topbar__right">
          <!-- 配置未完成时给出常驻轻提示，点一下直达设置页 -->
          <button
            v-if="missingConfig.length"
            class="chip chip--warn"
            type="button"
            @click="router.push('/settings')"
          >
            <el-icon><WarningFilled /></el-icon>
            <span class="chip__text">{{ missingConfig.length }} 项对接待配置</span>
          </button>

          <!-- 告警铃铛：有未读时亮红点并显示数量 -->
          <button
            class="topbar__icon-btn bell"
            :class="{
              'bell--alert': alertSummary.unread > 0,
              'bell--critical': alertSummary.level === 'critical',
            }"
            type="button"
            :aria-label="alertSummary.unread ? `${alertSummary.unread} 条未读告警` : '告警中心'"
            @click="openAlerts"
          >
            <el-icon><Bell /></el-icon>
            <span v-if="alertSummary.unread" class="bell__badge tnum">
              {{ alertSummary.unread > 99 ? '99+' : alertSummary.unread }}
            </span>
          </button>

          <button
            class="topbar__icon-btn"
            type="button"
            :aria-label="theme.isDark ? '切换到浅色' : '切换到深色'"
            @click="theme.toggle()"
          >
            <el-icon><component :is="theme.isDark ? 'Sunny' : 'Moon'" /></el-icon>
          </button>

          <el-dropdown trigger="click" @command="onUserCommand">
            <button class="user" type="button">
              <span class="user__avatar">{{ (auth.displayName || 'A').slice(0, 1) }}</span>
              <span class="user__meta">
                <strong>{{ auth.displayName }}</strong>
                <em>{{ auth.roleText }}</em>
              </span>
              <el-icon class="user__caret"><ArrowDown /></el-icon>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="settings">
                  <el-icon><Setting /></el-icon>系统设置
                </el-dropdown-item>
                <el-dropdown-item command="logout" divided>
                  <el-icon><SwitchButton /></el-icon>退出登录
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>

      <main class="content">
        <router-view />
      </main>
    </div>

    <!-- ==================== 告警中心抽屉 ==================== -->
    <el-drawer v-model="alertDrawer" title="告警中心" size="440px" @opened="loadAlerts">
      <div class="alerts">
        <header class="alerts__head">
          <span class="alerts__stat tnum">
            未解决 <strong>{{ alertSummary.total }}</strong> 条
            <template v-if="alertSummary.critical"
              >· 紧急 <strong>{{ alertSummary.critical }}</strong></template
            >
            <template v-if="alertSummary.warning">· 警告 {{ alertSummary.warning }}</template>
          </span>
          <el-button v-if="alertSummary.unread" link type="primary" @click="markAllRead"
            >全部已读</el-button
          >
        </header>

        <p class="alerts__channels">
          外部通道：{{ channelText }}（在「系统设置 → 告警通知」里配置）
        </p>

        <StateBlock v-if="alertLoading" state="loading" loading-text="正在读取告警…" />
        <StateBlock
          v-else-if="!alertItems.length"
          state="empty"
          title="没有未解决的告警"
          description="巡检异常、部署失败、自愈失败都会出现在这里；问题消失后会自动关闭。"
        />
        <ul v-else class="alert-list">
          <li
            v-for="a in alertItems"
            :key="a.id"
            class="alert-item"
            :class="`alert-item--${a.level}`"
          >
            <div class="alert-item__top">
              <span class="alert-item__dot" aria-hidden="true" />
              <strong class="alert-item__title">{{ a.title }}</strong>
              <span
                v-if="a.occurrences > 1"
                class="alert-item__times tnum"
                :title="`累计出现 ${a.occurrences} 次`"
              >
                ×{{ a.occurrences }}
              </span>
            </div>
            <pre v-if="a.detail" class="alert-item__detail">{{ a.detail }}</pre>
            <div class="alert-item__foot">
              <span class="alert-item__meta">{{ sourceText(a.source) }} · {{ a.updated_at }}</span>
              <el-button link type="primary" @click="resolveAlert(a)">标记解决</el-button>
            </div>
          </li>
        </ul>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
// 深路径导入：不要改回 'element-plus'（barrel 入口会阻止 tree-shaking，详见 main.js）
import { ElMessage } from 'element-plus/es/components/message/index';
import { ElMessageBox } from 'element-plus/es/components/message-box/index';
import BrandMark from '@/components/BrandMark.vue';
import StateBlock from '@/components/StateBlock.vue';
import { useAuthStore } from '@/stores/auth';
import { useThemeStore } from '@/stores/theme';
import { settingApi, alertApi } from '@/api';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const theme = useThemeStore();

const navItems = [
  { path: '/dashboard', title: '仪表盘', icon: 'Odometer' },
  { path: '/websites', title: '网站管理', icon: 'Monitor' },
  { path: '/certificates', title: '证书与安全', icon: 'Medal' },
  { path: '/inspect', title: '健康巡检', icon: 'FirstAidKit' },
  { path: '/domains', title: '域名管理', icon: 'Connection' },
  { path: '/docker', title: 'Docker 管理', icon: 'Box' },
  { path: '/apps', title: '应用商店', icon: 'Grid' },
  { path: '/settings', title: '系统设置', icon: 'Setting' },
];

const COLLAPSE_KEY = 'aige-sidebar-collapsed';
const collapsed = ref(localStorage.getItem(COLLAPSE_KEY) === '1');
const drawerOpen = ref(false);
const isMobile = ref(window.innerWidth < 900);
const missingConfig = ref([]);

const isActive = (path) => route.path === path || route.path.startsWith(`${path}/`);

function toggleCollapse() {
  collapsed.value = !collapsed.value;
  localStorage.setItem(COLLAPSE_KEY, collapsed.value ? '1' : '0');
}

function onResize() {
  isMobile.value = window.innerWidth < 900;
  if (!isMobile.value) drawerOpen.value = false;
}

async function onUserCommand(command) {
  if (command === 'settings') {
    router.push('/settings');
    return;
  }
  if (command === 'logout') {
    await ElMessageBox.confirm('确定要退出登录吗？', '退出确认', {
      confirmButtonText: '退出',
      cancelButtonText: '取消',
      type: 'warning',
    });
    await auth.logout();
    router.push('/login');
  }
}

/** 检查哪些对接还没配置，用于顶部提示 */
async function loadConfigStatus() {
  try {
    const data = await settingApi.get();
    const list = [];
    if (!data.settings?.bt_api_key?.hasValue) list.push('宝塔面板');
    if (!data.settings?.cf_api_token?.hasValue) list.push('Cloudflare');
    if (!data.settings?.docker_host?.hasValue) list.push('Docker');
    missingConfig.value = list;
  } catch {
    // 设置接口失败不影响主界面使用
    missingConfig.value = [];
  }
}

// ============================================================
// 告警中心
// ------------------------------------------------------------------
// 顶栏只轮询「汇总」（一个 COUNT 查询，很轻），列表在打开抽屉时才拉 ——
// 避免为了一个红点把整张告警表每 60 秒查一遍。
// ============================================================
const alertSummary = ref({ total: 0, critical: 0, warning: 0, info: 0, unread: 0, level: 'ok' });
const alertItems = ref([]);
const alertChannels = ref({ webhook: { enabled: false }, feishu: { enabled: false } });
const alertDrawer = ref(false);
const alertLoading = ref(false);
let alertTimer = null;

const SOURCE_TEXT = { health: '巡检', deploy: '部署', auth: '登录', system: '系统' };
const sourceText = (s) => SOURCE_TEXT[s] || s || '系统';

const channelText = computed(() => {
  const on = [];
  if (alertChannels.value.webhook?.enabled) on.push('Webhook 已配');
  if (alertChannels.value.feishu?.enabled) {
    // 带上签名状态：这是排查「推送失败」时第一个要看的信息
    on.push(alertChannels.value.feishu.signed ? '飞书已配（含签名）' : '飞书已配');
  }
  if (alertChannels.value.wecom?.enabled) on.push('企业微信已配');
  return on.length ? on.join('、') : '仅站内（未配外部通道）';
});

async function loadAlertSummary() {
  try {
    alertSummary.value = await alertApi.summary();
  } catch {
    // 轮询失败静默：顶栏红点不该因为一次网络抖动就清空
  }
}

/**
 * 巡检类操作用广播通知顶栏立刻刷新红点
 * 背景：顶栏是 60 秒轮询一次汇总的，如果不广播，用户刚跑完巡检、
 *      告警已经产生了，铃铛却要等最多一分钟才变红 —— 体感像"没生效"。
 * 用 window 事件而不是 Pinia：这里只有一个订阅方，不值得为此引入一个 store。
 */
const ALERTS_CHANGED_EVENT = 'aige:alerts-changed';
const onAlertsChanged = () => loadAlertSummary();

async function loadAlerts() {
  alertLoading.value = true;
  try {
    const data = await alertApi.list({ status: 'open', limit: 100 });
    alertItems.value = data.items || [];
    alertSummary.value = data.summary || alertSummary.value;
    alertChannels.value = data.channels || alertChannels.value;
  } catch {
    alertItems.value = [];
  } finally {
    alertLoading.value = false;
  }
}

async function openAlerts() {
  alertDrawer.value = true;
  // 打开即已读（红点消失），但告警本身仍在列表里，不会因为"看过"就被清掉
  if (alertSummary.value.unread > 0) {
    try {
      await alertApi.readAll();
      alertSummary.value = { ...alertSummary.value, unread: 0 };
    } catch {
      /* 静默 */
    }
  }
}

async function markAllRead() {
  try {
    await alertApi.readAll();
    alertSummary.value = { ...alertSummary.value, unread: 0 };
  } catch {
    /* 静默 */
  }
}

async function resolveAlert(a) {
  try {
    await ElMessageBox.confirm(
      '标记为已解决只是把它从列表里移除。如果问题真的还在，下一次巡检会重新报出来。',
      '标记解决',
      { confirmButtonText: '确认', cancelButtonText: '取消', type: 'warning' }
    );
  } catch {
    return;
  }
  try {
    await alertApi.resolve(a.id);
    ElMessage.success('已标记为已解决');
    await loadAlerts();
  } catch {
    /* 拦截器已提示 */
  }
}

onMounted(async () => {
  theme.init();
  window.addEventListener('resize', onResize);
  if (!auth.user) await auth.fetchProfile();
  loadConfigStatus();

  // 告警红点：60 秒轮询一次汇总（很轻），不拉列表
  loadAlertSummary();
  alertTimer = setInterval(loadAlertSummary, 60000);
  window.addEventListener(ALERTS_CHANGED_EVENT, onAlertsChanged);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  window.removeEventListener(ALERTS_CHANGED_EVENT, onAlertsChanged);
  if (alertTimer) clearInterval(alertTimer);
});
</script>

<style scoped>
.shell {
  display: flex;
  min-height: 100vh;
  min-height: 100dvh;
  background: var(--bg-page);
}

/* ==================== 侧边栏 ==================== */
.side {
  position: sticky;
  top: 0;
  z-index: var(--z-nav);
  display: flex;
  flex-direction: column;
  width: var(--sidebar-w);
  height: 100vh;
  height: 100dvh;
  flex: 0 0 auto;
  padding: var(--sp-4) var(--sp-3);
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border-hairline);
  transition: width var(--dur-card) var(--ease);
}

.side--collapsed {
  width: var(--sidebar-w-collapsed);
}

.side__brand {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-2) var(--sp-5);
}

.side__brand--drawer {
  padding-bottom: var(--sp-4);
}

.side__brand-text {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  white-space: nowrap;
}

.side__brand-text strong {
  font-size: var(--fs-base);
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text-primary);
}

.side__brand-text em {
  font-size: var(--fs-xs);
  font-style: normal;
  color: var(--text-tertiary);
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  overflow-y: auto;
}

.nav__item {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  height: 40px;
  padding: 0 var(--sp-3);
  border-radius: var(--r-md);
  color: var(--text-secondary);
  font-size: var(--fs-base);
  font-weight: 500;
  white-space: nowrap;
  transition:
    background-color var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.nav__item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.nav__item--active {
  background: var(--brand-soft);
  color: var(--brand);
  font-weight: 600;
  box-shadow: inset 0 0 0 1px var(--brand-soft-border);
}

.nav__icon {
  font-size: 16px;
  flex: 0 0 16px;
}

.side--collapsed .nav__item {
  justify-content: center;
  padding: 0;
}

.side__foot {
  padding-top: var(--sp-3);
  margin-top: var(--sp-3);
  border-top: 1px solid var(--border-hairline);
}

.side__collapse {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  height: 34px;
  padding: 0 var(--sp-3);
  border: none;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--text-tertiary);
  font-size: var(--fs-sm);
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.side__collapse:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.side--collapsed .side__collapse {
  justify-content: center;
  padding: 0;
}

/* ==================== 主区 ==================== */
.main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0; /* 关键：防止内部表格把整个布局撑宽 */
}

.topbar {
  position: sticky;
  top: 0;
  z-index: var(--z-sticky);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
  height: var(--topbar-h);
  padding: 0 var(--sp-5);
  background: color-mix(in srgb, var(--bg-surface) 88%, transparent);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border-hairline);
}

.topbar__left,
.topbar__right {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-width: 0;
}

.topbar__titles {
  min-width: 0;
  /* 关键：h1 里的中文词组不能断行，会撑出 min-content 宽度把右侧控件顶出去，
     所以这里必须允许标题被裁切（裁剪只是兜底，正常宽度下不会触发）。 */
  overflow: hidden;
}

.topbar__title {
  font-size: var(--fs-lg);
  font-weight: 600;
  letter-spacing: -0.015em;
  line-height: 1.2;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.topbar__subtitle {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.topbar__icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  border: 1px solid var(--border-hairline);
  border-radius: var(--r-md);
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 16px;
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease);
}

.topbar__icon-btn:hover {
  background: var(--bg-hover);
  color: var(--brand);
  transform: translateY(-1px);
}

/* 顶部轻提示胶囊 */
.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  height: 32px;
  padding: 0 var(--sp-3);
  border-radius: var(--r-full);
  border: 1px solid transparent;
  font-size: var(--fs-xs);
  font-weight: 500;
  cursor: pointer;
  transition: filter var(--dur-fast) var(--ease);
}

.chip--warn {
  background: var(--warning-soft);
  color: var(--warning);
  border-color: color-mix(in srgb, var(--warning) 22%, transparent);
}

.chip:hover {
  filter: brightness(0.97);
}

/* 用户区 */
.user {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: 38px;
  padding: 0 var(--sp-2) 0 4px;
  border: 1px solid var(--border-hairline);
  border-radius: var(--r-full);
  background: var(--bg-surface);
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease);
}

.user:hover {
  background: var(--bg-hover);
}

.user__avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--brand-soft);
  color: var(--brand);
  font-size: var(--fs-sm);
  font-weight: 600;
}

.user__meta {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  line-height: 1.25;
}

.user__meta strong {
  font-size: var(--fs-sm);
  font-weight: 500;
  color: var(--text-primary);
}

.user__meta em {
  font-size: 11px;
  font-style: normal;
  color: var(--text-tertiary);
}

.user__caret {
  font-size: 12px;
  color: var(--text-tertiary);
}

.content {
  flex: 1;
  padding: var(--sp-5);
  min-width: 0;
}

/* ==================== 告警铃铛与抽屉 ==================== */
.bell {
  position: relative;
}

/* 有待处理告警时，铃铛本身变色（比只挂一个小红点更容易被注意到） */
.bell--alert {
  color: var(--warning);
  border-color: color-mix(in srgb, var(--warning) 30%, transparent);
}

.bell--critical {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 34%, transparent);
}

.bell__badge {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border-radius: var(--r-full);
  background: var(--danger);
  color: #fbf5f5;
  font-size: 10px;
  font-weight: 600;
  line-height: 17px;
  text-align: center;
  box-shadow: 0 0 0 2px var(--bg-surface);
}

.alerts__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding-bottom: var(--sp-3);
  border-bottom: 1px solid var(--border-hairline);
}

.alerts__stat {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

.alerts__stat strong {
  color: var(--text-primary);
}

.alerts__channels {
  margin: var(--sp-3) 0 var(--sp-4);
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-tertiary);
}

.alert-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 左侧 2px 严重度细线，与巡检页保持同一套视觉语言 */
.alert-item {
  padding: var(--sp-3) var(--sp-4);
  border: 1px solid var(--border-hairline);
  border-left: 2px solid var(--sev, var(--text-tertiary));
  border-radius: var(--r-md);
  background: var(--bg-surface);
}

.alert-item--critical {
  --sev: var(--danger);
}
.alert-item--warning {
  --sev: var(--warning);
}
.alert-item--info {
  --sev: var(--info);
}

.alert-item__top {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
}

.alert-item__dot {
  width: 7px;
  height: 7px;
  flex: 0 0 7px;
  margin-top: 6px;
  border-radius: 50%;
  background: var(--sev, var(--text-tertiary));
}

.alert-item__title {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-sm);
  font-weight: 600;
  line-height: 1.5;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.alert-item__times {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: var(--r-xs);
  background: var(--bg-subtle);
  font-size: 11px;
  line-height: 18px;
  color: var(--text-tertiary);
}

.alert-item__detail {
  margin: var(--sp-2) 0 0;
  padding: var(--sp-2) var(--sp-3);
  max-height: 160px;
  overflow-y: auto;
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  font-family: inherit;
  font-size: var(--fs-xs);
  line-height: 1.7;
  color: var(--text-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.alert-item__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}

.alert-item__meta {
  font-size: 11px;
  color: var(--text-tertiary);
}

/* ==================== 移动端 ==================== */
@media (max-width: 900px) {
  .topbar {
    padding: 0 var(--sp-4);
  }

  .content {
    padding: var(--sp-4) var(--sp-4) calc(var(--sp-6) + env(safe-area-inset-bottom));
  }

  .chip__text {
    display: none;
  }

  .user__meta {
    display: none;
  }

  .topbar__subtitle {
    display: none;
  }

  /* ---------- 顶部控件抬到 44px ----------
     汉堡菜单是手机上唯一的导航入口，主题切换与用户菜单也是主操作，
     原来 34px 在触屏上偏小、容易点空。只放大点击区，图标尺寸不变。 */
  .topbar__icon-btn {
    width: 44px;
    height: 44px;
    flex: 0 0 44px;
  }

  .chip {
    height: 44px;
    padding: 0 var(--sp-3);
  }

  .user {
    height: 44px;
    padding: 0 var(--sp-2) 0 5px;
  }

  .user__avatar {
    width: 34px;
    height: 34px;
  }

  /* 侧栏抽屉里的导航项也抬高，避免误触 */
  .side__collapse {
    height: 44px;
  }
}

/* ==================== 超窄屏（≤400px）====================
   320px 上顶栏要放「汉堡 + 铃铛 + 主题 + 用户菜单」四个控件，
   用默认间距会被挤出去 5–17px（实测由验收台抓到）。
   这里只收紧间距、去掉装饰性的下拉箭头 —— 压缩空隙，不减少功能。
   注意必须写在 scoped 块里：scoped 样式带 [data-v-*] 属性选择器，
   同选择器下特异性更高，写在非 scoped 块里会被盖掉。 */
@media (max-width: 400px) {
  .topbar {
    padding: 0 var(--sp-3);
  }

  .topbar__left,
  .topbar__right {
    gap: var(--sp-2);
  }

  .user {
    padding: 0 var(--sp-1) 0 3px;
  }

  .user__caret {
    display: none;
  }

  .topbar__title {
    font-size: var(--fs-md);
  }
}
</style>

<style>
/* 抽屉内的导航需要非 scoped 样式覆盖（内容由 el-drawer 挂到 body 上） */
.side-drawer .el-drawer__body {
  padding: var(--sp-4) var(--sp-3);
}
</style>
