<template>
  <div class="page">
    <ReadOnlyNotice what="一键部署应用（会真实创建容器、加解析、配反向代理）" />

    <!-- ==================== 部署运行面板（有任务时才出现） ==================== -->
    <transition name="rise">
      <section v-if="activeTask" class="surface run">
        <header class="run__head">
          <div class="run__titles">
            <h2 class="run__title">
              {{ activeTask.app_title || activeTask.app_name }}
              <span class="run__domain mono">{{ activeTask.domain }}</span>
            </h2>
            <p class="run__sub">
              任务号 <span class="mono">{{ activeTask.id }}</span>
              <span v-if="activeTask.created_at"> · 开始于 {{ activeTask.created_at }}</span>
            </p>
          </div>
          <div class="run__head-right">
            <span class="pill" :class="`pill--${statusTone}`">{{ statusText }}</span>
            <el-button text @click="closeRun">
              <el-icon><Close /></el-icon>
            </el-button>
          </div>
        </header>

        <!-- 进度 + 步骤（把「在做什么」讲清楚，而不是只转一个圈） -->
        <div class="run__progress">
          <el-progress
            :percentage="activeTask.progress || 0"
            :status="
              activeTask.status === 'failed'
                ? 'exception'
                : activeTask.status === 'success'
                  ? 'success'
                  : undefined
            "
            :stroke-width="8"
          />
          <p class="run__step-name">
            <template v-if="activeTask.status === 'running'">
              第 {{ (activeTask.current_step || 0) + 1 }} /
              {{ (activeTask.steps || []).length }} 步：
              {{ (activeTask.steps || [])[activeTask.current_step || 0] || '执行中' }}
            </template>
            <template v-else-if="activeTask.status === 'success'">全部步骤已完成</template>
            <template v-else-if="activeTask.status === 'failed'"
              >部署中断，失败原因见下方日志</template
            >
            <template v-else>等待开始…</template>
          </p>
        </div>

        <ol class="steps">
          <li
            v-for="(step, index) in activeTask.steps || []"
            :key="step"
            class="steps__item"
            :class="stepClass(index)"
          >
            <span class="steps__dot">
              <el-icon v-if="stepClass(index) === 'is-done'"><Check /></el-icon>
              <el-icon v-else-if="stepClass(index) === 'is-failed'"><Close /></el-icon>
              <span v-else class="steps__index">{{ index + 1 }}</span>
            </span>
            <span class="steps__label">{{ step }}</span>
          </li>
        </ol>

        <!-- 成功结果 -->
        <div v-if="activeTask.status === 'success'" class="run__result">
          <div class="run__result-main">
            <span class="run__result-label">访问地址</span>
            <span class="copyable">
              <a
                :href="resultUrl"
                target="_blank"
                rel="noopener"
                class="run__result-url copyable__text"
                >{{ resultUrl }}</a
              >
              <CopyBtn :text="resultUrl" title="复制访问地址" ok-message="访问地址已复制" />
            </span>
          </div>
          <el-button type="primary" tag="a" :href="resultUrl" target="_blank" rel="noopener"
            >打开应用</el-button
          >
        </div>

        <!-- 警告清单（例如 SSL 需手动确认） -->
        <ul v-if="(activeTask.result?.warnings || []).length" class="run__warnings">
          <li v-for="(warn, i) in activeTask.result.warnings" :key="i">
            <el-icon><WarningFilled /></el-icon>
            <span>{{ warn }}</span>
          </li>
        </ul>

        <!-- 实时日志 -->
        <div class="run__log-head">
          <span>部署日志</span>
          <span class="muted-xs"
            >{{ logs.length }} 条 ·
            {{ activeTask.status === 'running' ? '实时刷新中' : '已结束' }}</span
          >
        </div>
        <pre ref="runLogRef" class="run__log">{{ logText || '等待输出…' }}</pre>
      </section>
    </transition>

    <!-- ==================== 模板列表 ==================== -->
    <section class="surface templates">
      <header class="templates__head">
        <div>
          <h2 class="templates__title">可一键部署的应用</h2>
          <p class="templates__sub">
            部署会自动完成：Cloudflare 加解析 → 拉取镜像 → 启动容器 → 宝塔配反向代理 → 配置 HTTPS
          </p>
        </div>
        <el-button :loading="loadingTemplates" @click="loadTemplates">
          <el-icon><Refresh /></el-icon>刷新
        </el-button>
      </header>

      <StateBlock
        v-if="templatesState === 'loading'"
        state="loading"
        loading-text="正在读取应用模板…"
      />
      <StateBlock
        v-else-if="templatesState === 'error'"
        state="error"
        title="读取应用模板失败"
        :description="templatesError"
        action-text="重试"
        @action="loadTemplates"
      />
      <StateBlock v-else-if="templatesState === 'empty'" state="empty" title="暂无可用模板" />

      <div v-else class="grid">
        <article
          v-for="(tpl, index) in templates"
          :key="tpl.key"
          class="tpl"
          :class="{ 'tpl--featured': index === 0 }"
        >
          <div class="tpl__top">
            <span class="tpl__mark" :style="{ background: tpl.color }">{{ tpl.iconText }}</span>
            <div class="tpl__names">
              <h3 class="tpl__name">{{ tpl.name }}</h3>
              <p class="tpl__title">{{ tpl.title }}</p>
            </div>
            <span class="tpl__memory">{{ tpl.recommendMemory }}</span>
          </div>

          <p class="tpl__desc">{{ tpl.description }}</p>

          <ul class="tpl__tags">
            <li v-for="tag in tpl.tags" :key="tag">{{ tag }}</li>
          </ul>

          <ul v-if="index === 0" class="tpl__facts">
            <li>
              <strong>{{ tpl.serviceCount }}</strong> 个容器
            </li>
            <li>
              <strong>{{ tpl.defaultPort }}</strong> 容器端口
            </li>
            <li>自动配好域名与 HTTPS</li>
          </ul>

          <div class="tpl__foot">
            <a :href="tpl.docsUrl" target="_blank" rel="noopener" class="tpl__doc">官方文档</a>
            <el-button v-if="auth.canWrite" type="primary" @click="openDeploy(tpl)">
              <el-icon><Upload /></el-icon>部署
            </el-button>
          </div>
        </article>
      </div>
    </section>

    <!-- ==================== 部署历史 ==================== -->
    <section class="surface">
      <header class="templates__head">
        <div>
          <h2 class="templates__title">部署记录</h2>
          <p class="templates__sub">最近 20 次部署，点击可查看当时的完整日志</p>
        </div>
        <el-button :loading="loadingTasks" @click="loadTasks">
          <el-icon><Refresh /></el-icon>刷新
        </el-button>
      </header>

      <StateBlock
        v-if="!tasks.length"
        state="empty"
        title="还没有部署记录"
        description="从上方选一个应用开始首次部署。"
      />

      <ul v-else class="tasks">
        <li v-for="task in tasks" :key="task.id" class="tasks__item" @click="openTask(task.id)">
          <span class="pill" :class="`pill--${toneOfStatus(task.status)}`">{{
            textOfStatus(task.status)
          }}</span>
          <span class="tasks__main">
            <strong>{{ task.app_title || task.app_name }}</strong>
            <em class="mono">{{ task.domain }}</em>
          </span>
          <span class="tasks__progress tnum">{{ task.progress }}%</span>
          <span class="tasks__time">{{ task.created_at }}</span>
          <el-icon class="tasks__caret"><ArrowRight /></el-icon>
        </li>
      </ul>
    </section>

    <!-- ==================== 部署确认弹窗 ==================== -->
    <el-dialog
      v-model="deployVisible"
      :title="`部署 ${deployTarget?.name || ''}`"
      width="540px"
      :close-on-click-modal="false"
    >
      <div v-if="deployTarget" class="confirm">
        <div class="confirm__app">
          <span class="tpl__mark" :style="{ background: deployTarget.color }">{{
            deployTarget.iconText
          }}</span>
          <div>
            <strong>{{ deployTarget.title }}</strong>
            <p class="muted-xs">
              {{ deployTarget.serviceCount }} 个容器 · 建议内存 {{ deployTarget.recommendMemory }}
            </p>
          </div>
        </div>

        <el-form ref="deployFormRef" :model="deployForm" :rules="deployRules" label-position="top">
          <el-form-item label="绑定域名" prop="domain">
            <el-input
              v-model="deployForm.domain"
              placeholder="例如 kuma.miaocaieyc.com.cn"
              clearable
            />
            <p class="form-tip">该域名需已托管在 Cloudflare，且 Token 具备 DNS 编辑权限</p>
          </el-form-item>
        </el-form>

        <el-alert
          type="warning"
          :closable="false"
          show-icon
          title="部署会真实改动服务器"
          description="将新增 DNS 解析、启动容器并覆盖该域名在宝塔中的 Nginx 站点配置（原配置会自动备份为 .bak.<时间戳>）。请确认域名没有被其他站点占用。"
        />

        <ul v-if="deployTarget.notes?.length" class="confirm__notes">
          <li v-for="(note, i) in deployTarget.notes" :key="i">{{ note }}</li>
        </ul>
      </div>

      <template #footer>
        <el-button @click="deployVisible = false">取消</el-button>
        <el-button type="primary" :loading="deploying" @click="submitDeploy">
          {{ deploying ? '正在创建任务…' : '开始部署' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
// 深路径导入：不要改回 'element-plus'（barrel 入口会阻止 tree-shaking，详见 main.js）
import { ElMessage } from 'element-plus/es/components/message/index';
import CopyBtn from '@/components/CopyBtn.vue';
import ReadOnlyNotice from '@/components/ReadOnlyNotice.vue';
import StateBlock from '@/components/StateBlock.vue';
import { appApi } from '@/api';
import { useAuthStore } from '@/stores/auth';

const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

// 只读身份下隐藏「部署」入口（后端也会拦）
const auth = useAuthStore();

// ---------------- 模板 ----------------
const templates = ref([]);
const templatesState = ref('loading');
const templatesError = ref('');
const loadingTemplates = ref(false);

async function loadTemplates() {
  loadingTemplates.value = true;
  templatesState.value = 'loading';
  try {
    const data = await appApi.templates();
    templates.value = data.list || [];
    templatesState.value = templates.value.length ? 'ready' : 'empty';
  } catch (err) {
    templatesError.value = err.message || '未知错误';
    templatesState.value = 'error';
  } finally {
    loadingTemplates.value = false;
  }
}

// ---------------- 部署任务 ----------------
const tasks = ref([]);
const loadingTasks = ref(false);
const activeTask = ref(null);
const logs = ref([]);
const lastLogId = ref(0);
let pollTimer = null;
const runLogRef = ref(null);

const STATUS_TEXT = { pending: '排队中', running: '部署中', success: '已完成', failed: '已失败' };
const STATUS_TONE = {
  pending: 'pending',
  running: 'running',
  success: 'success',
  failed: 'failed',
};

const textOfStatus = (s) => STATUS_TEXT[s] || s;
const toneOfStatus = (s) => STATUS_TONE[s] || 'pending';
const statusText = computed(() => textOfStatus(activeTask.value?.status));
const statusTone = computed(() => toneOfStatus(activeTask.value?.status));
const resultUrl = computed(
  () => activeTask.value?.result?.url || `https://${activeTask.value?.domain || ''}`
);

const logText = computed(() =>
  logs.value
    .map((l) => `${l.created_at?.slice(11) || ''} ${levelMark(l.level)} ${l.message}`)
    .join('\n')
);

function levelMark(level) {
  return { success: '✓', warn: '!', error: '✕', info: '·' }[level] || '·';
}

function stepClass(index) {
  const task = activeTask.value;
  if (!task) return '';
  if (task.status === 'success') return 'is-done';
  if (task.status === 'failed') {
    if (index < (task.current_step || 0)) return 'is-done';
    if (index === (task.current_step || 0)) return 'is-failed';
    return '';
  }
  if (index < (task.current_step || 0)) return 'is-done';
  if (index === (task.current_step || 0) && task.status === 'running') return 'is-current';
  return '';
}

async function loadTasks() {
  loadingTasks.value = true;
  try {
    const data = await appApi.tasks({ limit: 20 });
    tasks.value = data.list || [];
  } catch {
    /* 历史记录加载失败不阻塞页面 */
  } finally {
    loadingTasks.value = false;
  }
}

/** 拉取任务详情 + 增量日志 */
async function pollTask() {
  if (!activeTask.value) return;
  try {
    const data = await appApi.taskLogs(activeTask.value.id, { sinceId: lastLogId.value });
    if (data.logs?.length) {
      logs.value.push(...data.logs);
      lastLogId.value = data.lastId;
      await nextTick();
      if (runLogRef.value) runLogRef.value.scrollTop = runLogRef.value.scrollHeight;
    }

    const detail = await appApi.task(activeTask.value.id);
    activeTask.value = { ...detail };

    if (detail.status === 'success' || detail.status === 'failed') {
      stopPolling();
      loadTasks();
      if (detail.status === 'success') ElMessage.success(`部署完成：${resultUrl.value}`);
      else ElMessage.error(`部署失败：${detail.error || '详情见日志'}`);
    }
  } catch {
    stopPolling();
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollTask, 2000);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function openTask(taskId) {
  logs.value = [];
  lastLogId.value = 0;
  try {
    const detail = await appApi.task(taskId);
    activeTask.value = detail;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    await pollTask();
    if (detail.status === 'running' || detail.status === 'pending') startPolling();
  } catch {
    /* 拦截器已提示 */
  }
}

function closeRun() {
  stopPolling();
  activeTask.value = null;
  logs.value = [];
  lastLogId.value = 0;
}

// ---------------- 发起部署 ----------------
const deployVisible = ref(false);
const deploying = ref(false);
const deployTarget = ref(null);
const deployFormRef = ref(null);
const deployForm = reactive({ domain: '' });

const deployRules = {
  domain: [
    { required: true, message: '请输入要绑定的域名', trigger: 'blur' },
    {
      validator: (_rule, value, callback) =>
        DOMAIN_RE.test(
          String(value || '')
            .trim()
            .toLowerCase()
        )
          ? callback()
          : callback(new Error('域名格式不正确，例如 kuma.example.com')),
      trigger: 'blur',
    },
  ],
};

function openDeploy(tpl) {
  deployTarget.value = tpl;
  deployForm.domain = '';
  deployVisible.value = true;
}

async function submitDeploy() {
  try {
    await deployFormRef.value.validate();
  } catch {
    return;
  }

  deploying.value = true;
  try {
    const data = await appApi.deploy({
      appKey: deployTarget.value.key,
      domain: deployForm.domain.trim().toLowerCase(),
    });
    deployVisible.value = false;
    ElMessage.success('部署任务已创建，正在后台执行');

    logs.value = [];
    lastLogId.value = 0;
    activeTask.value = {
      id: data.taskId,
      app_name: deployTarget.value.key,
      app_title: deployTarget.value.title,
      domain: deployForm.domain.trim().toLowerCase(),
      status: 'running',
      progress: 0,
      current_step: 0,
      steps: data.steps || [],
    };
    window.scrollTo({ top: 0, behavior: 'smooth' });
    startPolling();
    loadTasks();
  } catch {
    /* 拦截器已提示（例如同域名已有部署记录） */
  } finally {
    deploying.value = false;
  }
}

onMounted(() => {
  loadTemplates();
  loadTasks();
});

onBeforeUnmount(stopPolling);
</script>

<style scoped>
/* ---------------- 运行面板 ---------------- */
.run {
  padding: var(--sp-5);
  border-left: 2px solid var(--brand);
}

.run__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-4);
  margin-bottom: var(--sp-4);
}

.run__title {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
  flex-wrap: wrap;
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-primary);
}

