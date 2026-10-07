<template>
  <div class="page">
    <!-- ==================== 巡检结论 ==================== -->
    <section v-if="!loading && state !== 'error'" class="verdict" :class="`verdict--${verdict.tone}`">
      <span class="verdict__icon" aria-hidden="true"><el-icon><component :is="verdict.icon" /></el-icon></span>
      <div class="verdict__text">
        <strong>{{ verdict.title }}</strong>
        <p>{{ verdict.desc }}</p>
      </div>
      <el-button v-if="renewable.length" type="primary" :loading="renewing" @click="renewAll">
        {{ renewing ? '正在续签…' : `一键续签 ${renewable.length} 个` }}
      </el-button>
    </section>

    <!-- ==================== 概览 ==================== -->
    <section class="kpi">
      <template v-if="loading">
        <div v-for="i in 4" :key="i" class="kpi__skeleton surface" />
      </template>
      <template v-else>
        <StatCard label="站点总数" :value="summary.total" unit="个" icon="Monitor" tone="neutral" hint="宝塔面板内的全部站点" />
        <StatCard label="已部署证书" :value="summary.withCert" unit="个" icon="Medal" tone="brand" :hint="`${summary.total - summary.withCert} 个站点未部署`" />
        <StatCard label="即将到期" :value="summary.expiring" unit="个" icon="Timer" :tone="summary.expiring ? 'warning' : 'neutral'" hint="剩余 15 天以内（与宝塔口径一致）" />
        <StatCard label="已过期" :value="summary.expired" unit="个" icon="Warning" :tone="summary.expired ? 'danger' : 'neutral'" hint="HTTPS 已失效，需立刻续签" />
      </template>
    </section>

    <!-- ==================== 工具条 ==================== -->
    <section class="surface toolbar">
      <div class="toolbar__left">
        <el-input
          v-model="keyword"
          class="toolbar__search"
          placeholder="搜索站点或域名"
          clearable
        >
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
        <el-checkbox v-model="onlyAttention">只看需要处理的</el-checkbox>
      </div>
      <div class="toolbar__right">
        <span class="toolbar__count tnum">共 <strong>{{ filtered.length }}</strong> 条</span>
        <el-button :loading="loading" @click="load">
          <el-icon><Refresh /></el-icon>刷新
        </el-button>
      </div>
    </section>

    <!-- ==================== 列表 ==================== -->
    <section class="surface">
      <StateBlock
        v-if="state === 'loading'"
        state="loading"
        loading-text="正在逐个站点读取证书（站点越多耗时越久）…"
      />
      <StateBlock
        v-else-if="state === 'error'"
        state="error"
        title="读取证书台账失败"
        :description="errorMessage"
        action-text="重试"
        @action="load"
      />
      <StateBlock
        v-else-if="state === 'empty'"
        state="empty"
        title="还没有可巡检的站点"
        description="先在「网站管理」创建站点并申请证书，这里会自动出现到期倒计时。"
        action-text="去网站管理"
        @action="$router.push('/websites')"
      />
      <StateBlock
        v-else-if="!filtered.length"
        state="empty"
        title="没有符合条件的证书"
        description="换个关键词，或取消「只看需要处理的」。"
        action-text="清空筛选"
        @action="clearFilter"
      />

      <template v-else>
        <!-- 窄屏：卡片 -->
        <ul v-if="isNarrow" class="cards">
          <li v-for="row in filtered" :key="row.siteName" class="card">
            <div class="card__head">
              <div class="card__title">
                <span class="copyable">
                  <span class="copyable__text">{{ row.siteName }}</span>
                  <CopyBtn :text="row.siteName" title="复制站点域名" ok-message="域名已复制" />
                </span>
                <span v-if="row.domains.length > 1" class="card__sub">
                  另有 {{ row.domains.length - 1 }} 个绑定域名
                </span>
              </div>
              <span class="pill" :class="`pill--${row.hasCert ? row.status : 'none'}`">{{ statusText(row) }}</span>
            </div>

            <div class="count">
              <strong class="count__num tnum" :class="`count__num--${row.hasCert ? row.status : 'none'}`">
                {{ remainText(row) }}
              </strong>
              <span class="count__unit">{{ remainUnit(row) }}</span>
            </div>
            <div v-if="row.hasCert" class="count__bar" role="img" :aria-label="`证书有效期已使用 ${lifespan(row)}%`">
              <span class="count__bar-fill" :class="`count__bar-fill--${row.status}`" :style="{ width: `${lifespan(row)}%` }" />
            </div>

            <dl class="card__meta">
              <div class="card__meta-row">
                <dt>签发机构</dt>
                <dd>{{ row.issuer || '—' }}</dd>
              </div>
              <div class="card__meta-row">
                <dt>有效期至</dt>
                <dd>{{ row.validToText || '—' }}</dd>
              </div>
            </dl>

            <div class="card__actions">
              <el-button @click="openDetail(row)">详情</el-button>
              <el-button type="primary" :loading="renewingSite === row.siteName" @click="renewOne(row)">续签</el-button>
            </div>
          </li>
        </ul>

        <!-- 宽屏：表格 -->
        <div v-else class="table-wrap">
          <el-table :data="filtered" row-key="siteName" style="width: 100%">
            <el-table-column label="站点 / 域名" min-width="210">
              <template #default="{ row }">
                <div class="cell-main">
                  <span class="copyable">
                    <strong class="cell-domain copyable__text">{{ row.siteName }}</strong>
                    <CopyBtn :text="row.siteName" title="复制站点域名" ok-message="域名已复制" />
                  </span>
                  <span v-if="row.domains.length > 1" class="muted-xs">
                    另有 {{ row.domains.length - 1 }} 个绑定域名
                  </span>
                </div>
              </template>
            </el-table-column>

            <el-table-column label="状态" width="112">
              <template #default="{ row }">
                <span class="pill" :class="`pill--${row.hasCert ? row.status : 'none'}`">{{ statusText(row) }}</span>
              </template>
            </el-table-column>

            <el-table-column label="剩余有效期" min-width="190">
              <template #default="{ row }">
                <div class="count">
                  <strong class="count__num tnum" :class="`count__num--${row.hasCert ? row.status : 'none'}`">
                    {{ remainText(row) }}
                  </strong>
                  <span class="count__unit">{{ remainUnit(row) }}</span>
                </div>
                <div v-if="row.hasCert" class="count__bar">
                  <span class="count__bar-fill" :class="`count__bar-fill--${row.status}`" :style="{ width: `${lifespan(row)}%` }" />
                </div>
              </template>
            </el-table-column>

            <el-table-column label="签发机构" width="120" show-overflow-tooltip>
              <template #default="{ row }">{{ row.issuer || '—' }}</template>
            </el-table-column>

            <el-table-column label="有效期至" width="180" show-overflow-tooltip>
              <template #default="{ row }">{{ row.validToText || '—' }}</template>
            </el-table-column>

            <el-table-column label="操作" width="170" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openDetail(row)">详情</el-button>
                <el-button link type="primary" :loading="renewingSite === row.siteName" @click="renewOne(row)">续签</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </template>
    </section>

    <!-- ==================== 证书详情 ==================== -->
    <el-drawer v-model="detailVisible" title="证书详情" size="420px">
      <template v-if="detail">
        <el-descriptions :column="1" border>
          <el-descriptions-item label="站点">{{ detail.siteName }}</el-descriptions-item>
          <el-descriptions-item label="覆盖域名">
            <span class="mono">{{ detail.domains.join('、') }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="状态">{{ statusText(detail) }}</el-descriptions-item>
          <el-descriptions-item label="签发机构">{{ detail.issuer || '—' }}</el-descriptions-item>
          <el-descriptions-item label="生效时间">{{ formatDate(detail.validFrom) }}</el-descriptions-item>
          <el-descriptions-item label="到期时间">{{ detail.validToText || '—' }}</el-descriptions-item>
          <el-descriptions-item label="剩余天数">{{ remainText(detail) }} {{ remainUnit(detail) }}</el-descriptions-item>
          <el-descriptions-item label="证书路径">
            <span class="mono">{{ detail.certPath || '—' }}</span>
          </el-descriptions-item>
        </el-descriptions>

        <div class="drawer-actions">
          <el-button type="primary" :loading="renewingSite === detail.siteName" @click="renewOne(detail)">
            <el-icon><RefreshRight /></el-icon>重新签发
          </el-button>
          <el-button @click="$router.push('/websites')">
            <el-icon><Monitor /></el-icon>去网站管理
          </el-button>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
// 深路径导入：不要改回 'element-plus'（barrel 入口会阻止 tree-shaking，详见 main.js）
import { ElMessage } from 'element-plus/es/components/message/index';
import { ElMessageBox } from 'element-plus/es/components/message-box/index';
import StatCard from '@/components/StatCard.vue';
import StateBlock from '@/components/StateBlock.vue';
import CopyBtn from '@/components/CopyBtn.vue';
import { useNarrow } from '@/composables/useNarrow';
import { websiteApi } from '@/api';

const loading = ref(true);
const state = ref('loading'); // loading | error | empty | ready
const errorMessage = ref('');
const certs = ref([]);
const summary = ref({ total: 0, withCert: 0, expiring: 0, expired: 0 });

const keyword = ref('');
const onlyAttention = ref(false);
const isNarrow = useNarrow(900);

/** 需要处理的站点（已过期或 15 天内到期） */
const attention = (row) => row.hasCert && (row.status === 'expired' || row.status === 'expiring');
const renewable = computed(() => certs.value.filter(attention));

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return certs.value.filter((row) => {
    if (onlyAttention.value && !attention(row)) return false;
    if (!kw) return true;
    return (
      row.siteName.toLowerCase().includes(kw) || row.domains.some((d) => String(d).toLowerCase().includes(kw))
    );
  });
});

