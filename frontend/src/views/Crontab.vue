<template>
  <div class="page">
    <!-- ==================== 工具条 ==================== -->
    <section class="surface toolbar">
      <div class="toolbar__left">
        <el-icon class="toolbar__icon"><Timer /></el-icon>
        <span class="toolbar__name">服务器计划任务</span>
        <span v-if="data" class="toolbar__meta">
          共 {{ data.total }} 个 · 启用 {{ data.enabledCount }} · 停用 {{ data.disabledCount }}
        </span>
      </div>
      <div class="toolbar__right">
        <span v-if="lastLoadedAt" class="muted-xs">{{ relTime(lastLoadedAt) }}刷新</span>
        <el-button :loading="loading" @click="load">
          <el-icon><Refresh /></el-icon>刷新
        </el-button>
      </div>
    </section>

    <!-- ==================== 归属说明（这块是「只报告」的全部理由） ==================== -->
    <section class="surface notice">
      <el-icon class="notice__icon"><InfoFilled /></el-icon>
      <div class="notice__body">
        <p class="notice__title">这里的任务属于整台服务器，绝大多数不是本项目的</p>
        <p class="notice__desc">
          工作台自己的定时清理（资源采样、日志保留、告警清理）跑在后端进程里，<strong>不在这个清单里</strong>。其余任务一律<strong>只报告</strong>：不提供启停或删除
          ——
          它们分属服务器上其他项目，动了就是动别人的东西。出于同样原因，这里也<strong>不展示脚本正文</strong>（别人的脚本里有明文密钥），要看请去宝塔面板。
        </p>
      </div>
    </section>

    <!-- ==================== 状态：加载中 / 失败 ==================== -->
    <section v-if="state === 'loading'" class="surface">
      <StateBlock state="loading" loading-text="正在读取计划任务…" />
    </section>

    <section v-else-if="state === 'error'" class="surface">
      <StateBlock
        state="error"
        title="读取失败"
        :description="errorMsg"
        action-text="重试"
        @action="load"
      />
    </section>

    <template v-else-if="state === 'ready'">
      <!-- ==================== 概览 ==================== -->
      <div class="stats">
        <StatCard
          label="任务总数"
          :value="data.total"
          icon="Timer"
          tone="brand"
          :hint="`本项目 ${data.ownCount} 个 · 其他项目 ${data.foreignCount} 个`"
        />
        <StatCard
          label="启用中"
          :value="data.enabledCount"
          icon="VideoPlay"
          tone="success"
          :hint="`另有 ${data.disabledCount} 个已停用`"
        />
        <StatCard
          label="执行标记为 0"
          :value="data.abnormalCount"
          icon="Warning"
          :tone="data.abnormalCount ? 'warning' : 'neutral'"
          hint="宝塔只给 0/1、含义没有官方说明，值当「值得看一眼」，确认要回面板看日志"
        />
        <StatCard
          label="疑似排障遗留"
          :value="data.legacyCount"
          icon="Filter"
          :tone="data.legacyCount ? 'warning' : 'neutral'"
          hint="名字像当时排障临时留下的，却还挂在周期上跑"
        />
      </div>

      <!-- ==================== 筛选 ==================== -->
      <section class="surface filters">
        <el-input
          v-model="keyword"
          class="filters__search"
          placeholder="按名称搜索"
          clearable
          aria-label="按名称搜索计划任务"
        >
          <template #prefix
            ><el-icon><Search /></el-icon
          ></template>
        </el-input>

        <el-radio-group v-model="owner" size="default">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="own">本项目</el-radio-button>
          <el-radio-button value="foreign">其他项目</el-radio-button>
        </el-radio-group>

        <el-checkbox v-model="legacyOnly">只看疑似遗留</el-checkbox>

        <span class="filters__count tnum">{{ filtered.length }} / {{ data.total }}</span>
      </section>

      <!-- ==================== 任务列表 ==================== -->
      <div v-if="filtered.length" class="tasks">
        <article v-for="t in filtered" :key="t.id" class="surface task">
          <div class="task__main">
            <h3 class="task__name">{{ t.name || '（未命名任务）' }}</h3>
            <p class="task__cycle">{{ t.cycle || '周期未知' }}</p>
          </div>

          <div class="task__meta">
            <span v-if="t.execType" class="chip">{{ execText(t.execType) }}</span>
            <span v-if="t.runAs" class="chip chip--quiet">以 {{ t.runAs }} 运行</span>
            <span class="chip" :class="t.enabled ? 'chip--on' : 'chip--off'">
              {{ t.enabled ? '启用中' : '已停用' }}
            </span>
            <span v-if="t.resultCode === 0" class="chip chip--warn">执行标记 0</span>
          </div>

          <div class="task__side">
            <span class="owner" :class="`owner--${t.owner}`">
              {{ t.owner === 'own' ? '本项目' : '其他项目 · 仅报告' }}
            </span>
            <span v-if="t.legacyHint" class="legacy" :title="t.legacyHint">疑似遗留</span>
          </div>
        </article>
      </div>

      <!-- 正常有数据、但当前筛选筛不到 —— 与「一个任务都没有」是两回事，分开说 -->
      <section v-else class="surface">
        <StateBlock
          state="empty"
          title="按当前条件没筛到任务"
          description="换个关键词，或把归属切回「全部」。上面的数字仍是全服务器的真实统计。"
          action-text="清空筛选"
          @action="resetFilters"
        />
      </section>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import StateBlock from '@/components/StateBlock.vue';
