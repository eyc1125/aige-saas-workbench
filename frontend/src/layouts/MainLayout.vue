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
    <el-drawer v-model="drawerOpen" direction="ltr" size="248px" :with-header="false" class="side-drawer">
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
          <button v-if="isMobile" class="topbar__icon-btn" type="button" aria-label="打开导航" @click="drawerOpen = true">
            <el-icon><Menu /></el-icon>
          </button>
          <div class="topbar__titles">
            <h1 class="topbar__title">{{ route.meta?.title || '工作台' }}</h1>
            <p v-if="route.meta?.subtitle" class="topbar__subtitle">{{ route.meta.subtitle }}</p>
          </div>
        </div>

        <div class="topbar__right">
          <!-- 配置未完成时给出常驻轻提示，点一下直达设置页 -->
          <button v-if="missingConfig.length" class="chip chip--warn" type="button" @click="router.push('/settings')">
            <el-icon><WarningFilled /></el-icon>
            <span class="chip__text">{{ missingConfig.length }} 项对接待配置</span>
          </button>

          <button class="topbar__icon-btn" type="button" :aria-label="theme.isDark ? '切换到浅色' : '切换到深色'" @click="theme.toggle()">
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
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
// 深路径导入：不要改回 'element-plus'（barrel 入口会阻止 tree-shaking，详见 main.js）
import { ElMessageBox } from 'element-plus/es/components/message-box/index';
import BrandMark from '@/components/BrandMark.vue';
import { useAuthStore } from '@/stores/auth';
import { useThemeStore } from '@/stores/theme';
import { settingApi } from '@/api';

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

onMounted(async () => {
  theme.init();
  window.addEventListener('resize', onResize);
  if (!auth.user) await auth.fetchProfile();
  loadConfigStatus();
});

onBeforeUnmount(() => window.removeEventListener('resize', onResize));
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
  transition: background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
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
  transition: background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
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
}

.topbar__title {
  font-size: var(--fs-lg);
  font-weight: 600;
  letter-spacing: -0.015em;
  line-height: 1.2;
  color: var(--text-primary);
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
  transition: background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease),
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
</style>

<style>
/* 抽屉内的导航需要非 scoped 样式覆盖（内容由 el-drawer 挂到 body 上） */
.side-drawer .el-drawer__body {
  padding: var(--sp-4) var(--sp-3);
}
</style>