/** 顶部巡检结论：一眼看清「要不要现在动手」 */
const verdict = computed(() => {
  const { expired, expiring, withCert, total } = summary.value;
  const noCert = total - withCert;
  if (expired > 0) {
    return {
      tone: 'danger',
      icon: 'Warning',
      title: `${expired} 个站点的证书已过期`,
      desc: '浏览器会直接拦截访问并提示不安全，建议立即续签。',
    };
  }
  if (expiring > 0) {
    return {
      tone: 'warning',
      icon: 'Timer',
      title: `${expiring} 个证书将在 15 天内到期`,
      desc: 'Let’s Encrypt 证书有效期 90 天，建议提前续签，避免访问中断。',
    };
  }
  if (total && noCert === total) {
    return {
      tone: 'neutral',
      icon: 'Medal',
      title: '还没有站点部署证书',
      desc: '去「网站管理」为站点申请免费的 Let’s Encrypt 证书即可启用 HTTPS。',
    };
  }
  return {
    tone: 'success',
    icon: 'CircleCheck',
    title: '全部证书状态正常',
    desc: '当前没有任何证书临近到期，保持自动巡检即可。',
  };
});

const STATUS_TEXT = { ok: '正常', expiring: '即将到期', expired: '已过期', none: '未部署' };
const statusText = (row) => (row.hasCert ? STATUS_TEXT[row.status] || '未知' : STATUS_TEXT.none);