import StatCard from '@/components/StatCard.vue';
import { crontabApi } from '@/api';

// loading | error | ready
// 注意：**没有 empty 状态** —— 服务器上只要装了宝塔就会自带任务，
// 而且「筛不到」与「一个都没有」在后端返回里能区分（total 与 filtered），
// 所以这两种情况在模板里分开表达，不合并成一个空状态。
const state = ref('loading');
const errorMsg = ref('');
const loading = ref(false);
const data = ref(null);
const lastLoadedAt = ref(null);

// ---------------- 筛选 ----------------
const keyword = ref('');
const owner = ref('all'); // all | own | foreign
const legacyOnly = ref(false);

const filtered = computed(() => {
  const list = data.value?.tasks || [];
  const kw = keyword.value.trim().toLowerCase();
  return list.filter((t) => {
    if (owner.value !== 'all' && t.owner !== owner.value) return false;
    if (legacyOnly.value && !t.legacyHint) return false;
    if (
      kw &&
      !String(t.name || '')
        .toLowerCase()
        .includes(kw)
    )
      return false;
    return true;
  });
});

function resetFilters() {
  keyword.value = '';
  owner.value = 'all';
  legacyOnly.value = false;
}

/**
 * 执行方式标签。后端已经把「调度间隔」（minute-n 之类）从 execType 里剔掉了，
 * 能到这里的只有真·执行方式；映射表与后端 services/baota.js 的
 * CRONTAB_EXEC_TYPES 保持一致，认不出来的原样显示（不丢信息）。
 */
function execText(sType) {
  const map = { toShell: 'Shell 脚本', shell: 'Shell 脚本', url: '访问 URL' };
  return map[sType] || sType;
}

