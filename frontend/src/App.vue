<template>
  <!-- Element Plus 的中文语言包：按需引入后不再有 app.use(ElementPlus, { locale })，
       改由 ConfigProvider 下发（分页、日期、空状态等内置文案才会是中文） -->
  <el-config-provider :locale="zhCn">
    <!--
      全站背景：22 秒循环视频（装饰性）
      —— 自动播放 / 无限循环 / 静音 / 无控件；铺满视口不变形；固定最底层且不吃事件。
      —— 放在 router-view **之前**，保证它在所有页面之下；scrim 0.6 是浓度，
         让画面「能看出来在动」但不干扰读数据（管理后台的命根子是数据可读性）。
      —— 登录页等自带底色的容器已改为 transparent / 半透明，视频才能透出来。
    -->
    <VideoBackground :scrim="0.6" />
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
import VideoBackground from '@/components/VideoBackground.vue';
// 根组件只负责：Element Plus 语言包、全站视频背景、路由出口、全局页面转场
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
