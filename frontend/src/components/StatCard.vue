<template>
  <div
    ref="rootRef"
    class="stat"
    :class="`stat--${tone}`"
    @pointermove="onPointerMove"
    @pointerleave="onPointerLeave"
  >
    <div class="stat__head">
      <span class="stat__label">{{ label }}</span>
      <span class="stat__icon" aria-hidden="true">
        <el-icon><component :is="icon" /></el-icon>
      </span>
    </div>

    <div class="stat__value">
      <!-- 数值优先：异常值给到警示色，正常走主文字色 -->
      <span class="stat__num tnum">{{ displayValue }}</span>
      <span v-if="unit" class="stat__unit">{{ unit }}</span>
    </div>

    <div
      v-if="showBar"
      class="stat__bar"
      role="progressbar"
      :aria-valuenow="barValue"
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <span class="stat__bar-fill" :style="{ width: `${barValue}%` }" />
    </div>

    <p v-if="hint" class="stat__hint">{{ hint }}</p>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps({
  label: { type: String, required: true },
  value: { type: [String, Number], default: '—' },
  unit: { type: String, default: '' },
  hint: { type: String, default: '' },
  icon: { type: String, default: 'Odometer' },
  /** brand | success | warning | danger | neutral */
  tone: { type: String, default: 'brand' },
  /** 是否显示进度条 */
  showBar: { type: Boolean, default: false },
  /** 进度条百分比（0-100），带默认值时取 value */
  percent: { type: [Number, String], default: null },
});

const rootRef = ref(null);

// ============================================================
// 3D 倾斜
// ------------------------------------------------------------------
// 只给「有鼠标且不排斥动效」的设备开：
//   · 触屏上没有 hover，指针事件在抬手前一直触发，只会白耗电；
//   · 服务器这台机器资源紧张，能省的重绘就省。
// 角度刻意压得很小（X 5° / Y 7°）—— 大面积卡片转太多会晕，
// 而且一旦超过 ~10° 就会露出「塑料感」。
// ============================================================
const TILT_X_LIMIT = 5;
const TILT_Y_LIMIT = 7;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const tiltEnabled =
  !reducedMotion && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

let rafId = 0;

function onPointerMove(event) {
  if (!tiltEnabled || rafId || !rootRef.value) return;
  const rect = rootRef.value.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  // 归一化到 [-0.5, 0.5]
  const px = (event.clientX - rect.left) / rect.width - 0.5;
  const py = (event.clientY - rect.top) / rect.height - 0.5;

  // 指针移动是高频事件（可达 120Hz），用 rAF 合并成每帧最多一次写入
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    const el = rootRef.value;
    if (!el) return;
    el.style.setProperty('--tilt-x', `${(-py * TILT_X_LIMIT).toFixed(2)}deg`);
    el.style.setProperty('--tilt-y', `${(px * TILT_Y_LIMIT).toFixed(2)}deg`);
    el.style.setProperty('--glow-x', `${((px + 0.5) * 100).toFixed(1)}%`);
    el.style.setProperty('--glow-y', `${((py + 0.5) * 100).toFixed(1)}%`);
  });
}

function onPointerLeave() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  const el = rootRef.value;
  if (!el) return;
  el.style.setProperty('--tilt-x', '0deg');
  el.style.setProperty('--tilt-y', '0deg');
}

// ============================================================
// 数字滚动
// ------------------------------------------------------------------
// 只在「数值 → 数值」之间滚动；「— → 数值」从 0 滚上来（首次拿到数据
// 时那一下的反馈感）；「数值 → —」（比如后端刚重启拿不到 CPU）直接跳，
// 从数字滚到破折号没有意义。
// ============================================================
const shown = ref(props.value);
let numRaf = 0;

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

watch(
  () => props.value,
  (to, from) => {
    if (numRaf) {
      cancelAnimationFrame(numRaf);
      numRaf = 0;
    }
    const target = toNumber(to);
    if (target === null || reducedMotion) {
      shown.value = to;
      return;
    }
    const start = toNumber(from);
    const begin = start === null ? 0 : start;
    if (begin === target) {
      shown.value = to;
      return;
    }

    // 整数值滚出来的是整数，一位小数就滚一位小数，避免数字抖成 12.999
    const isInt = Number.isInteger(target) && Number.isInteger(begin);
    const startedAt = performance.now();
    const DURATION = 520;

    const step = (now) => {
      const t = Math.min(1, (now - startedAt) / DURATION);
      // 三次缓出：起手快、收尾稳，比线性更像"数字落定"
      const eased = 1 - (1 - t) ** 3;
      const v = begin + (target - begin) * eased;
      shown.value = isInt ? Math.round(v) : Number(v.toFixed(1));
      if (t < 1) {
        numRaf = requestAnimationFrame(step);
      } else {
        numRaf = 0;
        shown.value = to;
      }
    };
    numRaf = requestAnimationFrame(step);
  }
);

onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId);
  if (numRaf) cancelAnimationFrame(numRaf);
});

const displayValue = computed(() => {
  if (shown.value === null || shown.value === undefined || shown.value === '') return '—';
  return shown.value;
});

const barValue = computed(() => {
  const raw = props.percent ?? props.value;
  const num = Number(String(raw).replace('%', ''));
  if (!Number.isFinite(num)) return 0;
  return Math.min(Math.max(num, 0), 100);
});
</script>

<style scoped>
.stat {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-4) var(--sp-4) var(--sp-4) var(--sp-5);
  background: var(--bg-surface);
  border: 1px solid var(--border-hairline);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
  /* 3D 倾斜：角度来自 JS 写的 --tilt-*，未启用时恒为 0deg（等于没变换）。
     perspective 放在卡片自身上，透视强度小一点，倾斜才不会看起来像被拉扯。
     注意：这里**没有** preserve-3d，也不要加 —— 卡片有 overflow: hidden，
     按规范它会强制把 preserve-3d 降级成 flat，子元素的 translateZ 会静默失效。 */
  transform: perspective(760px) rotateX(var(--tilt-x, 0deg)) rotateY(var(--tilt-y, 0deg))
    translateY(var(--lift, 0px));
  transition:
    transform var(--dur-card) var(--ease),
    box-shadow var(--dur-card) var(--ease);
  will-change: transform;
}

.stat:hover {
  --lift: -2px;
  box-shadow: var(--shadow-md);
}

/* 指针跟随的一层极淡高光：让"立体"有光源方向，而不是硬邦邦地转 */
.stat::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: radial-gradient(
    240px circle at var(--glow-x, 50%) var(--glow-y, 0%),
    color-mix(in oklab, var(--brand) 12%, transparent),
    transparent 70%
  );
  opacity: 0;
  transition: opacity var(--dur-card) var(--ease);
  pointer-events: none;
}

.stat:hover::after {
  opacity: 1;
}

/* 左侧 1px 色调标记：极细，避免「左侧 3px 色条」这种廉价装饰 */
.stat::before {
  content: '';
  position: absolute;
  inset: 14px auto 14px 0;
  width: 2px;
  border-radius: 0 2px 2px 0;
  background: var(--tone-color, var(--brand));
  opacity: 0.85;
}

.stat--brand {
  --tone-color: var(--brand);
}
.stat--success {
  --tone-color: var(--success);
}
.stat--warning {
  --tone-color: var(--warning);
}
.stat--danger {
  --tone-color: var(--danger);
}
.stat--neutral {
  --tone-color: var(--text-tertiary);
}

.stat__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}

.stat__label {
  font-size: var(--fs-xs);
  font-weight: 500;
  letter-spacing: 0.02em;
  color: var(--text-secondary);
}

.stat__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  color: var(--tone-color, var(--brand));
  font-size: 14px;
}

.stat__value {
  display: flex;
  align-items: baseline;
  gap: 4px;
  line-height: 1.15;
}

.stat__num {
  font-size: var(--fs-2xl);
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--text-primary);
}

.stat__unit {
  font-size: var(--fs-sm);
  color: var(--text-tertiary);
}

.stat__bar {
  height: 4px;
  border-radius: var(--r-full);
  background: var(--bg-subtle);
  overflow: hidden;
}

.stat__bar-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--tone-color, var(--brand));
  transition: width var(--dur-card) var(--ease);
}

.stat__hint {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  line-height: 1.5;
}

@media (max-width: 768px) {
  .stat {
    padding: var(--sp-3) var(--sp-3) var(--sp-3) var(--sp-4);
    /* 手机上不做 3D：没有 hover、且这几张卡是首屏最大的一块重绘 */
    transform: none;
    will-change: auto;
  }

  .stat::after {
    display: none;
  }

  .stat__num {
    font-size: var(--fs-xl);
  }
}
</style>
