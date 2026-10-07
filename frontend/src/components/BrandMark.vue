<template>
  <!--
    品牌标识（艾哥 SaaS 工作台）
    ------------------------------------------------------------------
    图源：frontend/public/brand-mark.png —— 主人提供的整幅 logo 插画
         （brand-logo.jpg）等比缩放的 256px 版本。

    ⚠️ 这里**刻意不做任何裁切**：主人明确要求所有场合都使用整张 logo，
       而不是只取其中一部分。早期版本曾用「头部特写」做小尺寸图标，
       已按要求改回整幅图 —— 不要再改回去。

    插画自带白色底，而侧栏也是近白色，所以外面加一圈发丝线 + 圆角，
    让它读起来是「一枚品牌徽标」而不是一块浮出来的白斑。

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
 * 图源固定走 brand-mark.png（256×256 整幅插画）。
 * 不做 2x/3x 多倍图：256px 在 34px 显示尺寸下相当于 7.5 倍，高清屏也够用。
 */
const src = computed(() => '/brand-mark.png');
</script>

<style scoped>
.brand-mark {
  display: block;
  flex: 0 0 auto;
  object-fit: contain;
  border-radius: var(--r-md);
  /* 插画是白底，贴在近白背景上需要一条发丝线界定边界 */
  box-shadow: 0 0 0 1px var(--border-hairline);
  user-select: none;
  -webkit-user-drag: none;
}
</style>
