<template>
  <div class="page">
    <!-- ==================== 工具条：切仓库 / 刷新 / 数据新鲜度 ==================== -->
    <section class="surface toolbar">
      <div class="toolbar__left">
        <!-- 多仓库时给一排切换片；只有一个仓库就直接显示名字，不做无意义的"单选" -->
        <div v-if="healthyRepos.length > 1" class="switcher">
          <button
            v-for="r in healthyRepos"
            :key="r.fullName"
            class="switcher__item"
            :class="{ 'is-active': r.fullName === activeFull }"
            @click="switchRepo(r.fullName)"
          >
            {{ r.name || r.fullName }}
          </button>
        </div>
        <div v-else class="toolbar__title">
          <el-icon class="toolbar__icon"><FolderOpened /></el-icon>
          <span class="toolbar__name mono">{{ activeFull || '未配置仓库' }}</span>
        </div>

        <!-- 有仓库读不到时单独点出来，而不是整页失败 -->
        <span v-if="brokenRepos.length" class="toolbar__broken">
          {{ brokenRepos.length }} 个仓库读取失败（{{
            brokenRepos.map((r) => r.fullName).join('、')
          }}）
        </span>
      </div>

      <div class="toolbar__right">
        <span v-if="lastLoadedAt" class="muted-xs">
          {{ relTime(lastLoadedAt) }}刷新 · 数据缓存 {{ config.cacheTtlSeconds || 60 }} 秒
        </span>
        <el-button :loading="loading" @click="loadAll">
          <el-icon><Refresh /></el-icon>刷新
        </el-button>
      </div>
    </section>

    <!-- ==================== 配额提醒（只在匿名时出现） ==================== -->
    <section v-if="state === 'ready' && !config.authenticated" class="surface notice">
      <el-icon class="notice__icon"><WarningFilled /></el-icon>
      <div class="notice__body">
        <p class="notice__title">当前是匿名访问：GitHub 只给 60 次接口调用 / 小时</p>
        <p class="notice__desc">
          这个额度是按服务器出口 IP 算的，刷新十几次就会用完。<span class="notice__key"
            >到「系统设置 → 代码仓库」填一个只读令牌，可提升到 5000 次 / 小时。</span
          >
        </p>
      </div>
      <span v-if="rateLimit" class="notice__badge tnum">
        剩余 {{ rateLimit.remaining }} / {{ rateLimit.limit }}
      </span>
    </section>

    <!-- ==================== 加载 / 失败 / 未配置 ==================== -->
    <section v-if="state === 'loading'" class="surface">
      <StateBlock state="loading" loading-text="正在读取仓库数据…" />
    </section>

    <section v-else-if="state === 'error'" class="surface">
      <StateBlock
        state="error"
        title="读取仓库数据失败"
        :description="errorMsg"
        action-text="重试"
        @action="loadAll"
      />
    </section>

    <section v-else-if="state === 'empty'" class="surface">
      <StateBlock
        state="empty"
        title="还没有配置要看的仓库"
        description="到「系统设置 → 代码仓库」填写要关注的仓库（格式 owner/repo），填完回到这里就能看到提交与 CI 状态。"
        :action-text="auth.isAdmin ? '去系统设置' : ''"
        @action="goSettings"
      />
    </section>

    <!-- ==================== 正常内容 ==================== -->
    <template v-else-if="state === 'ready' && detail">
      <!-- 仓库身份条 -->
      <section class="surface repo-head">
        <div class="repo-head__main">
          <h2 class="repo-head__name">{{ detail.repo.fullName }}</h2>
          <p class="repo-head__desc">{{ detail.repo.description || '这个仓库还没有填写简介' }}</p>
          <ul class="repo-head__meta">
            <li>
              <span class="repo-head__k">默认分支</span>
              <span class="mono">{{ detail.repo.defaultBranch }}</span>
            </li>
            <li>
              <span class="repo-head__k">最近推送</span>
              <span>{{ relTime(detail.repo.pushedAt) }}</span>
            </li>
            <li>
              <span class="repo-head__k">开放 Issue</span>
              <span class="tnum">{{ detail.repo.openIssues }}</span>
            </li>
          </ul>
        </div>
        <a class="repo-head__link" :href="detail.repo.htmlUrl" target="_blank" rel="noopener">
          在 GitHub 打开
          <el-icon><Link /></el-icon>
        </a>
      </section>

      <!-- CI 现状：整页最该先看到的东西 -->
      <section class="surface ci">
        <header class="sec-head">
          <h3 class="sec-head__title">持续集成（GitHub Actions）</h3>
          <span class="muted-xs">最近 {{ detail.runs.length }} 次运行</span>
        </header>

        <div v-if="!detail.runs.length" class="inline-empty">这个仓库还没有 Actions 运行记录。</div>

        <template v-else>
          <!-- 最新一次：放大结论，失败要一眼看见 -->
          <div class="ci-latest" :class="`ci-latest--${latestTone}`">
            <span class="ci-latest__glyph">
              <el-icon>
                <component
                  :is="
                    latestTone === 'success'
                      ? 'CircleCheck'
                      : latestTone === 'danger'
                        ? 'CircleCloseFilled'
                        : 'Timer'
                  "
                />
              </el-icon>
            </span>
            <div class="ci-latest__body">
              <p class="ci-latest__verdict">{{ latestText }}</p>
              <p class="ci-latest__sub">
                {{ latest.name }} · {{ latest.branch }} · {{ latest.event || 'manual' }}
                <span v-if="latest.durationSeconds !== null">
                  · 耗时 {{ durText(latest.durationSeconds) }}</span
                >
              </p>
            </div>
            <a class="run-link" :href="latest.htmlUrl" target="_blank" rel="noopener">
              #{{ latest.runNumber }}<el-icon><Link /></el-icon>
            </a>
          </div>

          <!-- 其余运行：紧凑列表 -->
          <ul v-if="detail.runs.length > 1" class="runs">
            <li v-for="run in detail.runs.slice(1)" :key="run.id" class="runs__item">
              <span class="dot" :class="`dot--${toneOf(run)}`" />
              <span class="runs__name">{{ run.name }}</span>
              <span class="runs__branch mono">{{ run.branch }}</span>
              <span class="runs__result">{{ textOf(run) }}</span>
              <span class="runs__time muted-xs">{{ relTime(run.createdAt) }}</span>
              <a class="run-link" :href="run.htmlUrl" target="_blank" rel="noopener">
                <el-icon><Link /></el-icon>
              </a>
            </li>
          </ul>
        </template>
      </section>

      <!-- 提交 / 待办：两栏，信息量对得上 -->
      <div class="cols">
        <section class="surface">
          <header class="sec-head">
            <h3 class="sec-head__title">最近提交</h3>
            <span class="muted-xs">{{ detail.commits.length }} 条</span>
          </header>

          <div v-if="!detail.commits.length" class="inline-empty">还没有提交记录。</div>

          <ul v-else class="commits">
            <li v-for="c in detail.commits" :key="c.sha" class="commits__item">
              <img
                v-if="c.avatar"
                class="commits__avatar"
                :src="c.avatar"
                :alt="c.author"
                loading="lazy"
              />
              <span v-else class="commits__avatar commits__avatar--ph">{{
                c.author.slice(0, 1)
              }}</span>
              <div class="commits__body">
                <p class="commits__msg">{{ c.message }}</p>
                <p class="commits__meta">
                  <span class="mono">{{ c.shortSha }}</span>
                  · {{ c.author }} · {{ relTime(c.date) }}
                </p>
              </div>
              <a class="run-link" :href="c.htmlUrl" target="_blank" rel="noopener">
                <el-icon><Link /></el-icon>
              </a>
            </li>
          </ul>
        </section>

        <section class="surface">
          <header class="sec-head">
            <h3 class="sec-head__title">待处理</h3>
            <span class="muted-xs">
              {{ detail.pulls.length }} 个 PR · {{ detail.issues.length }} 个 Issue
            </span>
          </header>

          <div v-if="!detail.pulls.length && !detail.issues.length" class="inline-empty">
            没有开放中的 Issue 和 PR，很干净。
          </div>

          <ul v-else class="todos">
            <li
              v-for="item in pendingItems"
              :key="`${item.kind}-${item.number}`"
              class="todos__item"
            >
              <span class="todos__kind" :class="`todos__kind--${item.kind}`">
                {{ item.kind === 'pull' ? 'PR' : 'ISSUE' }}
              </span>
              <div class="todos__body">
                <p class="todos__title">{{ item.title }}</p>
                <p class="todos__meta">
                  #{{ item.number }} · {{ item.user }} · {{ relTime(item.updatedAt) }}
                  <span v-if="item.draft" class="todos__draft">草稿</span>
                </p>
                <ul v-if="item.labels.length" class="todos__labels">
                  <li v-for="label in item.labels" :key="label">{{ label }}</li>
                </ul>
              </div>
              <a class="run-link" :href="item.htmlUrl" target="_blank" rel="noopener">
                <el-icon><Link /></el-icon>
              </a>
            </li>
          </ul>
        </section>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
