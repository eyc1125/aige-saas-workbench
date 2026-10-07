/**
 * 登录态 store
 * ------------------------------------------------------------------
 * 令牌存 localStorage（刷新不丢），用户信息缓存在内存里，
 * 刷新页面后由 fetchProfile 重新拉一次以保证权限最新。
 */
import { defineStore } from 'pinia';
import { authApi } from '@/api';
import { getToken, setToken, clearToken } from '@/api/request';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: getToken(),
    user: null,
    loading: false,
  }),

  getters: {
    isLoggedIn: (state) => !!state.token,
    displayName: (state) => state.user?.nickname || state.user?.username || '未登录',
    roleText: (state) => (state.user?.role === 'admin' ? '超级管理员' : state.user?.role || '-'),
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
