<template>
  <!--
    品牌标识（艾哥 SaaS 工作台）
    ------------------------------------------------------------------
    图源：frontend/public/brand-mark.png —— 由主人提供的 logo 插画
         （brand-logo.jpg）裁切生成，取其中吉祥物头部的圆形特写。
    为什么要裁切而不是直接用整幅插画：整幅是「笔电 + 仪表盘 + 吉祥物 +
    标题」的完整插画，缩到侧栏的 34px 会糊成一团、认不出是什么；
    头部特写在这个尺寸依然清晰可辨。
    完整插画用在登录页等大尺寸场合（见 views/Login.vue）。

    生成脚本：tools/gen-brand-icons.ps1
    ⚠️ 换 logo 时替换 frontend/public/brand-logo.jpg 后重跑该脚本，
       不要手改生成的 PNG。
  -->
  <img
    class="brand-mark"
    :src="src"
    :width="size"
    :height="size"
    alt=""
    :role="label ? 'img' : 'presentation'"
    :aria-label="label || undefined"
    :aria-hidden="label ? undefined : 'true'"
    decoding="async"
    draggable="false"
  />
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  /** 渲染尺寸（正方形边长，px） */
  size: { type: Number, default: 34 },
  /** 无障碍标签；留空则视为纯装饰 */
  label: { type: String, default: '' },
});

/**
 * 图源固定走 brand-mark.png（256×256）。
 * 不做 2x/3x 多倍图：256px 在 34px 显示尺寸下相当于 7.5 倍，高清屏也够用。
 */
const src = computed(() => '/brand-mark.png');
</script>

<style scoped>
.brand-mark {
  display: block;
  flex: 0 0 auto;
  object-fit: contain;
  /* 圆图本身带白底，在深色主题下加一圈发丝线以免"糊"在背景里 */
  border-radius: 50%;
  user-select: none;
  -webkit-user-drag: none;
}

/* 上一版是主色渐变方块，换 logo 后不再需要渐变令牌，
   MainLayout / Login 里若还传了 from/to 属性会静默无效（Vue 只警告不报错），
   已一并清理调用处。 */
</style>