// 深路径导入：不要改回 'element-plus'（barrel 入口会阻止 tree-shaking，详见 main.js）
import { ElMessage } from 'element-plus/es/components/message/index';
import StateBlock from '@/components/StateBlock.vue';
import { repoApi } from '@/api';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();

const state = ref('loading'); // loading | error | ready | empty
const errorMsg = ref('');
const loading = ref(false);
const repos = ref([]);
const activeFull = ref('');
const detail = ref(null);
const config = ref({ authenticated: false, cacheTtlSeconds: 60 });
const lastLoadedAt = ref(null);

const healthyRepos = computed(() => repos.value.filter((r) => !r.error));
const brokenRepos = computed(() => repos.value.filter((r) => r.error));
const rateLimit = computed(() => detail.value?.rateLimit || null);

// ---------------- 文案映射 ----------------
const TEXT_OF_CONCLUSION = {
  success: '通过',
  failure: '失败',
  cancelled: '被取消',
  skipped: '被跳过',
  timed_out: '超时',
  action_required: '需要处理',
  startup_failure: '启动失败',
  neutral: '中性结果',
};

/** PR 在前（更需要处理），Issue 在后；各自按更新时间已排好 */
const pendingItems = computed(() => {
  if (!detail.value) return [];
  return [...detail.value.pulls, ...detail.value.issues];
});