/** 倒计时文案：与宝塔面板一致，直接给「剩余 N 天」 */
function remainText(row) {
  if (!row.hasCert) return '—';
  if (row.status === 'expired') return `过期 ${Math.abs(row.daysLeft)}`;
  return String(row.daysLeft);
}
function remainUnit(row) {
  return row.hasCert ? '天' : '';
}

/** 证书生命周期已消耗百分比（用于倒计时进度条） */
function lifespan(row) {
  if (!row.hasCert || !row.validFrom || !row.validTo) return 0;
  const from = new Date(row.validFrom).getTime();
  const to = new Date(row.validTo).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
  const used = ((Date.now() - from) / (to - from)) * 100;
  return Math.min(Math.max(Number(used.toFixed(1)), 0), 100);
}

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN');
}

async function load() {
  loading.value = true;
  state.value = 'loading';
  try {
    const data = await websiteApi.sslCerts();
    certs.value = data.certs || [];
    summary.value = {
      total: data.total || 0,
      withCert: data.withCert || 0,
      expiring: data.expiring || 0,
      expired: data.expired || 0,
    };
    state.value = certs.value.length ? 'ready' : 'empty';
  } catch (err) {
    errorMessage.value = err.message || '未知错误';
    state.value = 'error';
  } finally {
    loading.value = false;
  }
}

