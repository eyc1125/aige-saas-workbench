<template>
  <el-alert
    v-if="auth.isViewer"
    class="ro-notice"
    type="info"
    :closable="false"
    show-icon
    title="你当前是只读身份"
    :description="text"
  />
</template>

<script setup>
/**
 * 只读身份提示条（B5）
 * ------------------------------------------------------------------
 * 只读用户在各页面上看到的是「按钮不见了」。如果不给一句话解释，
 * 他只会觉得"这系统坏了" —— 所以每个有写操作的页面都挂一条。
 *
 * 文案刻意点明「服务端会拒绝」：让人知道这是权限，不是 UI 故障。
 */
import { computed } from 'vue';
import { useAuthStore } from '@/stores/auth';

const props = defineProps({
  /** 这一页被禁掉的具体操作，例如「新建 / 删除站点、申请证书」 */
  what: { type: String, default: '所有写操作' },
});

const auth = useAuthStore();

const text = computed(
  () =>
    `可以查看全部数据，但${props.what}都会被服务端直接拒绝（不只是按钮藏起来了）。` +
    '需要操作权限，请联系管理员把你的角色改为「运维」或「管理员」。'
);
</script>

<style scoped>
.ro-notice {
  margin-bottom: var(--sp-4);
}
</style>
