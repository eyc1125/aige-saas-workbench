<!--
  全屏视频背景（装饰性）
  ==================================================================
  严格对应三条要求：
    ① 自动播放 / 无限循环 / 静音 / **全程无任何控件**
    ② **铺满整个浏览器视口**，保持画幅比例（object-fit: cover —— 只裁切、不拉伸变形）
    ③ 固定在**最底层**，且 `pointer-events: none` —— 不吃任何鼠标事件，
       因此**不遮挡 UI、也不影响上层交互**

  ⛔ 必须用 JS / 编码格式 / 静态图兜的坑：
    · `muted` —— Vue 的布尔属性在部分浏览器（Chrome / Safari）**不会真正写进 DOM**，
      DOM 里 muted=false 时自动播放会被浏览器策略直接拦掉（控制台报 NotAllowedError）。
      所以挂载后再补一次 `el.muted = true`。
    · `play()` —— 即便静音，个别环境仍可能拒绝；用 catch 静默吞掉，并挂「首次交互补播」。
    · **编码必须是 H.264（`avc1`）**——`public/bg-video.mp4` 第一版是 HEVC/H.265（`hvc1`），
      浏览器根本解不出来：`readyState=4`、时间轴在走，但 `videoWidth=0`、
      `totalVideoFrames=0`，画面上永远只有兜底色（实测踩过，看着就像"没换背景"）。
      换素材必须转码：`ffmpeg -i in.mp4 -an -c:v libx264 -pix_fmt yuv420p -crf 30 -movflags +faststart out.mp4`。

  ⛔ 微信内置浏览器（Android 走 X5 内核 / iOS 走 WKWebView）三个专属坑（第 5 轮修复）：
    ① **`x5-video-player-type` 必须写 `h5`**（不是 `h5-page`）。
       写错值时 X5 会把视频交给**原生全屏播放器**：页面里既看不到背景视频、还弹全屏。
       写 `h5` 才走「同层 DOM 渲染」，视频才会老老实实待在页面最底层（与 — 第 4 轮实测症状吻合）。
    ② **iOS 微信**只认带前缀的 `-webkit-playsinline`，且自动播放必须等 `WeixinJSBridgeReady`。
    ③ **播不了时必须有静态兜底**：微信里 play() 可能被静默拦下（不 reject、无从感知），
       画面就全空白（只剩兜底色）。所以垫一张**同源首帧图**（`bg-video-poster.jpg`）保底，
       同时给 `<video>` 加 `poster` 属性 —— 就算视频一直不播，用户也看得到画面。
       再叠加**轮询补播**（微信 UA 下每 800ms 试一次，直到时间轴真的在走），
       把「等用户点一下才播」也一并兜住。

  ♿ 无障碍：尊重 `prefers-reduced-motion` —— 系统开了「减弱动态效果」就把画面停在首帧，
     避免全屏运动画面引发不适；正常用户看到的就是自动播放。
-->
<template>
  <div class="vbg" aria-hidden="true">
    <!-- 静态首帧兜底：垫在 video 之下。视频一旦开始播就被盖住（video 在 DOM 里更靠后）。
         微信里视频不播 / 自动播放被拦时，至少保证「有画面」，不出现白闪与空屏。 -->
    <img class="vbg__poster" src="/bg-video-poster.jpg" alt="" />
    <video
      ref="el"
      class="vbg__video"
      :src="src"
      :autoplay="!reduceMotion"
      :poster="poster"
      loop
      muted
      playsinline
      webkit-playsinline="true"
      x5-playsinline="true"
      x5-video-player-type="h5"
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
import { onBeforeUnmount, onMounted, ref } from 'vue';

defineProps({
  /** 视频地址（放 frontend/public 下，用根路径引用） */
  src: { type: String, default: '/bg-video.mp4' },
  /** 压暗层浓度 0–1：视频越花、越大，就该给得越高（默认 0.35） */
  scrim: { type: Number, default: 0.35 },
  /** 首帧兜底图（视频播不了时显示；也用作 <video> 的 poster） */
  poster: { type: String, default: '/bg-video-poster.jpg' },
});

const el = ref(null);
const reduceMotion =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

/** 是否微信内置浏览器（Android X5 / iOS WKWebView）—— 只有它需要轮询补播 */
const isWeixin =
  typeof navigator !== 'undefined' && /MicroMessenger/i.test(navigator.userAgent || '');

/** 首次交互兜底的解绑函数（组件卸载 / 已经生效后调用） */
let unbindGesture = null;
/** 微信轮询补播的定时器与计数 */
let pollTimer = 0;
let pollCount = 0;
/** 只允许主动 load() 一次 —— 避免轮询反复重启加载、把带宽和 CPU 白烧掉 */
let loadCalled = false;

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
    play();
    if (unbindGesture) unbindGesture();
  };
  events.forEach((e) => window.addEventListener(e, onGesture, { passive: true }));
  unbindGesture = () => {
    events.forEach((e) => window.removeEventListener(e, onGesture));
    unbindGesture = null;
  };
}

