<!--
  全屏视频背景（装饰性 · 多段轮播）
  ==================================================================
  严格对应三条要求：
    ① 自动播放 / 无限循环 / 静音 / **全程无任何控件**
    ② **铺满整个浏览器视口**，保持画幅比例（object-fit: cover —— 只裁切、不拉伸变形）
    ③ 固定在**最底层**，且 `pointer-events: none` —— 不吃任何鼠标事件，
       因此**不遮挡 UI、也不影响上层交互**

  多段轮播（第 7 轮新增）：
    · `sources` 传数组，每段 { src, poster, repeat }；一段播完自动交叉淡入下一段，到尾回头循环。
    · **每段独立一个 <video> 层**（不是一个 video 换 src）：
      换 src 会先黑屏再解码首帧，切一次闪一次；两层各自持住自己的画面，
      切换只是透明度交叉（900ms），**零黑屏、零重新解码卡顿**。
    · `repeat`：短素材（本轮第二段只有 5.1 秒）连播 N 遍再切，否则会「一闪就过」；
      用 ended 事件自己回绕（不用 loop 属性），这样计数可控。
    · 只有**当前段**在播，其余段暂停（暂停的视频不产生新帧，合成开销近似静态图）。
    · 带宽：首段 preload=auto，其余 metadata；在「距当前段结束 6 秒」时才把下一段
      真正拉起来预热 —— 既保证切换顺滑，又不会一进页面就吃掉十来兆流量。

  ⛔ 必须用 JS / 编码格式 / 静态图兜的坑：
    · `muted` —— Vue 的布尔属性在部分浏览器（Chrome / Safari）**不会真正写进 DOM**，
      DOM 里 muted=false 时自动播放会被浏览器策略直接拦掉（控制台报 NotAllowedError）。
      所以挂载后再补一次 `el.muted = true`。
    · `play()` —— 即便静音，个别环境仍可能拒绝；用 catch 静默吞掉，并挂「首次交互补播」。
    · **编码必须是 H.264（`avc1`）**——`public/bg-video.mp4` 第一版是 HEVC/H.265（`hvc1`），
      浏览器根本解不出来：`readyState=4`、时间轴在走，但 `videoWidth=0`、
      `totalVideoFrames=0`，画面上永远只有兜底色（实测踩过，看着就像"没换背景"）。
      换素材必须转码：`ffmpeg -i in.mp4 -an -c:v libx264 -pix_fmt yuv420p -crf 30 -movflags +faststart out.mp4`。
      ⚠️ 第 7 轮新增的 `bg-video-2.mp4` 原件同样是微信导出的 **HEVC/hvc1 1080p**，
         是在服务器上用 ffmpeg 转成 720p H.264 才放进来的（1.58MB）。
    · **首帧图必须与视频同一段素材**：多段轮播后，每段的 poster 必须是它自己的首帧，
      否则视频没播起来时会出现「一张图和实际画面完全无关」的错位感。

  ⛔ 微信内置浏览器（Android 走 X5 内核 / iOS 走 WKWebView）三个专属坑（第 5 轮修复）：
    ① **`x5-video-player-type` 必须写 `h5`**（不是 `h5-page`）。
       写错值时 X5 会把视频交给**原生全屏播放器**：页面里既看不到背景视频、还弹全屏。
       写 `h5` 才走「同层 DOM 渲染」，视频才会老老实实待在页面最底层（与 — 第 4 轮实测症状吻合）。
    ② **iOS 微信**只认带前缀的 `-webkit-playsinline`，且自动播放必须等 `WeixinJSBridgeReady`。
    ③ **播不了时必须有静态兜底**：微信里 play() 可能被静默拦下（不 reject、无从感知），
       画面就全空白（只剩兜底色）。所以垫一张**同源首帧图**保底，
       同时给 `<video>` 加 `poster` 属性 —— 就算视频一直不播，用户也看得到画面。
       再叠加**轮询补播**（微信 UA 下每 800ms 试一次，直到时间轴真的在走），
       把「等用户点一下才播」也一并兜住。
   ⚠️ 多段轮播后的微信注意点：上面这些兜底**只作用于当前正在显示的那一段**；
      每次切段都要重新走一遍「桥就绪 / 数据就绪 / 轮询」，否则第二段会停在首帧不动。

  ♿ 无障碍：尊重 `prefers-reduced-motion` —— 系统开了「减弱动态效果」就把画面停在首帧，
     避免全屏运动画面引发不适；正常用户看到的就是自动播放。多段下也**不切段**（不播就没有 ended）。
