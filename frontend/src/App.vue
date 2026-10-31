<template>
  <!-- Element Plus 的中文语言包：按需引入后不再有 app.use(ElementPlus, { locale })，
       改由 ConfigProvider 下发（分页、日期、空状态等内置文案才会是中文） -->
  <el-config-provider :locale="zhCn">
    <!--
      全站背景：多段视频轮流播放（装饰性）
      —— 自动播放 / 无限循环 / 静音 / 无控件；铺满视口不变形；固定最底层且不吃事件。
      —— 放在 router-view **之前**，保证它在所有页面之下；scrim 0.18 是压暗浓度，
         是一层**深色** ND 减光镜（不是白膜）：只压亮度、保留色相，视频按原素材显色。
         刻意给得薄：视频要「原素材一眼看得见」，可读性由玻璃卡自身的白染保证
         （第 6 轮已把玻璃浓度统一提到 --glass-fill 76%，见 tokens.css）。
         （更早的版本用 0.6 的白底遮罩，把画面冲成灰白 → 主人明确否定。）
      —— 登录页等自带底色的容器已改为 transparent / 半透明，视频才能透出来。
      —— 第 7 轮：第二段（2026-10-31 微信视频，原件是 HEVC/hvc1 1080p，已在服务器转成
         720p H.264）只有 5.1 秒，靠 repeat: 3 连播约 15 秒再切，否则会「一闪就过」。
         两段都播完自动回头，顺序循环；切换是 900ms 透明度交叉，不换 src、不闪黑。
    -->
    <VideoBackground :sources="bgSources" :scrim="0.18" />
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

/**
 * 背景视频清单（顺序循环）。
 * · repeat：这一段连播几遍再切下一段 —— 短素材必须给 >1，否则「一闪就过」。
 * · poster 必须是**该段自己的首帧**，视频没播起来时才不会出现「图文不对应」。
 * · 素材编码必须 H.264（avc1）；HEVC/hvc1 浏览器解不出来（详见组件顶部注释）。
 */
const bgSources = [
  { src: '/bg-video.mp4', poster: '/bg-video-poster.jpg', repeat: 1 },
  { src: '/bg-video-2.mp4', poster: '/bg-video-poster-2.jpg', repeat: 3 },
];
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
