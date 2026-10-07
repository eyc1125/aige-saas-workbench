/**
 * 主题 store（浅色 / 深色）
 * ------------------------------------------------------------------
 * 通过给 <html> 加 dark 类切换（Element Plus 深色模式依赖同一个类）。
 * index.html 里已有一段内联脚本读取同一个 localStorage key，避免首屏闪烁。
 */
import { defineStore } from 'pinia';

const STORAGE_KEY = 'aige-theme';

/** 读取初始主题：本地存过就用本地的，否则跟随系统 */
function resolveInitialTheme() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export const useThemeStore = defineStore('theme', {
  state: () => ({
    theme: resolveInitialTheme(),
  }),

  getters: {
    isDark: (state) => state.theme === 'dark',
  },

  actions: {
    /** 应用到 DOM */
    apply() {
      document.documentElement.classList.toggle('dark', this.theme === 'dark');
      localStorage.setItem(STORAGE_KEY, this.theme);
    },

    toggle() {
      this.theme = this.theme === 'dark' ? 'light' : 'dark';
      this.apply();
    },

    /** 供应用启动时调用一次，保证 DOM 与 store 一致 */
    init() {
      this.apply();
    },
  },
});
