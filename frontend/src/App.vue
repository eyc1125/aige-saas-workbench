<template>
  <!-- Element Plus 的中文语言包：按需引入后不再有 app.use(ElementPlus, { locale })，
       改由 ConfigProvider 下发（分页、日期、空状态等内置文案才会是中文） -->
  <el-config-provider :locale="zhCn">
    <router-view v-slot="{ Component }">
      <!-- 页面切换淡入（250ms），尊重 reduced-motion 时由样式表统一降级 -->
      <transition name="page-fade" mode="out-in">
        <component :is="Component" />
      </transition>
    </router-view>
  </el-config-provider>
</template>

<script setup>
import zhCn from 'element-plus/es/locale/lang/zh-cn';
// 根组件只负责：Element Plus 语言包、路由出口、全局页面转场
</script>

<style scoped>
.page-fade-enter-active,
.page-fade-leave-active {
  transition:
    opacity var(--dur-card) var(--ease),
    transform var(--dur-card) var(--ease);
}

.page-fade-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.page-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
