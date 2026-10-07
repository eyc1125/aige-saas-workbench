<template>
  <!--
    品牌标识（艾哥 SaaS 工作台）
    ------------------------------------------------------------------
    造型：圆角方块 + 白色「A」字形（艾 / Aige 的首字母），
         方块内嵌一圈半透明内边框，制造「实体按键」的厚度感。
    为什么是文字标而不是图形标：控制台类产品长期出现在 20–40px 的侧栏与
    浏览器标签上，过于复杂的图形在这个尺寸会糊成一团；单字母标辨识度最高。
    渐变与主色令牌保持同源，改主色时全站标识自动跟着变。
  -->
  <svg
    class="brand-mark"
    :width="size"
    :height="size"
    viewBox="0 0 40 40"
    :role="label ? 'img' : 'presentation'"
    :aria-label="label || undefined"
    :aria-hidden="label ? undefined : 'true'"
  >
    <defs>
      <linearGradient :id="gradId" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" :stop-color="from" />
        <stop offset="1" :stop-color="to" />
      </linearGradient>
    </defs>

    <rect width="40" height="40" rx="11.5" :fill="`url(#${gradId})`" />
    <!-- 内嵌发丝高光：让方块看起来有厚度，而不是一张贴纸 -->
    <rect
      x="0.7"
      y="0.7"
      width="38.6"
      height="38.6"
      rx="10.9"
      fill="none"
      stroke="rgba(255, 255, 255, 0.24)"
      stroke-width="1.2"
    />
    <!-- A 字：两笔撇捺 + 一横，圆头笔画 -->
    <path
      d="M20 11.2 L12.2 28.6 M20 11.2 L27.8 28.6 M15.8 22.2 H24.2"
      fill="none"
      stroke="#f2fbfd"
      stroke-width="2.7"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  /** 渲染尺寸（正方形边长，px） */
  size: { type: Number, default: 34 },
  /** 渐变起色：品牌标记按图形 3:1 判定，可比按钮用的主色更艳一档 */
  from: { type: String, default: '#1a9c4d' },
  /** 渐变止色 */
  to: { type: String, default: '#15803d' },
  /** 无障碍标签；留空则视为纯装饰 */
  label: { type: String, default: '' },
});

// 同一个页面可能出现多个标识，渐变 id 必须唯一，否则 SVG 会互相抢引用
const uid = Math.random().toString(36).slice(2, 8);
const gradId = computed(() => `brand-grad-${uid}`);
</script>

<style scoped>
.brand-mark {
  display: block;
  flex: 0 0 auto;
}
</style>
