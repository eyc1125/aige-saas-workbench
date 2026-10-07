/**
 * 主题 store（浅色 / 深色 + 主题色预设）
 * ------------------------------------------------------------------
 * 明暗：给 <html> 加 dark 类（Element Plus 深色模式依赖同一个类）。
 * 主题色：给 <html> 加 data-brand="<id>"，配色见 styles/palettes.css。
 * index.html 里有一段内联脚本读取同样两个 localStorage key，
 * 在框架加载前就把类名/属性打好，避免首屏闪一下默认色。
 *
 * ⚠️ 新增预设时三处要同步：
 *   1) styles/palettes.css 加 light + dark 两套令牌
 *   2) 下面 BRAND_PRESETS 加一项（swatch 颜色用于选择器）
 *   3) 不用改 index.html —— 它只负责把存下来的 id 贴到 <html> 上
 */
import { defineStore } from 'pinia';

const THEME_KEY = 'aige-theme';
const BRAND_KEY = 'aige-brand';

/** 可选主题色。color 只用于选择器上的小圆点，真正生效的是 palettes.css 里的令牌 */
export const BRAND_PRESETS = [
  { id: 'teal', name: '元气青', hint: '默认 · 取自 logo 主色', color: '#0f766e' },
  { id: 'green', name: '森林绿', hint: '上一版的默认绿', color: '#15803d' },
  { id: 'blue', name: '科技蓝', hint: '最稳的后台蓝，久看不累', color: '#1d4ed8' },
  { id: 'amber', name: '暖阳金', hint: '取自 logo 里的黄色调', color: '#9c4508' },
  { id: 'violet', name: '夜幕紫', hint: '冷静偏紫，夜班友好', color: '#6d28d9' },
  { id: 'rose', name: '玫瑰红', hint: '醒目的暖红，警示感强', color: '#be123c' },
];

const BRAND_IDS = BRAND_PRESETS.map((p) => p.id);
const DEFAULT_BRAND = 'teal';

/** 读取初始主题：本地存过就用本地的，否则跟随系统 */
function resolveInitialTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** 读取初始主题色：存过且仍然存在就用它，否则回默认 */
function resolveInitialBrand() {
  const saved = localStorage.getItem(BRAND_KEY);
  return BRAND_IDS.includes(saved) ? saved : DEFAULT_BRAND;
}

export const useThemeStore = defineStore('theme', {
  state: () => ({
    theme: resolveInitialTheme(),
    brand: resolveInitialBrand(),
  }),

  getters: {
    isDark: (state) => state.theme === 'dark',
    brandPresets: () => BRAND_PRESETS,
    brandName: (state) => BRAND_PRESETS.find((p) => p.id === state.brand)?.name || '',
  },

  actions: {
    /** 应用到 DOM */
    apply() {
      const root = document.documentElement;
      root.classList.toggle('dark', this.theme === 'dark');
      root.setAttribute('data-brand', this.brand);
      try {
        localStorage.setItem(THEME_KEY, this.theme);
        localStorage.setItem(BRAND_KEY, this.brand);
      } catch {
        /* 隐私模式：存不进就算了，本次会话内仍然生效 */
      }
    },

    toggle() {
      this.theme = this.theme === 'dark' ? 'light' : 'dark';
      this.apply();
    },

    /** 换主题色（同一个 id 重复点不做事，避免白跑一次重绘） */
    setBrand(id) {
      if (!BRAND_IDS.includes(id) || id === this.brand) return;
      this.brand = id;
      this.apply();
    },

    /** 供应用启动时调用一次，保证 DOM 与 store 一致 */
    init() {
      this.apply();
    },
  },
});
