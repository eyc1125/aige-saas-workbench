<template>
  <div class="nf">
    <div class="nf__code">404</div>
    <h1 class="nf__title">这个页面不存在</h1>
    <p class="nf__desc">地址可能输错了，或者对应的功能还没上线。</p>
    <el-button type="primary" @click="$router.replace('/dashboard')">回到仪表盘</el-button>
  </div>
</template>

<script setup>
// 404 兜底页
</script>

<style scoped>
.nf {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-3);
  min-height: 100vh;
  min-height: 100dvh;
  padding: var(--sp-6);
  text-align: center;
  background: var(--bg-page);
}

.nf__code {
  font-size: 56px;
  font-weight: 700;
  letter-spacing: -0.04em;
  line-height: 1;
  color: var(--brand);
}

.nf__title {
  font-size: var(--fs-xl);
  font-weight: 600;
  color: var(--text-primary);
}

.nf__desc {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  margin-bottom: var(--sp-2);
}
</style>