.run__domain {
  font-weight: 400;
  color: var(--brand);
}

.run__sub {
  margin-top: 2px;
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  overflow-wrap: anywhere;
}

.run__head-right {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.run__progress {
  margin-bottom: var(--sp-4);
}

.run__step-name {
  margin-top: var(--sp-2);
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

/* 步骤时间线 */
.steps {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  margin: 0 0 var(--sp-4);
  padding: 0;
  list-style: none;
}

.steps__item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px 4px 6px;
  border-radius: var(--r-full);
  border: 1px solid var(--border-hairline);
  background: var(--bg-surface);
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}

.steps__dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--bg-subtle);
  font-size: 10px;
}

.steps__index {
  color: var(--text-tertiary);
}

.steps__item.is-done {
  color: var(--success);
  border-color: color-mix(in srgb, var(--success) 25%, transparent);
  background: var(--success-soft);
}

.steps__item.is-done .steps__dot {
  background: var(--success);
  color: var(--on-brand);
}

.steps__item.is-current {
  color: var(--brand);
  border-color: var(--brand-soft-border);
  background: var(--brand-soft);
}

.steps__item.is-current .steps__dot {
  background: var(--brand);
  color: var(--on-brand);
}

.steps__item.is-failed {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 25%, transparent);
  background: var(--danger-soft);
}