const latest = computed(() => detail.value?.runs?.[0] || null);

const latestTone = computed(() => (latest.value ? toneOf(latest.value) : 'pending'));

const latestText = computed(() => {
  const run = latest.value;
  if (!run) return '';
  if (run.status !== 'completed') return '正在运行中';
  if (run.conclusion === 'success') return '最新一次通过';
  return `最新一次${TEXT_OF_CONCLUSION[run.conclusion] || '结果未知'}`;
});

function toneOf(run) {
  if (!run || run.status !== 'completed') return 'pending';
  return run.conclusion === 'success' ? 'success' : 'danger';
}

function textOf(run) {
  if (!run) return '';
  if (run.status !== 'completed') return run.status === 'queued' ? '排队中' : '运行中';
  return TEXT_OF_CONCLUSION[run.conclusion] || run.conclusion || '未知';
}

/** 相对时间：仓库页看的是「多久以前」，绝对时间反而要心算 */
function relTime(input) {
  if (!input) return '未知';
  const value = input instanceof Date ? input.getTime() : new Date(input).getTime();
  if (!Number.isFinite(value)) return '未知';
  const diffMin = Math.floor((Date.now() - value) / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const hours = Math.floor(diffMin / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(value).toLocaleDateString('zh-CN');
}

function durText(seconds) {
  if (seconds === null || seconds === undefined) return '';
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
}

// ---------------- 加载 ----------------
async function loadDetail(full) {
  const [owner, repo] = String(full).split('/');
  detail.value = await repoApi.detail(owner, repo);
  lastLoadedAt.value = new Date();
}

async function loadAll() {
  loading.value = true;
  state.value = 'loading';
  try {
    config.value = await repoApi.config();
    const data = await repoApi.list();
    repos.value = data.list || [];
    if (!repos.value.length) {
      state.value = 'empty';
      return;
    }

    // 保持当前选中的仓库；它要是被删了/改名了，就退回第一个能读的
    const stillThere = healthyRepos.value.some((r) => r.fullName === activeFull.value);
    const target = stillThere ? activeFull.value : healthyRepos.value[0]?.fullName;
    if (!target) {
      errorMsg.value = brokenRepos.value[0]?.error || '所有仓库都读取失败';
      state.value = 'error';
      return;
    }

    activeFull.value = target;
    await loadDetail(target);
    state.value = 'ready';
  } catch (err) {
    errorMsg.value = err.message || '未知错误';
    state.value = 'error';
  } finally {
    loading.value = false;
  }
}

async function switchRepo(full) {
  if (full === activeFull.value || loading.value) return;
  activeFull.value = full;
  loading.value = true;
  try {
    await loadDetail(full);
  } catch (err) {
    ElMessage.error(err.message || '切换仓库失败');
    // 切不过去就退回原来那个，别让页面停在半空
    activeFull.value = detail.value?.repo?.fullName || healthyRepos.value[0]?.fullName || '';
  } finally {
    loading.value = false;
  }
}

function goSettings() {
  if (auth.isAdmin) window.location.hash = '#/settings';
}

onMounted(loadAll);
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

.toolbar__title {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

.toolbar__icon {
  color: var(--brand);
}

.toolbar__name {
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.toolbar__broken {
  font-size: var(--fs-xs);
  color: var(--danger);
  overflow-wrap: anywhere;
}

/* 仓库切换片 */
.switcher {
  display: flex;
  gap: var(--sp-1);
  padding: 3px;
  border-radius: var(--r-md);
  background: var(--bg-subtle);
  overflow-x: auto;
  max-width: 100%;
}

.switcher__item {
  flex: 0 0 auto;
  min-height: 30px;
  padding: 0 var(--sp-3);
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  cursor: pointer;
  transition:
    background-color var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.switcher__item:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.switcher__item.is-active {
  background: var(--bg-surface);
  color: var(--brand);
  font-weight: 500;
  box-shadow: var(--shadow-sm);
}

/* ---------------- 匿名配额提醒 ---------------- */
.notice {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: var(--sp-4) var(--sp-5);
  background: var(--warning-soft);
  border-color: color-mix(in srgb, var(--warning) 22%, transparent);
}

.notice__icon {
  margin-top: 2px;
  color: var(--warning);
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
  margin-top: 2px;
  font-size: var(--fs-xs);
  line-height: 1.65;
  color: var(--text-secondary);
}

.notice__key {
  color: var(--text-primary);
}

.notice__badge {
  flex: 0 0 auto;
  font-size: var(--fs-xs);
  color: var(--warning);
}

/* ---------------- 仓库身份条 ---------------- */
.repo-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-4);
  flex-wrap: wrap;
  padding: var(--sp-5);
}

.repo-head__main {
  min-width: 0;
}

.repo-head__name {
  font-size: var(--fs-xl);
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.repo-head__desc {
  margin-top: var(--sp-1);
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-secondary);
}

.repo-head__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-5);
  margin: var(--sp-4) 0 0;
  padding: 0;
  list-style: none;
}

.repo-head__meta li {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.repo-head__k {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}

.repo-head__link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  /* 与 AppStore 的 tpl__doc 一致：文字链在手机上也要给足 44px 点击高度 */
  min-height: 44px;
  padding: 0 var(--sp-3);
  border: 1px solid var(--border-hairline);
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  transition:
    color var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease),
    background-color var(--dur-fast) var(--ease);
}

