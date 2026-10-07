/**
 * 路由表
 * ------------------------------------------------------------------
 * 采用 hash 模式：宝塔 Nginx 反代时即使漏配 rewrite 也不会 404，
 * 部署最省心（登录失效后跳转也走 hash，见 api/request.js）。
 */
import { createRouter, createWebHashHistory } from 'vue-router';
import { getToken } from '@/api/request';

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
        path: 'settings',
        name: 'settings',
        component: () => import('@/views/Settings.vue'),
        meta: { title: '系统设置', subtitle: '面板对接、MCP 连接、管理员账号', icon: 'Setting' },
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

/** 全局前置守卫：未登录一律回登录页 */
router.beforeEach((to) => {
  document.title = to.meta?.title ? `${to.meta.title} · 艾哥SaaS工作台` : '艾哥SaaS工作台';

  if (to.meta?.public) return true;

  if (!getToken()) {
    return { path: '/login', query: { redirect: to.fullPath } };
  }
  return true;
});

export default router;
