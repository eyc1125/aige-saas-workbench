<!--
  全屏视频背景（装饰性）
  ==================================================================
  严格对应三条要求：
    ① 自动播放 / 无限循环 / 静音 / **全程无任何控件**
    ② **铺满整个浏览器视口**，保持画幅比例（object-fit: cover —— 只裁切、不拉伸变形）
    ③ 固定在**最底层**，且 `pointer-events: none` —— 不吃任何鼠标事件，
       因此**不遮挡 UI、也不影响上层交互**

  ⛔ 四个必须用 JS / 编码格式兜的坑：
    · `muted` —— Vue 的布尔属性在部分浏览器（Chrome / Safari）**不会真正写进 DOM**，
      DOM 里 muted=false 时自动播放会被浏览器策略直接拦掉（控制台报 NotAllowedError）。
      所以挂载后再补一次 `el.muted = true`。
    · `play()` —— 即便静音，个别环境仍可能拒绝；用 catch 静默吞掉。
      背景视频播不了不该影响任何人使用页面（此时露出兜底色 + 品牌色渐变，一样好看）。
    · **微信内置浏览器**（Android 的 X5 / iOS 的 WKWebView）不认普通自动播放：
      必须等 `WeixinJSBridgeReady` 后再 `play()`，并给 video 挂 X5 专属属性
      （`x5-video-player-type="h5-page"` 等），否则要么不播、要么被拉起原生全屏播放器。
    · **编码必须是 H.264（`avc1`）**——`public/bg-video.mp4` 第一版是 HEVC/H.265（`hvc1`），
      浏览器根本解不出来：`readyState=4`、时间轴在走，但 `videoWidth=0`、
      `totalVideoFrames=0`，画面上永远只有兜底色（实测踩过，看着就像"没换背景"）。
      换素材必须转码：`ffmpeg -i in.mp4 -an -c:v libx264 -pix_fmt yuv420p -crf 30 -movflags +faststart out.mp4`。

  ♿ 无障碍：尊重 `prefers-reduced-motion` —— 系统开了「减弱动态效果」就把画面停在首帧，
     避免全屏运动画面引发不适；正常用户看到的就是自动播放。
-->
<template>
  <div class="vbg" aria-hidden="true">
    <video
      ref="el"
      class="vbg__video"
      :src="src"
      :autoplay="!reduceMotion"
      loop
      muted
      playsinline
      webkit-playsinline="true"
      x5-playsinline="true"
      x5-video-player-type="h5-page"
      x5-video-player-fullscreen="false"
      preload="auto"
      disablepictureinpicture
      controlslist="nodownload noplaybackrate noremoteplayback"
    />
    <!-- 可调浓度的压暗层：全屏视频直接铺在文字下面会「花」，压一层才读得清 -->
    <div class="vbg__scrim" :style="{ opacity: scrim }" />
  </div>
</template>

<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue';

defineProps({
  /** 视频地址（放 frontend/public 下，用根路径引用） */
  src: { type: String, default: '/bg-video.mp4' },
  /** 压暗层浓度 0–1：视频越花、越大，就该给得越高（默认 0.35） */
  scrim: { type: Number, default: 0.35 },
});

const el = ref(null);
const reduceMotion =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

/** 首次交互兜底的解绑函数（组件卸载 / 已经生效后调用） */
let unbindGesture = null;

/**
 * 挂一次「首次交互就补播」。
 * ⛔ 为什么必须有：自动播放策略会拦（省电模式、浏览器「限制自动播放」设置、
 *    某些无头 / 嵌入式环境）。被拦时若什么都不做，背景就**永远停在首帧** ——
 *    用户看到的是「一张静止图」，而我们承诺的是「会动的背景」。
 *    挂一次交互监听，用户点/按任何地方就把它接上，成本几乎为零。
 */
