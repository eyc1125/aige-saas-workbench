/**
 * 路由表
 * ------------------------------------------------------------------
 * 采用 hash 模式：宝塔 Nginx 反代时即使漏配 rewrite 也不会 404，
 * 部署最省心（登录失效后跳转也走 hash，见 api/request.js）。
 *
 * 权限（B5）：`meta.adminOnly` 的页面只有管理员能进。
 * ⚠️ 这只是「别让他白跑一趟」，真正的拦截在后端（后端对非管理员直接 403）。
 */
import { createRouter, createWebHashHistory } from 'vue-router';
import { ElMessage } from 'element-plus/es/components/message/index';
import { getToken } from '@/api/request';
import { useAuthStore } from '@/stores/auth';

const routes = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/Login.vue'),
    meta: { title: '登录', public: true },
  },
  {
    path: '/',
    component: () => import('@/layouts/MainLayout.vue'),
    redirect: '/dashboard',
    children: [
      {
        path: 'dashboard',
        name: 'dashboard',
        component: () => import('@/views/Dashboard.vue'),
        meta: { title: '仪表盘', subtitle: '服务器实时状态与整体概览', icon: 'Odometer' },
      },
      {
        path: 'websites',
        name: 'websites',
        component: () => import('@/views/Websites.vue'),
        meta: { title: '网站管理', subtitle: '宝塔站点：创建、删除、申请证书', icon: 'Monitor' },
      },
      {
        path: 'certificates',
        name: 'certificates',
        component: () => import('@/views/Certificates.vue'),
        meta: {
          title: '证书与安全',
          subtitle: 'SSL 证书到期倒计时、续签与站点日志',
          icon: 'Medal',
        },
      },
      {
        path: 'inspect',
        name: 'inspect',
        component: () => import('@/views/Inspect.vue'),
        meta: {
          title: '健康巡检',
          subtitle: '自动体检与低风险自愈（含熔断保护）',
          icon: 'FirstAidKit',
        },
      },
      {
        path: 'domains',
        name: 'domains',
        component: () => import('@/views/Domains.vue'),
        meta: { title: '域名管理', subtitle: 'Cloudflare 区域与 DNS 解析', icon: 'Connection' },
      },
      {
        path: 'docker',
        name: 'docker',
        component: () => import('@/views/Docker.vue'),
        meta: { title: 'Docker 管理', subtitle: '容器与镜像的启停、日志、清理', icon: 'Box' },
      },
      {
        path: 'apps',
        name: 'apps',
        component: () => import('@/views/AppStore.vue'),
        meta: { title: '应用商店', subtitle: '一键部署应用并自动配好域名与 HTTPS', icon: 'Grid' },
      },
      {
        path: 'repos',
        name: 'repos',
        component: () => import('@/views/Repo.vue'),
        meta: {
          title: '代码仓库',
          subtitle: '提交、Actions 与 Issue，不用跳浏览器',
          icon: 'FolderOpened',
        },
      },
      {
        path: 'distribute',
        name: 'distribute',
        component: () => import('@/views/Distribute.vue'),
        meta: {
          title: '应用分发',
          subtitle: '内测包版本、下载页与二维码',
          icon: 'Cellphone',
        },
      },
      {
        path: 'crontab',
        name: 'crontab',
        component: () => import('@/views/Crontab.vue'),
        meta: {
          title: '计划任务',
          subtitle: '服务器上的定时任务（只读）',
          icon: 'Timer',
        },
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('@/views/Settings.vue'),
        meta: {
          title: '系统设置',
          subtitle: '面板对接、MCP 连接、用户与账号',
          icon: 'Setting',
          // 里面有宝塔密钥 / Cloudflare Token / MCP 令牌 / 用户管理，只给管理员
          adminOnly: true,
        },
      },
    ],
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFound.vue'),
    meta: { title: '页面不存在', public: true },
  },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

/** 全局前置守卫：未登录一律回登录页；仅管理员的页面再做一次角色判断 */
router.beforeEach(async (to) => {
  document.title = to.meta?.title ? `${to.meta.title} · 艾哥SaaS工作台` : '艾哥SaaS工作台';

  if (to.meta?.public) return true;

  if (!getToken()) {
    return { path: '/login', query: { redirect: to.fullPath } };
  }

  if (to.meta?.adminOnly) {
    const auth = useAuthStore();
    // 刷新页面时 store 里还没有用户信息，先补一次再判角色 ——
    // 否则管理员刷新一下就被自己的守卫踢走了
    if (!auth.user) await auth.fetchProfile();
    if (!auth.isAdmin) {
      ElMessage.warning('该页面仅管理员可访问');
      return { path: '/dashboard' };
    }
  }

  return true;
});

export default router;