.steps__item.is-failed .steps__dot {
  background: var(--danger);
  color: var(--on-brand);
}

/* 结果区 */
.run__result {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
  flex-wrap: wrap;
  padding: var(--sp-4);
  margin-bottom: var(--sp-4);
  border-radius: var(--r-md);
  background: var(--success-soft);
  border: 1px solid color-mix(in srgb, var(--success) 22%, transparent);
}

.run__result-label {
  display: block;
  font-size: var(--fs-xs);
  color: var(--success);
}

.run__result-url {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-primary);
  word-break: break-all;
}

.run__warnings {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin: 0 0 var(--sp-4);
  padding: var(--sp-3) var(--sp-4);
  list-style: none;
  border-radius: var(--r-md);
  background: var(--warning-soft);
  border: 1px solid color-mix(in srgb, var(--warning) 22%, transparent);
}

.run__warnings li {
  display: flex;
  gap: var(--sp-2);
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-secondary);
}

.run__warnings .el-icon {
  color: var(--warning);
  margin-top: 3px;
}

.run__log-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--sp-2);
  font-size: var(--fs-sm);
  font-weight: 500;
  color: var(--text-primary);
}

.run__log {
  max-height: 280px;
  margin: 0;
  padding: var(--sp-4);
  border-radius: var(--r-md);
  background: #071a12;
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #cfe6da;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  overflow-y: auto;
}

