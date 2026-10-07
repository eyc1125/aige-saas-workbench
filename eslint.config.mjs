/**
 * ESLint 扁平配置（v9）
 * ------------------------------------------------------------------
 * 分工写清楚，避免两套规则互相打架：
 *   · **ESLint 只管「正确性」** —— 未使用变量、意外全局、Vue 的必须规则；
 *   · **Prettier 只管「格式」** —— 缩进、引号、换行。
 * 所以最后一条永远是 eslint-config-prettier：它把 ESLint 里所有跟格式有关的
 * 规则关掉。不这么做，两边会互相「纠正」，改完 ESLint 又红 Prettier。
 *
 * 为什么前端只用 vue3-essential 而不是 vue3-recommended：
 * recommended 里大量是风格规则（属性顺序、每行一个属性…），
 * 那些交给 Prettier；一上来就开 recommended，旧代码会瞬间几百条红，
 * 结果是所有人 `--no-verify` 绕过，规则等于没有。
 *
 * 后端源码是 CommonJS，前端是 ESM，两边的解析方式必须分开配。
 */
import js from '@eslint/js';
import globals from 'globals';
import pluginVue from 'eslint-plugin-vue';
import pluginN from 'eslint-plugin-n';
import configPrettier from 'eslint-config-prettier';

/** 全仓通用的「不要检查这些」 */
const IGNORES = [
  '**/node_modules/**',
  '**/dist/**',
  'backend/public/**',
  'data/**',
  '.deploy/**',
  '.qa/shots/**',
  '**/*.min.js',
];

/** 两边共用的正确性规则 */
const SHARED_RULES = {
  'no-unused-vars': [
    'error',
    // 下划线开头 = 有意不用；catch 不写参数也是常见且无害的写法
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
  ],
  // 空 catch 在本项目里是刻意的降级（例如读不到 /proc 就返回默认值），
  // 但注释必须写清楚为什么——这条规则只放行空块，不放过其它空语句
  'no-empty': ['error', { allowEmptyCatch: true }],
  eqeqeq: ['error', 'smart'],
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
};

export default [
  { ignores: IGNORES },

  // ---------------- 后端：Node 20 + CommonJS ----------------
  {
    files: ['backend/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    plugins: { n: pluginN },
    rules: {
      ...js.configs.recommended.rules,
      ...SHARED_RULES,
      /**
       * n/no-extraneous-require 抓的是「本地能跑、进 Docker 就崩」那一类 bug：
       * 后端镜像用 `npm install --omit=dev` 安装，代码里 require 了
       * 没写进 package.json 的包，构建期不会报错，容器一启动才炸。
       * 这是本项目的真实风险面（better-sqlite3 就是这么被漏过一次）。
       */
      'n/no-extraneous-require': 'error',
      'n/no-deprecated-api': 'error',
      /**
       * 循环里 await 用「警告」而不是「禁止」。
       * 后端大量存在「逐站读证书 / 逐 zone 查 DNS / 逐个拉镜像」这种必须串行的
       * 循环（并发打第三方 API 会触发限流，并发 pull 会打满磁盘），所以不能禁；
       * 但每一处都值得被看一眼 —— 真出过一次「本来能并发却写成了串行」的性能问题。
       * 结论：留成警告，并在代码里用 eslint-disable-next-line 写明为什么必须串行。
       *
       * 只对 backend 开这条：.qa/ 下的验收台是「一步步驱动浏览器」的脚本，
       * 串行是它的本质，开这条只会刷出几十条无意义警告。
       */
      'no-await-in-loop': 'warn',
    },
  },

  // ---------------- 本地脚本：不做串行 await 检查 ----------------
  {
    files: ['.qa/**/*.mjs', 'tools/**/*.js'],
    rules: { 'no-await-in-loop': 'off' },
  },

  // ---------------- 仓库级脚本（.mjs，ESM + Node） ----------------
  // 用 **/*.mjs 而不是 *.mjs：.qa/ 下的验收台也是要维护的代码，
  // 之前漏掉它们，结果那些文件里的 eslint-disable 注释全成了「未使用指令」。
  {
    files: ['**/*.mjs', 'tools/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: { ...js.configs.recommended.rules, ...SHARED_RULES },
  },

  // ---------------- 前端：浏览器 + ESM ----------------
  {
    files: ['frontend/src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: { ...js.configs.recommended.rules, ...SHARED_RULES },
  },

  // Vue SFC（essential = 只保留「写错会出 bug」的规则）
  ...pluginVue.configs['flat/essential'].map((cfg) => ({
    ...cfg,
    files: ['frontend/src/**/*.vue'],
  })),
  {
    files: ['frontend/src/**/*.vue'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: { ...SHARED_RULES },
  },

  // vite 配置文件跑在 Node 里，不是浏览器
  {
    files: ['frontend/vite.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: { ...js.configs.recommended.rules, ...SHARED_RULES },
  },

  /**
   * 路由级视图（views/）关掉 multi-word-component-names。
   * 这条规则防的是「全局注册的通用组件跟 HTML 标签撞名」，而 views 下每个
   * 文件都对应一条路由、只被 router 动态 import 一次，名字跟路由一一对应
   * 才是最好读的（Dashboard.vue ↔ /dashboard）。硬改成
   * DashboardView.vue 只会让「找页面」多一步脑内映射。
   * components/ 下保留这条规则 —— 那里才是它真正要防的地方。
   */
  {
    files: ['frontend/src/views/**/*.vue'],
    rules: { 'vue/multi-word-component-names': 'off' },
  },

  // ---------------- 必须放最后：关掉所有与 Prettier 冲突的格式规则 ----------------
  configPrettier,
];
