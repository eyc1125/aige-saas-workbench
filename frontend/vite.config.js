import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import AutoImport from 'unplugin-auto-import/vite';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    /**
     * Element Plus 按需引入
     * ------------------------------------------------------------------
     * 之前是 `app.use(ElementPlus)` 全量注册 —— 那会把**所有**组件的 JS
     * 都打进产物（element 分包约 1MB / gzip 339KB），而本系统只用到其中十几个。
     *
     * 现在由这两个插件在编译期解析模板里的 <el-xxx>，只打包真正用到的组件。
     *
     * importStyle: false 是刻意的：
     *   取消插件自动注入的「每组件样式」，改为继续使用 element-plus 的全量 CSS。
     *   原因：全量 CSS 只有 ~49KB（gzip），却能把「某个组件样式没被注入」
     *   这类难查的样式塌陷风险降到零。省体积的重头在 JS，不在 CSS。
     */
    AutoImport({ resolvers: [ElementPlusResolver({ importStyle: false })] }),
    Components({ resolvers: [ElementPlusResolver({ importStyle: false })] }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    // 开发环境把 /api 代理到后端，避免本地跨域
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:3000',
        changeOrigin: true,
        // SSE（容器实时日志）需要关闭缓冲
        ws: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        /**
         * ⚠️ 这里**刻意不给 element-plus 指定 chunk**（历史踩坑）
         * ------------------------------------------------------------------
         * 之前写的是 `if (id.includes('element-plus')) return 'element'`，
         * 结果 Rollup 把**全站用到的所有** Element Plus 组件（日期选择器、
         * 上传、树、走马灯… 大多只属于设置页/网站页）强制塞进同一个
         * `element-*.js`，而入口又静态引用了它 → index.html 里出现
         * `<link rel="modulepreload" href="/assets/element-*.js">`，
         * 于是**首屏（登录页/仪表盘）就要先下 302KB gzip 的 JS**，
         * 这正是"打开就卡一下"的根因。
         *
         * 交给 Rollup 自己切：入口只带走它真正用到的部分，组件跟着各自的
         * 路由懒加载 chunk 走，多个路由共用的部分由 Rollup 自动提升成共享块。
         *
         * ECharts 仍单独切块 —— 它只被仪表盘用，独立成块能吃到长缓存，
         * 且不会因为改业务代码而失效。
         *
         * Vue / Pinia / vue-router 也单独成块：首屏本来就要它，
         * 拆出来是为了业务代码频繁改动时它仍能命中浏览器缓存。
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('echarts') || id.includes('zrender')) return 'echarts';
          if (id.includes('/vue/') || id.includes('/@vue/') || id.includes('vue-router') || id.includes('pinia')) {
            return 'vue';
          }
          return undefined;
        },
      },
    },
  },
});