-->
<template>
  <div class="vbg" aria-hidden="true">
    <!-- 每一段一层：层内「首帧图垫底 + video」，切换只做透明度交叉 -->
    <div
      v-for="(item, i) in sources"
      :key="item.src"
      class="vbg__layer"
      :class="{ 'vbg__layer--on': i === activeIndex }"
    >
      <!-- 静态首帧兜底：垫在 video 之下。视频一旦开始播就被盖住（video 在 DOM 里更靠后）。
           微信里视频不播 / 自动播放被拦时，至少保证「有画面」，不出现白闪与空屏。 -->
      <img v-show="!started[i]" class="vbg__poster" :src="item.poster" alt="" />
      <video
        :ref="(el) => setVideo(el, i)"
        class="vbg__video"
        :src="item.src"
        :poster="item.poster"
        :preload="i === 0 ? 'auto' : 'metadata'"
        muted
        playsinline
        webkit-playsinline="true"
        x5-playsinline="true"
        x5-video-player-type="h5"
        x5-video-player-fullscreen="false"
        disablepictureinpicture
        controlslist="nodownload noplaybackrate noremoteplayback"
        @playing="onPlaying(i)"
        @ended="onEnded(i)"
        @timeupdate="onTimeUpdate(i)"
      />
    </div>
    <!-- 可调浓度的压暗层：全屏视频直接铺在文字下面会「花」，压一层才读得清 -->
    <div class="vbg__scrim" :style="{ opacity: scrim }" />
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';

const props = defineProps({
  /**
   * 背景视频列表（放 frontend/public 下，用根路径引用）：
   * [{ src, poster, repeat }]
   * · repeat：这一段连播几遍再切下一段（默认 1）
   */
  sources: {
    type: Array,
    default: () => [{ src: '/bg-video.mp4', poster: '/bg-video-poster.jpg' }],
  },
  /** 压暗层浓度 0–1：视频越花、越大，就该给得越高（默认 0.35） */
  scrim: { type: Number, default: 0.35 },
});

const list = () => (props.sources && props.sources.length ? props.sources : []);
const activeIndex = ref(0);

/** v-for 里的函数 ref：按索引收集每个 <video>（卸载时会传 null，要保留原元素判断） */
const videoEls = [];
function setVideo(el, i) {
  if (el) videoEls[i] = el;
}

/** 每段已经播完的遍数（配合 repeat 做回绕计数） */
const played = [];
/** 已经真正发起过 load() 的段（避免重复 load 白烧带宽与 CPU） */
const loaded = [];
/** 已经在后台预热的段（距结束 6 秒时把下一段拉起来） */
const warmed = [];
/**
 * 该段视频是否**真的出过帧**。
 * ⛔ 全屏静态首帧图是「兜底」：只有视频还没出画面时才需要它。
 *    视频一旦 playing，这张满屏 <img> 就被压在下面白占一层贴图 —— 收掉它，
 *    稳态下全屏背景只剩「一块视频」，合成开销立减（第 8 轮流畅度）。
 */
const started = ref([]);

const reduceMotion =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

/** 是否微信内置浏览器（Android X5 / iOS WKWebView）—— 只有它需要轮询补播 */
const isWeixin =
  typeof navigator !== 'undefined' && /MicroMessenger/i.test(navigator.userAgent || '');

/** 当前正在显示的那一段的 <video> */
const cur = () => videoEls[activeIndex.value] || null;

/** 首次交互兜底的解绑函数（组件卸载 / 已经生效后调用） */
let unbindGesture = null;
/** 微信轮询补播的定时器与计数 */
let pollTimer = 0;
let pollCount = 0;

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
    tryPlay();
    if (unbindGesture) unbindGesture();
  };
  events.forEach((e) => window.addEventListener(e, onGesture, { passive: true }));
  unbindGesture = () => {
    events.forEach((e) => window.removeEventListener(e, onGesture));
    unbindGesture = null;
  };
}

/** 真正出帧了：收掉该段的静态首帧图（少一层满屏贴图） */
function onPlaying(i) {
  started[i] = true;
}

/** 真正发起播放：静音 + 忽略 reduce-motion；失败静默（由兜底流程接手） */
function playVideo(v) {
  if (!v || reduceMotion) return;
  v.muted = true; // ⛔ 关键：模板上的 muted 在部分浏览器不会落到 DOM
  const p = v.play();
  if (p && typeof p.catch === 'function') p.catch(() => bindGestureRetry());
}

/**
 * 统一补播入口：挂载 / 微信桥就绪 / 媒体数据就绪 / bfcache 恢复 / 页面重新可见。
 * ⛔ 微信里 play() 有时发生在媒体数据就绪之前，会**静默失败**（不 reject、无从感知），
 *    画面就永远停在首帧 —— 所以这些时机都要再补一次，成本极低。
 */