/** 真正发起播放：静音 + 忽略 reduce-motion；失败静默（由障碍兜底流程接手） */
function play() {
  const v = el.value;
  if (!v || reduceMotion) return;
  v.muted = true; // ⛔ 关键：模板上的 muted 在部分浏览器不会落到 DOM
  const p = v.play();
  if (p && typeof p.catch === 'function') p.catch(() => {});
}

/**
 * 统一补播入口：挂载 / 微信桥就绪 / 媒体数据就绪 / bfcache 恢复 / 页面重新可见。
 * ⛔ 微信里 play() 有时发生在媒体数据就绪之前，会**静默失败**（不 reject、无从感知），
 *    画面就永远停在首帧 —— 所以这些时机都要再补一次，成本极低。
 */
function tryPlay() {
  const v = el.value;
  if (!v) return;

  v.muted = true;
  if (reduceMotion) {
    v.pause(); // 系统要求「减弱动态效果」→ 停在首帧
    return;
  }

  // readyState = 0（完全没有媒体数据）时，先 load() 一把，把加载拉起来再播（只做一次）
  if (v.readyState === 0 && !loadCalled) {
    loadCalled = true;
    try {
      v.load();
    } catch {
      /* 个别内核不支持重载，忽略 */
    }
  }

  const p = v.play();
  if (p && typeof p.catch === 'function') {
    // 被策略拦下：不报错、不打扰，只等用户第一次交互时补播
    p.catch(() => bindGestureRetry());
  }
}

/**
 * 微信专属轮询补播。
 * ⛔ 微信（尤其 Android X5）把视频交给原生层 / 延迟起播时，play() 会「假成功」：
 *    不抛错、但 currentTime 一直不动。定时轮询、以「时间轴是否真的在走」为判据，
 *    直到真的播起来或试满约 10 秒为止。非微信环境不启用，零开销。
 */
function startWeixinPoll() {
  if (!isWeixin || reduceMotion || pollTimer) return;
  pollTimer = window.setInterval(() => {
    const v = el.value;
    pollCount += 1;
    if (!v || v.currentTime > 0 || pollCount > 12) {
      stopWeixinPoll();
      return;
    }
    tryPlay();
  }, 800);
}

function stopWeixinPoll() {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = 0;
  }
}

/** 页面从 bfcache 恢复或重新可见时补播（移动端切后台再回来很常见） */
const onPageShow = () => {
  tryPlay();
  startWeixinPoll();
};
const onVisibility = () => {
  if (document.visibilityState === 'visible') {
    tryPlay();
    startWeixinPoll();
  }
};

onMounted(() => {
  tryPlay();

  // ---- 微信内置浏览器兜底（Android 的 X5 内核 / iOS 的 WKWebView）----
  // ⛔ 微信不会在挂载时就允许 play()，必须等它的 JS 桥就绪：
  //    · 桥已就绪时 `WeixinJSBridgeReady` 不会再触发（事件早于本组件挂载），
  //      所以先判存在性，存在就直接补播；
  //    · 桥未就绪才挂回调 —— 其他浏览器永远不会触发它，挂上无副作用。
  if (typeof window.WeixinJSBridge === 'undefined') {
    document.addEventListener('WeixinJSBridgeReady', tryPlay, false);
  } else {
    tryPlay();
  }
  startWeixinPoll();

  // 微信里 play() 有时发生在媒体数据就绪之前，会**静默失败**，画面停在首帧。
  // 数据就绪后再补一次，成本极低。
  const v = el.value;
  if (v) v.addEventListener('loadeddata', tryPlay, { once: true });

  // bfcache 恢复 / 切后台再回来 —— 移动端与微信里极常见的「回来就不播了」
  window.addEventListener('pageshow', onPageShow);
  document.addEventListener('visibilitychange', onVisibility);
});

onBeforeUnmount(() => {
  if (unbindGesture) unbindGesture();
  stopWeixinPoll();
  document.removeEventListener('WeixinJSBridgeReady', tryPlay, false);
  window.removeEventListener('pageshow', onPageShow);
  document.removeEventListener('visibilitychange', onVisibility);
  const v = el.value;
  if (v) {
    v.removeEventListener('loadeddata', tryPlay);
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

/* 静态首帧：垫在视频之下，撑满且不变形 */
.vbg__poster {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
  pointer-events: none;
}

.vbg__video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover; /* 要求 ②：铺满且**不变形** —— 超出部分裁掉，绝不拉伸 */
  /* 提升为独立合成层：整屏视频每帧都在更新，独立层能让合成器把它当一张贴图平移/缩放，
     不再与页面内容互相触发重绘 —— 滚动与切页更稳（第 5 轮流畅度优化）。 */
  transform: translateZ(0);
  backface-visibility: hidden;
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
