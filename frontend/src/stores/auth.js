/**
 * 登录态 store
 * ------------------------------------------------------------------
 * 令牌存 localStorage（刷新不丢），用户信息缓存在内存里，
 * 刷新页面后由 fetchProfile 重新拉一次以保证权限最新。
 *
 * ⚠️ 权限（B5）：这里算出来的 isAdmin / canWrite **只用于决定「显不显示」**，
 *    不是安全边界 —— 后端每个接口都会按角色再拦一次（middleware/permissions.js）。
 *    前端隐藏按钮是为了让人少踩"点了才报错"的坑，而不是为了防人。
 */
import { defineStore } from 'pinia';
import { authApi } from '@/api';
import { getToken, setToken, clearToken } from '@/api/request';

/** 角色中文名（与后端 ROLE_TEXT 保持一致） */
const ROLE_TEXT = { viewer: '只读', operator: '运维', admin: '管理员' };

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: getToken(),
    user: null,
    loading: false,
  }),

  getters: {
    isLoggedIn: (state) => !!state.token,
    displayName: (state) => state.user?.nickname || state.user?.username || '未登录',
    role: (state) => state.user?.role || '',
    roleText: (state) => ROLE_TEXT[state.user?.role] || state.user?.role || '-',
    /** 管理员：能进「系统设置」，能管用户 */
    isAdmin: (state) => state.user?.role === 'admin',
    /** 运维及以上：能执行各种写操作 */
    canWrite: (state) => ['operator', 'admin'].includes(state.user?.role),
    /** 只读：界面上要给出「为什么按钮都不见了」的说明 */
    isViewer: (state) => state.user?.role === 'viewer',
  },

  actions: {
    /** 登录：成功后写入令牌并拉取用户信息 */
    async login(username, password) {
      this.loading = true;
      try {
        const data = await authApi.login({ username, password });
        this.token = data.token;
        this.user = data.user;
        setToken(data.token);
        return data;
      } finally {
        this.loading = false;
      }
    },

    /** 拉取当前用户信息（页面刷新后调用） */
    async fetchProfile() {
      if (!this.token) return null;
      try {
        this.user = await authApi.profile();
        return this.user;
      } catch {
        // 令牌失效时拦截器已处理跳转，这里只需清本地状态
        this.reset();
        return null;
      }
    },

    /** 退出登录 */
    async logout() {
      try {
        await authApi.logout();
      } catch {
        /* 退出接口失败不影响本地清理 */
      }
      this.reset();
    },

    reset() {
      this.token = '';
      this.user = null;
      clearToken();
    },
  },
});