/* ---------------- 模板列表 ---------------- */
.templates__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: var(--sp-4) var(--sp-5);
  border-bottom: 1px solid var(--border-hairline);
}

.templates__title {
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text-primary);
}

.templates__sub {
  margin-top: 2px;
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr));
  gap: var(--sp-4);
  padding: var(--sp-5);
}

/* 首个模板做「主推」：跨两列且内部结构不同，避免整屏等大卡片 */
.tpl {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-4);
  border: 1px solid var(--border-hairline);
  border-radius: var(--r-lg);
  background: var(--bg-surface);
  box-shadow: var(--shadow-sm);
  transition:
    transform var(--dur-card) var(--ease),
    box-shadow var(--dur-card) var(--ease);
}

.tpl:hover {
  transform: translateY(-1px);
  box-shadow: var(--shadow-md);
}

.tpl--featured {
  grid-column: span 2;
  border-color: var(--brand-soft-border);
  background: linear-gradient(180deg, var(--brand-soft) 0%, var(--bg-surface) 42%);
}

.tpl__top {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.tpl__mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  border-radius: var(--r-md);
  color: var(--on-brand);
  font-size: var(--fs-sm);
  font-weight: 600;
  letter-spacing: -0.02em;
}

.tpl__names {
  min-width: 0;
  flex: 1;
}

