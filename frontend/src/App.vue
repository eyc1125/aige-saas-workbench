<template>
  <!-- Element Plus 的中文语言包：按需引入后不再有 app.use(ElementPlus, { locale })，
       改由 ConfigProvider 下发（分页、日期、空状态等内置文案才会是中文） -->
  <el-config-provider :locale="zhCn">
    <!--
      全站背景：22 秒循环视频（装饰性）
      —— 自动播放 / 无限循环 / 静音 / 无控件；铺满视口不变形；固定最底层且不吃事件。
      —— 放在 router-view **之前**，保证它在所有页面之下；scrim 0.25 是压暗浓度，
         刻意给得薄：视频要「一眼看得见」，而数据可读性由卡片与侧栏自身的白底保证
         （第一版给了 0.6，白底遮罩太厚，视频只剩 40% 对比度，看着就像没有背景）。
      —— 登录页等自带底色的容器已改为 transparent / 半透明，视频才能透出来。
    -->
    <VideoBackground :scrim="0.25" />
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