function bindGestureRetry() {
  if (unbindGesture) return;
  const events = ['pointerdown', 'click', 'keydown', 'touchstart'];
  const onGesture = () => {
    const v = el.value;
    if (v) {
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
    if (unbindGesture) unbindGesture();
  };
  events.forEach((e) => window.addEventListener(e, onGesture, { passive: true }));
  unbindGesture = () => {
    events.forEach((e) => window.removeEventListener(e, onGesture));
    unbindGesture = null;
  };
}

function tryPlay() {
  const v = el.value;
  if (!v) return;

  v.muted = true; // ⛔ 关键：模板上的 muted 在部分浏览器不会落到 DOM
  if (reduceMotion) {
    v.pause(); // 系统要求「减弱动态效果」→ 停在首帧
    return;
  }

  const p = v.play();
  if (p && typeof p.catch === 'function') {
    // 被策略拦下：不报错、不打扰，只等用户第一次交互时补播
    p.catch(() => bindGestureRetry());
  }
}

/** 微信桥就绪 / 媒体数据就绪时的统一补播入口 */
function onWeixinReady() {
  tryPlay();
}

onMounted(() => {
  tryPlay();

  // ---- 微信内置浏览器兜底（Android 的 X5 内核 / iOS 的 WKWebView）----
  // ⛔ 微信不会在挂载时就允许 play()，必须等它的 JS 桥就绪：
  //    · 桥已就绪时 `WeixinJSBridgeReady` 不会再触发（事件早于本组件挂载），
  //      所以先判存在性，存在就直接补播；
  //    · 桥未就绪才挂回调 —— 其他浏览器永远不会触发它，挂上无副作用。
  if (typeof window.WeixinJSBridge === 'undefined') {
    document.addEventListener('WeixinJSBridgeReady', onWeixinReady, false);
  } else {
    tryPlay();
  }

  // 微信里 play() 有时发生在媒体数据就绪之前，会**静默失败**（不 reject、无从感知），
  // 画面就永远停在首帧。数据就绪后再补一次，成本极低。
  const v = el.value;
  if (v) v.addEventListener('loadeddata', onWeixinReady, { once: true });
});

onBeforeUnmount(() => {
  if (unbindGesture) unbindGesture();
  document.removeEventListener('WeixinJSBridgeReady', onWeixinReady, false);
  const v = el.value;
  if (v) {
    v.removeEventListener('loadeddata', onWeixinReady);
    try {
      v.pause();
      v.removeAttribute('src');
    } catch {
      /* 卸载途中元素可能已不可用，忽略 */
    }
  }
});
</script>

<style scoped>
.vbg {
  position: fixed; /* 要求 ②：铺满整个浏览器视口（而不是某个容器） */
  inset: 0;
  /* 要求 ③：压在最底层。
     ⛔ 这里必须用 -1，不能用 0：
        z-index:0 属于「定位元素」，按 CSS 绘制顺序会盖在**静态内容**之上；
        而像 404 页那种「整页静态文案」的页面就会被整层挡死（实测踩过）。
        -1 让视频排到所有常规内容之前 —— 只在画布底色之上、任何内容之下。 */
  z-index: -1;
  overflow: hidden;
  pointer-events: none; /* 要求 ③：完全不吃鼠标事件 → 不可能挡到任何交互 */
  background: var(--bg-page); /* 视频未就绪/不支持时的兜底色 */
}

.vbg__video {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover; /* 要求 ②：铺满且**不变形** —— 超出部分裁掉，绝不拉伸 */
}

.vbg__scrim {
  position: absolute;
  inset: 0;
  /* ⛔ 深色压暗，不是白膜。
     上一版这里跟着 .vbg 用 --bg-page（近白）—— 25% 的近白等于给整块视频刷了层牛奶，
     画面被洗成灰白，看不到原素材的颜色（主人第 4 轮明确否定）。
     改成深色（ND 减光镜）：只压亮度、不吃色相，视频按原素材显色，玻璃层与文字也压得住。 */
  background: var(--scrim-bg, rgba(6, 22, 14, 0.22));
  transition: opacity var(--dur-card, 200ms) var(--ease, ease);
}
</style>