function relTime(input) {
  const value = new Date(input).getTime();
  if (!Number.isFinite(value)) return '刚刚';
  const diffMin = Math.floor((Date.now() - value) / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const hours = Math.floor(diffMin / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

async function load() {
  loading.value = true;
  // 刷新时保留旧内容（不闪回骨架），只有首次才显示 loading 态
  if (!data.value) state.value = 'loading';
  try {
    data.value = await crontabApi.list();
    lastLoadedAt.value = new Date();
    state.value = 'ready';
  } catch (err) {
    errorMsg.value = err.message || '未知错误';
    state.value = 'error';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
/* ---------------- 工具条 ---------------- */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
  flex-wrap: wrap;
  padding: var(--sp-3) var(--sp-5);
}

.toolbar__left,
.toolbar__right {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-width: 0;
  flex-wrap: wrap;
}

.toolbar__icon {
  color: var(--brand);
}

.toolbar__name {
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text-primary);
}

.toolbar__meta {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}

/* ---------------- 归属说明 ---------------- */
.notice {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: var(--sp-4) var(--sp-5);
  background: var(--info-soft);
  border-color: color-mix(in srgb, var(--info) 20%, transparent);
}

.notice__icon {
  margin-top: 2px;
  flex: 0 0 auto;
  color: var(--info);
}

.notice__body {
  flex: 1;
  min-width: 0;
}

.notice__title {
  font-size: var(--fs-sm);
  font-weight: 500;
  color: var(--text-primary);
}

.notice__desc {
  margin-top: var(--sp-1);
  font-size: var(--fs-xs);
  line-height: 1.8;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.notice__desc strong {
  font-weight: 600;
  color: var(--text-primary);
}

/* ---------------- 概览 ---------------- */
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));
  gap: var(--sp-4);
}

/* ---------------- 筛选 ---------------- */
.filters {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
  padding: var(--sp-3) var(--sp-5);
}

.filters__search {
  width: 240px;
  max-width: 100%;
}

.filters__count {
  margin-left: auto;
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}

/* ---------------- 任务行卡 ---------------- */
.tasks {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.task {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, auto) auto;
  align-items: center;
  gap: var(--sp-3) var(--sp-5);
  padding: var(--sp-3) var(--sp-5);
  transition: box-shadow var(--dur-card) var(--ease);
}

.task:hover {
  box-shadow: var(--shadow-md);
}

.task__main {
  min-width: 0;
}

.task__name {
  font-size: var(--fs-sm);
  font-weight: 500;
  color: var(--text-primary);
  /* 任务名可能是长中文串，别把行卡撑破 */
  overflow-wrap: anywhere;
}

.task__cycle {
  margin-top: 2px;
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.task__meta {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}

.chip {
  display: inline-flex;
  align-items: center;
  padding: 2px var(--sp-2);
  border-radius: var(--r-xs);
  border: 1px solid var(--border-hairline);
  background: var(--bg-subtle);
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.chip--quiet {
  color: var(--text-tertiary);
}

.chip--on {
  border-color: color-mix(in srgb, var(--success) 28%, transparent);
  background: var(--success-soft);
  color: color-mix(in srgb, var(--success) 78%, var(--text-primary));
}

.chip--off {
  color: var(--text-tertiary);
}

.chip--warn {
  border-color: color-mix(in srgb, var(--warning) 30%, transparent);
  background: var(--warning-soft);
  color: color-mix(in srgb, var(--warning) 80%, var(--text-primary));
}

.task__side {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  justify-content: flex-end;
}

.owner {
  display: inline-flex;
  align-items: center;
  padding: 2px var(--sp-2);
  border-radius: var(--r-xs);
  font-size: 11px;
  white-space: nowrap;
}

.owner--own {
  border: 1px solid color-mix(in srgb, var(--brand) 30%, transparent);
  background: var(--brand-soft);
  color: color-mix(in srgb, var(--brand) 80%, var(--text-primary));
}

.owner--foreign {
  border: 1px solid var(--border-hairline);
  background: var(--bg-subtle);
  color: var(--text-tertiary);
}

.legacy {
  padding: 2px var(--sp-2);
  border-radius: var(--r-xs);
  border: 1px dashed color-mix(in srgb, var(--warning) 40%, transparent);
  font-size: 11px;
  color: color-mix(in srgb, var(--warning) 80%, var(--text-primary));
  white-space: nowrap;
}

/* ---------------- 窄屏 ---------------- */
@media (max-width: 900px) {
  .toolbar,
  .notice,
  .filters,
  .task {
    padding-left: var(--sp-4);
    padding-right: var(--sp-4);
  }

  /* 一行放不下三列：名称占一行，标签与归属各占一行 —— 不横向挤压 */
  .task {
    grid-template-columns: minmax(0, 1fr);
  }

  .task__side {
    justify-content: flex-start;
  }

  .filters__search {
    width: 100%;
  }

  .filters__count {
    margin-left: 0;
  }
}
</style>