.repo-head__link:hover {
  color: var(--brand);
  border-color: var(--brand-soft-border);
  background: var(--brand-soft);
}

/* ---------------- 区块标题 ---------------- */
.sec-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-4) var(--sp-5);
  border-bottom: 1px solid var(--border-hairline);
}

.sec-head__title {
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text-primary);
}

.inline-empty {
  padding: var(--sp-5);
  font-size: var(--fs-sm);
  color: var(--text-tertiary);
}

/* ---------------- CI 现状 ---------------- */
.ci-latest {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin: var(--sp-4) var(--sp-5);
  padding: var(--sp-4);
  border-radius: var(--r-md);
  border: 1px solid var(--border-hairline);
  background: var(--bg-subtle);
}

.ci-latest--success {
  background: var(--success-soft);
  border-color: color-mix(in srgb, var(--success) 22%, transparent);
}

.ci-latest--danger {
  background: var(--danger-soft);
  border-color: color-mix(in srgb, var(--danger) 22%, transparent);
}

.ci-latest--pending {
  background: var(--info-soft);
  border-color: color-mix(in srgb, var(--info) 20%, transparent);
}

.ci-latest__glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  border-radius: 50%;
  font-size: 16px;
  background: var(--bg-surface);
  color: var(--text-secondary);
}

.ci-latest--success .ci-latest__glyph {
  color: var(--success);
}

.ci-latest--danger .ci-latest__glyph {
  color: var(--danger);
}

.ci-latest--pending .ci-latest__glyph {
  color: var(--info);
}

.ci-latest__body {
  flex: 1;
  min-width: 0;
}

.ci-latest__verdict {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-primary);
}

.ci-latest--danger .ci-latest__verdict {
  color: var(--danger);
}

