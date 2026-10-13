<template>
  <div class="stat" :class="`stat--${tone}`">
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

// ⛔ 3D 倾斜已移除（2026-10-14 第 5 轮性能修复）：
//    卡片原本带 backdrop-filter，再叠 rotateX/rotateY 的实时 transform →
//    指针每次移动都要**重建 backdrop root 并重模糊整块**，是卡顿的头号放大器。
//    4 张 KPI 卡同时转，指针一动就整屏掉帧。去掉后静态玻璃观感不变，指针滑动丝滑。
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
  /* 与 .surface 同一套真玻璃：--glass-fill 半透明 + 可见内框，视频从卡片后面透出来。
     ⛔ 去掉 backdrop-filter（第 5 轮性能）：4 张 KPI 卡同时去模糊动的视频，代价高、3px 模糊看不出。
     ♻️ 浓度改走 --glass-fill（第 6 轮）：KPI 数字是「大号标题」、旁边 hint 是 12px 次级文字，
        底衬太透时 hint 会被视频暗帧吃掉 —— 统一提实后一并解决。 */
  background: color-mix(in srgb, var(--bg-surface) var(--glass-fill), transparent);
  border: 1px solid var(--border-hairline);
  border-radius: var(--r-lg);
  box-shadow:
    inset 0 0 0 1px var(--border-strong),
    inset 0 1px 0 color-mix(in srgb, var(--bg-surface) 85%, transparent),
    var(--shadow-sm);
  overflow: hidden;
  transition: box-shadow var(--dur-card) var(--ease);
}

.stat:hover {
  /* 悬停只把外阴影加深，内框必须保留 —— 单独写 shadow-md 会把玻璃内框一起清掉 */
  box-shadow:
    inset 0 0 0 1px var(--border-strong),
    inset 0 1px 0 color-mix(in srgb, var(--bg-surface) 85%, transparent),
    var(--shadow-md);
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
  }

  .stat__num {
    font-size: var(--fs-xl);
  }
}
</style>