function clearFilter() {
  keyword.value = '';
  onlyAttention.value = false;
}

// ---------------- 续签 ----------------
const renewing = ref(false);
const renewingSite = ref('');

async function runRenew(sites) {
  const data = await websiteApi.renewSsl(sites);
  const failed = (data.results || []).filter((r) => !r.ok);
  if (failed.length) {
    ElMessage.warning(`续签完成：成功 ${data.okCount} 个，失败 ${failed.length} 个（${failed.map((f) => f.siteName).join('、')}）`);
  } else {
    ElMessage.success(`续签完成：${data.okCount} 个证书已重新签发`);
  }
  await load();
}

async function renewOne(row) {
  renewingSite.value = row.siteName;
  try {
    await runRenew([row.siteName]);
  } catch {
    /* 拦截器已提示 */
  } finally {
    renewingSite.value = '';
  }
}

async function renewAll() {
  const sites = renewable.value.map((r) => r.siteName).slice(0, 10);
  if (!sites.length) return;

  // 这台服务器是共享的，其他项目也挂着自己的证书。
  // 批量续签属于「一次影响多个站点」的操作，动手前必须把清单摊开给用户看。
  try {
    await ElMessageBox.confirm(
      `将依次重新签发以下 ${sites.length} 个站点的证书：\n\n${sites.join('\n')}\n\n` +
        '这些站点可能包含其他项目名下站点，请确认清单无误再继续。',
      '批量续签确认',
      {
        confirmButtonText: '确认续签',
        cancelButtonText: '取消',
        type: 'warning',
        customClass: 'renew-confirm-box',
      }
    );
  } catch {
    return;
  }

  renewing.value = true;
  try {
    await runRenew(sites);
    if (renewable.value.length > sites.length) {
      ElMessage.info(`本次续签了前 ${sites.length} 个，其余请再次点击续签`);
    }
  } catch {
    /* 拦截器已提示 */
  } finally {
    renewing.value = false;
  }
}

// ---------------- 详情 ----------------
const detailVisible = ref(false);
const detail = ref(null);

function openDetail(row) {
  detail.value = row;
  detailVisible.value = true;
}

onMounted(load);
</script>

<style scoped>
/* ---------------- 巡检结论 ---------------- */
.verdict {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  flex-wrap: wrap;
  padding: var(--sp-4) var(--sp-5);
  background: var(--bg-surface);
  border: 1px solid var(--border-hairline);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-md);
  border-left: 2px solid var(--tone, var(--brand));
}

.verdict--success {
  --tone: var(--success);
}
.verdict--warning {
  --tone: var(--warning);
}
.verdict--danger {
  --tone: var(--danger);
}
.verdict--neutral {
  --tone: var(--text-tertiary);
}

.verdict__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--tone) 12%, transparent);
  color: var(--tone);
  font-size: 19px;
}