function tryPlay() {
  const v = cur();
  if (!v) return;

  v.muted = true;
  if (reduceMotion) {
    v.pause(); // 系统要求「减弱动态效果」→ 停在首帧
    return;
  }

  // readyState = 0（完全没有媒体数据）时，先 load() 一把，把加载拉起来再播（每段只做一次）
  if (v.readyState === 0 && !loaded[activeIndex.value]) {
    loaded[activeIndex.value] = true;
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
  pollCount = 0;
  pollTimer = window.setInterval(() => {
    const v = cur();
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

/** 把某一段在后台拉起来（只做一次），用于切换前预热 */
function warmUp(i) {
  const v = videoEls[i];
  if (!v || warmed[i] || i === activeIndex.value) return;
  warmed[i] = true;
  v.preload = 'auto';
  try {
    v.load();
  } catch {
    /* 忽略 */
  }
}

/** 切到下一段：旧段暂停（停在最后一帧淡出），新段从头播放并淡入 */
function switchTo(next) {
  if (next === activeIndex.value) return;
  const prevVideo = videoEls[activeIndex.value];
  activeIndex.value = next;
  if (prevVideo) {
    try {
      prevVideo.pause();
    } catch {
      /* 忽略 */
    }
  }
  const nextVideo = videoEls[next];
  if (nextVideo) {
    // 从头重播 → 重新垫回首帧图（前几帧解码出来之前不能是黑的）
    started[next] = false;
    try {
      nextVideo.currentTime = 0;
    } catch {
      /* 部分内核在未加载完成时不允许 seek，忽略 */
    }
    playVideo(nextVideo);
  }
  // 微信里新段同样需要走一遍「桥就绪 / 轮询」兜底，否则会停在首帧
  stopWeixinPoll();
  startWeixinPoll();
  warmUp((next + 1) % list().length);
}

/** 一段播完：先按 repeat 遍数回绕，够了才切下一段 */
function onEnded(i) {
  if (i !== activeIndex.value || reduceMotion) return;
  const v = videoEls[i];
  const times = Math.max(1, Number(list()[i]?.repeat) || 1);
  played[i] = (played[i] || 0) + 1;

  if (played[i] < times) {
    if (v) {
      try {
        v.currentTime = 0;
      } catch {
        /* 忽略 */
      }
      playVideo(v);
    }
    return;
  }

  played[i] = 0;
  const next = (i + 1) % list().length;
  if (list().length > 1) {
    switchTo(next);
  } else if (v) {
    // 只有一段时自己回绕（等价于 loop，但保留了计数逻辑）
    try {
      v.currentTime = 0;
    } catch {
      /* 忽略 */
    }
    playVideo(v);
  }
}

/**
 * 距当前段结束 6 秒时预热下一段。
 * ⛔ 不预热的话，切段那一刻才开始下载 1.5MB，弱网下会看到首帧图「停住」等下载。
 */
function onTimeUpdate(i) {
  if (i !== activeIndex.value) return;
  const v = videoEls[i];
  if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return;
  if (v.duration - v.currentTime < 6) {
    const n = (i + 1) % list().length;
    if (n !== i) warmUp(n);
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
  const v = cur();
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
  videoEls.forEach((v) => {
    if (!v) return;
    try {
      v.pause();
      v.removeAttribute('src');
    } catch {
      /* 卸载途中元素可能已不可用，忽略 */
    }
  });
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

/* 每一段视频一层，切换只做透明度交叉（零黑屏、零重新解码卡顿） */
.vbg__layer {
  position: absolute;
  inset: 0;
  opacity: 0;
  /* ⛔ 关键（第 8 轮流畅度）：非激活段必须**真正退出绘制**。
     只写 opacity:0 时，这一层依旧是全屏独立合成层（下面 .vbg__video 有 translateZ(0)），
     浏览器每帧都要白合成一块 1440×900 的贴图 —— 两段并存 = 双倍 GPU 开销，
     这正是「有一点卡」的主因（第 7 轮刚加第二段后出现的）。
     visibility:hidden 之后该层不再绘制，稳态下全屏背景只剩**一块视频**在跑。 */
  visibility: hidden;
  /* 淡出走满 900ms 才隐藏；淡入时立刻恢复可见（见 --on，delay 0） */
  transition:
    opacity 900ms var(--ease, ease),
    visibility 0s linear 900ms;
}

.vbg__layer--on {
  opacity: 1;
  visibility: visible;
  transition:
    opacity 900ms var(--ease, ease),
    visibility 0s linear 0s;
}

/* 静态首帧：垫在 video 之下，撑满且不变形 */
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
