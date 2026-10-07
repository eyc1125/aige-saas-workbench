<template>
  <!--
    一键复制按钮
    · 放在需要「原样取走」的文本旁：域名、DNS 记录值、容器名、访问地址等。
    · @click.stop：这些按钮常出现在可点击的行/卡片里，必须阻止冒泡，
      否则点复制会顺手触发行点击（例如打开详情弹窗）。
    · 样式写在全局 index.css 的 .copy-btn —— 那里统一处理了手机上 44px 的点击区。
  -->
  <button class="copy-btn" type="button" :title="title" :aria-label="title" @click.stop="onCopy">
    <el-icon><DocumentCopy /></el-icon>
  </button>
</template>

<script setup>
import { DocumentCopy } from '@element-plus/icons-vue';
import { copyText } from '@/composables/useCopy';

const props = defineProps({
  /** 要复制的内容 */
  text: { type: [String, Number], default: '' },
  /** 悬停提示，同时作为无障碍标签 */
  title: { type: String, default: '复制' },
  /** 成功后的提示语 */
  okMessage: { type: String, default: '已复制' },
});

async function onCopy() {
  await copyText(props.text, props.okMessage);
}
</script>