.tpl__name {
  font-size: var(--fs-md);
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text-primary);
}

.tpl__title {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}

.tpl__memory {
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: var(--r-full);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: 11px;
}

.tpl__desc {
  font-size: var(--fs-sm);
  line-height: 1.65;
  color: var(--text-secondary);
}

.tpl__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.tpl__tags li {
  padding: 1px 8px;
  border-radius: var(--r-xs);
  background: var(--bg-subtle);
  color: var(--text-tertiary);
  font-size: 11px;
}

.tpl__facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-4);
  margin: 0;
  padding: var(--sp-3) 0 0;
  list-style: none;
  border-top: 1px dashed var(--border-hairline);
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}

.tpl__facts strong {
  color: var(--text-primary);
}

.tpl__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: auto;
  padding-top: var(--sp-2);
}

.tpl__doc {
  display: inline-flex;
  align-items: center;
  /* 手机上文字链必须给足点击高度，19px 高的链接手指点不准 */
  min-height: 44px;
  padding: 0 var(--sp-2);
  margin-left: calc(var(--sp-2) * -1);
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  border-radius: var(--r-sm);
  transition:
    color var(--dur-fast) var(--ease),
    background-color var(--dur-fast) var(--ease);
}

.tpl__doc:hover {
  color: var(--brand);
}

