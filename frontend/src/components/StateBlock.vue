<template>
  <!--
    统一的状态占位块：加载中 / 空数据 / 加载失败
    三种状态在同一个组件里，避免每个列表页各写一套，样式与文案口径不一
  -->
  <div class="state" :class="`state--${state}`">
    <!-- 加载中：骨架屏（不用转圈，避免整块空白） -->
    <template v-if="state === 'loading'">
      <div class="state__skeleton">
        <span
          v-for="i in 4"
          :key="i"
          class="state__skeleton-row"
          :style="{ width: `${92 - i * 9}%` }"
        />
      </div>
      <p class="state__title">{{ loadingText }}</p>
    </template>

    <!-- 空数据 / 失败 -->
    <template v-else>
      <span class="state__glyph" aria-hidden="true">
        <el-icon><component :is="state === 'error' ? 'WarningFilled' : 'Files'" /></el-icon>
      </span>
      <p class="state__title">{{ title }}</p>
      <p v-if="description" class="state__desc">{{ description }}</p>
      <el-button
        v-if="state === 'error' || actionText"
        class="state__action"
        :type="state === 'error' ? 'primary' : 'default'"
        plain
        @click="$emit('action')"
      >
        {{ actionText || '重新加载' }}
      </el-button>
    </template>
  </div>
</template>

<script setup>
defineProps({
  /** loading | empty | error */
  state: { type: String, default: 'empty' },
  title: { type: String, default: '' },
  description: { type: String, default: '' },
  actionText: { type: String, default: '' },
  loadingText: { type: String, default: '正在加载…' },
});

defineEmits(['action']);
</script>

<style scoped>
.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: var(--sp-7) var(--sp-5);
  text-align: center;
  min-height: 180px;
}

.state__glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  margin-bottom: var(--sp-1);
  border-radius: var(--r-lg);
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
  font-size: 20px;
  color: var(--text-tertiary);
}

.state--error .state__glyph {
  background: var(--danger-soft);
  border-color: transparent;
  color: var(--danger);
}

.state__title {
  font-size: var(--fs-base);
  font-weight: 500;
  color: var(--text-primary);
}

.state__desc {
  max-width: 460px;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.state__action {
  margin-top: var(--sp-3);
}

/* ---------- 骨架屏：渐变扫光 1.5s 循环 ---------- */
.state__skeleton {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-3);
  width: min(520px, 100%);
  margin-bottom: var(--sp-2);
}

.state__skeleton-row {
  height: 12px;
  border-radius: var(--r-full);
  background: linear-gradient(
    90deg,
    var(--bg-subtle) 25%,
    var(--bg-hover) 37%,
    var(--bg-subtle) 63%
  );
  background-size: 400% 100%;
  animation: skeleton-scan 1.5s var(--ease) infinite;
}

@keyframes skeleton-scan {
  0% {
    background-position: 100% 50%;
  }
  100% {
    background-position: 0 50%;
  }
}

/* 降低动效偏好下：静止为纯色块，信息仍然完整 */
@media (prefers-reduced-motion: reduce) {
  .state__skeleton-row {
    background: var(--bg-subtle);
  }
}
</style>
