<template>
  <div class="nf">
    <!-- 视频背景在最底层，正文必须落在实底卡片上才读得清（与全站卡片同一套 surface） -->
    <div class="nf__plate surface">
      <div class="nf__code">404</div>
      <h1 class="nf__title">这个页面不存在</h1>
      <p class="nf__desc">地址可能输错了，或者对应的功能还没上线。</p>
      <el-button type="primary" @click="$router.replace('/dashboard')">回到仪表盘</el-button>
    </div>
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
  min-height: 100vh;
  min-height: 100dvh;
  padding: var(--sp-6);
  text-align: center;
  /* 不铺自己的底色：全站视频背景在最底层，铺了就把它盖住了 */
  background: transparent;
}

.nf__plate {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-3);
  max-width: 420px;
  padding: var(--sp-7) var(--sp-6);
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
