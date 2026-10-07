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
        // 大依赖单独切块：首屏只加载 Vue 与按需引入的 Element Plus 组件，
        // ECharts 随「仪表盘」路由按需加载，不拖慢登录页
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('echarts') || id.includes('zrender')) return 'echarts';
          if (id.includes('element-plus') || id.includes('@element-plus')) return 'element';
          if (id.includes('vue') || id.includes('pinia') || id.includes('@vue')) return 'vue';
          return undefined;
        },
      },
    },
  },
});
