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

    <div v-if="showBar" class="stat__bar" role="progressbar" :aria-valuenow="barValue" aria-valuemin="0" aria-valuemax="100">
      <span class="stat__bar-fill" :style="{ width: `${barValue}%` }" />
    </div>

    <p v-if="hint" class="stat__hint">{{ hint }}</p>
  </div>
</template>

<script setup>
import { computed } from 'vue';

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

const displayValue = computed(() => {
  if (props.value === null || props.value === undefined || props.value === '') return '—';
  return props.value;
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
  transition: transform var(--dur-card) var(--ease), box-shadow var(--dur-card) var(--ease);
  overflow: hidden;
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

.stat:hover {
  transform: translateY(-1px);
  box-shadow: var(--shadow-md);
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