.ci-latest__sub {
  margin-top: 2px;
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

/* 其余运行 */
.runs {
  margin: 0;
  padding: 0 var(--sp-5) var(--sp-3);
  list-style: none;
}

.runs__item {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) 0;
  border-top: 1px solid var(--border-hairline);
}

.runs__name {
  font-size: var(--fs-sm);
  color: var(--text-primary);
  min-width: 0;
}

.runs__branch {
  color: var(--text-tertiary);
  overflow-wrap: anywhere;
}

.runs__result {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
}

.runs__time {
  margin-left: auto;
  white-space: nowrap;
}

.dot {
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: 50%;
  background: var(--text-tertiary);
}

.dot--success {
  background: var(--success);
}

.dot--danger {
  background: var(--danger);
}

.dot--pending {
  background: var(--info);
}

/* ---------------- 两栏 ---------------- */
.cols {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(380px, 100%), 1fr));
  gap: var(--sp-5);
  align-items: start;
}

/* ---------------- 提交列表 ---------------- */
.commits {
  margin: 0;
  padding: 0;
  list-style: none;
}

.commits__item {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-5);
  border-bottom: 1px solid var(--border-hairline);
  transition: background-color var(--dur-fast) var(--ease);
}

.commits__item:last-child {
  border-bottom: none;
}

.commits__item:hover {
  background: var(--bg-hover);
}

.commits__avatar {
  width: 26px;
  height: 26px;
  flex: 0 0 26px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--bg-subtle);
}

.commits__avatar--ph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  text-transform: uppercase;
}

.commits__body {
  flex: 1;
  min-width: 0;
}

.commits__msg {
  font-size: var(--fs-sm);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
}

.commits__meta {
  margin-top: 2px;
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  overflow-wrap: anywhere;
}

/* ---------------- 待处理 ---------------- */
.todos {
  margin: 0;
  padding: 0;
  list-style: none;
}

.todos__item {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-5);
  border-bottom: 1px solid var(--border-hairline);
  transition: background-color var(--dur-fast) var(--ease);
}

.todos__item:last-child {
  border-bottom: none;
}

.todos__item:hover {
  background: var(--bg-hover);
}

.todos__kind {
  flex: 0 0 auto;
  margin-top: 2px;
  padding: 1px 6px;
  border-radius: var(--r-xs);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  background: var(--bg-subtle);
  color: var(--text-tertiary);
}

.todos__kind--pull {
  background: var(--brand-soft);
  color: var(--brand);
}

.todos__body {
  flex: 1;
  min-width: 0;
}

.todos__title {
  font-size: var(--fs-sm);
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.todos__meta {
  margin-top: 2px;
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  overflow-wrap: anywhere;
}

.todos__draft {
  margin-left: var(--sp-2);
  padding: 0 5px;
  border-radius: var(--r-xs);
  background: var(--bg-subtle);
  color: var(--text-tertiary);
}

.todos__labels {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: var(--sp-2) 0 0;
  padding: 0;
  list-style: none;
}

.todos__labels li {
  padding: 1px 6px;
  border-radius: var(--r-xs);
  background: var(--bg-subtle);
  color: var(--text-tertiary);
  font-size: 11px;
}

/* ---------------- 外链小图标 ---------------- */
.run-link {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
  /* 手机上要够点：图标本身只有 12px，靠内边距把热区撑到 44px */
  min-width: 44px;
  min-height: 44px;
  justify-content: center;
  margin: calc(var(--sp-3) * -1) 0;
  padding: 0 var(--sp-2);
  border-radius: var(--r-sm);
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  transition:
    color var(--dur-fast) var(--ease),
    background-color var(--dur-fast) var(--ease);
}

.runs__item .run-link {
  margin: 0;
}

.run-link:hover {
  color: var(--brand);
  background: var(--brand-soft);
}

@media (max-width: 768px) {
  .toolbar,
  .repo-head {
    padding-left: var(--sp-4);
    padding-right: var(--sp-4);
  }

  .sec-head,
  .commits__item,
  .todos__item,
  .inline-empty {
    padding-left: var(--sp-4);
    padding-right: var(--sp-4);
  }

  .runs {
    padding-left: var(--sp-4);
    padding-right: var(--sp-4);
  }

  .ci-latest {
    margin-left: var(--sp-4);
    margin-right: var(--sp-4);
  }

  .runs__item {
    flex-wrap: wrap;
  }

  .runs__time {
    margin-left: 0;
  }
}
</style>