.verdict__text {
  flex: 1;
  min-width: 200px;
}

.verdict__text strong {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-primary);
}

.verdict__text p {
  margin-top: 2px;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-secondary);
}

/* ---------------- KPI ---------------- */
.kpi {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--sp-4);
}

.kpi__skeleton {
  height: 124px;
  border-radius: var(--r-lg);
  background: linear-gradient(90deg, var(--bg-subtle) 25%, var(--bg-hover) 37%, var(--bg-subtle) 63%);
  background-size: 400% 100%;
  animation: kpi-scan 1.5s var(--ease) infinite;
  box-shadow: none;
}

@keyframes kpi-scan {
  0% {
    background-position: 100% 50%;
  }
  100% {
    background-position: 0 50%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .kpi__skeleton {
    background: var(--bg-subtle);
  }
}

/* ---------------- 工具条 ---------------- */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
  flex-wrap: wrap;
  padding: var(--sp-4) var(--sp-5);
}

.toolbar__left,
.toolbar__right {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
}

.toolbar__search {
  width: 240px;
}

.toolbar__count {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

.toolbar__count strong {
  color: var(--text-primary);
}

/* ---------------- 倒计时 ---------------- */
.count {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.count__num {
  font-size: var(--fs-xl);
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--text-primary);
}

.count__num--ok {
  color: var(--success);
}
.count__num--expiring {
  color: var(--warning);
}
.count__num--expired {
  color: var(--danger);
}
.count__num--none {
  color: var(--text-tertiary);
}

.count__unit {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}

.count__bar {
  margin-top: 6px;
  height: 4px;
  border-radius: var(--r-full);
  background: var(--bg-subtle);
  overflow: hidden;
}

.count__bar-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--success);
  transition: width var(--dur-card) var(--ease);
}

.count__bar-fill--expiring {
  background: var(--warning);
}
.count__bar-fill--expired {
  background: var(--danger);
}

/* ---------------- 单元格 ---------------- */
.cell-main {
  display: flex;
  flex-direction: column;
}

.cell-domain {
  font-weight: 500;
  color: var(--text-primary);
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 8px;
  border-radius: var(--r-full);
  font-size: var(--fs-xs);
  font-weight: 500;
  line-height: 19px;
  white-space: nowrap;
}

.pill::before {
  content: '';
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}

.pill--ok {
  background: var(--success-soft);
  color: var(--success);
}
.pill--expiring {
  background: var(--warning-soft);
  color: var(--warning);
}
.pill--expired {
  background: var(--danger-soft);
  color: var(--danger);
}
.pill--none {
  background: var(--bg-subtle);
  color: var(--text-tertiary);
}

/* ---------------- 抽屉 ---------------- */
.drawer-actions {
  display: flex;
  gap: var(--sp-3);
  margin-top: var(--sp-5);
  padding-top: var(--sp-4);
  border-top: 1px solid var(--border-hairline);
}

/* ---------------- 响应式 ---------------- */
@media (max-width: 1280px) {
  .kpi {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 768px) {
  .kpi {
    grid-template-columns: minmax(0, 1fr);
  }

  .toolbar__search {
    width: 100%;
  }

  .toolbar__left,
  .toolbar__right {
    width: 100%;
  }

  .toolbar__right {
    justify-content: space-between;
  }

  .verdict {
    padding: var(--sp-4);
  }

  .drawer-actions {
    flex-direction: column;
  }

  .drawer-actions :deep(.el-button) {
    width: 100%;
  }
}
</style>

<style>
/* ElMessageBox 的内容挂到 body 上，scoped 样式够不到，必须写成非 scoped。
   续签确认框里是一列站点清单，必须保留换行，否则会挤成一整段读不了。 */
.renew-confirm-box .el-message-box__message {
  max-height: 46vh;
  overflow-y: auto;
}

.renew-confirm-box .el-message-box__message p {
  white-space: pre-line;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
</style>
