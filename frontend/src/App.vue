<template>
  <!-- Element Plus 的中文语言包：按需引入后不再有 app.use(ElementPlus, { locale })，
       改由 ConfigProvider 下发（分页、日期、空状态等内置文案才会是中文） -->
  <el-config-provider :locale="zhCn">
    <!--
      全站背景：22 秒循环视频（装饰性）
      —— 自动播放 / 无限循环 / 静音 / 无控件；铺满视口不变形；固定最底层且不吃事件。
      —— 放在 router-view **之前**，保证它在所有页面之下；scrim 0.18 是压暗浓度，
         是一层**深色** ND 减光镜（不是白膜）：只压亮度、保留色相，视频按原素材显色。
         刻意给得薄：视频要「原素材一眼看得见」，可读性由玻璃卡自身 62%~70% 的白染保证。
         （更早的版本用 0.6 的白底遮罩，把画面冲成灰白 → 主人明确否定。）
      —— 登录页等自带底色的容器已改为 transparent / 半透明，视频才能透出来。
    -->
    <VideoBackground :scrim="0.18" />
    <router-view v-slot="{ Component }">
      <!-- 页面切换淡入（150ms），尊重 reduced-motion 时由样式表统一降级。
           ⛔ 只做 opacity，**不做位移**（第 5 轮性能修复）：
              transform 作用在「包含大量玻璃面」的整页祖先上 → 每帧重建 backdrop root + 重模糊，
              是路由切换卡顿的主因。纯淡入淡出几乎零成本，观感同样干净。 -->
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
  transition: opacity var(--dur-fast) var(--ease);
}

.page-fade-enter-from,
.page-fade-leave-to {
  opacity: 0;
}
</style>