/* ---------------- 部署记录 ---------------- */
.tasks {
  margin: 0;
  padding: 0;
  list-style: none;
}

.tasks__item {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-5);
  border-bottom: 1px solid var(--border-hairline);
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease);
}

.tasks__item:last-child {
  border-bottom: none;
}

.tasks__item:hover {
  background: var(--bg-hover);
}

.tasks__main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.tasks__main strong {
  font-size: var(--fs-base);
  font-weight: 500;
  color: var(--text-primary);
}

.tasks__main em {
  font-size: var(--fs-xs);
  font-style: normal;
  color: var(--text-tertiary);
}

.tasks__progress {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

.tasks__time {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  white-space: nowrap;
}

.tasks__caret {
  font-size: 12px;
  color: var(--text-tertiary);
}

/* ---------------- 状态胶囊 ---------------- */
.pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  padding: 1px 9px;
  border-radius: var(--r-full);
  font-size: var(--fs-xs);
  font-weight: 500;
  line-height: 19px;
}

.pill::before {
  content: '';
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}

.pill--pending {
  background: var(--bg-subtle);
  color: var(--text-tertiary);
}

.pill--running {
  background: var(--brand-soft);
  color: var(--brand);
}

.pill--success {
  background: var(--success-soft);
  color: var(--success);
}

.pill--failed {
  background: var(--danger-soft);
  color: var(--danger);
}

/* ---------------- 确认弹窗 ---------------- */
.confirm {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.confirm__app {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.confirm__app strong {
  font-size: var(--fs-base);
  color: var(--text-primary);
}

.confirm__notes {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-tertiary);
}

.confirm__notes li::before {
  content: '·';
  margin-right: 6px;
  color: var(--brand);
}

.form-tip {
  margin-top: 4px;
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}

/* 面板浮现动效 */
.rise-enter-active,
.rise-leave-active {
  transition:
    opacity var(--dur-layer) var(--ease),
    transform var(--dur-layer) var(--ease);
}

.rise-enter-from,
.rise-leave-to {
  opacity: 0;
  transform: translateY(10px);
}

@media (max-width: 1024px) {
  .tpl--featured {
    grid-column: span 1;
  }
}

@media (max-width: 768px) {
  .run,
  .templates__head {
    padding-left: var(--sp-4);
    padding-right: var(--sp-4);
  }

  .grid {
    padding: var(--sp-4);
  }

  .tasks__item {
    padding: var(--sp-3) var(--sp-4);
    flex-wrap: wrap;
  }

  .tasks__time {
    width: 100%;
    padding-left: 0;
  }
}
</style>
