<template>
  <div class="page">
    <!-- ==================== 工具条 ==================== -->
    <section class="surface toolbar">
      <div class="toolbar__left">
        <el-radio-group v-model="filter.state" size="default" @change="loadContainers">
          <el-radio-button value="">全部</el-radio-button>
          <el-radio-button value="running">运行中</el-radio-button>
          <el-radio-button value="stopped">已停止</el-radio-button>
        </el-radio-group>

        <el-input
          v-model="filter.search"
          placeholder="搜索容器名 / 镜像"
          clearable
          class="toolbar__search"
          @keyup.enter="loadContainers"
          @clear="loadContainers"
        >
          <template #prefix
            ><el-icon><Search /></el-icon
          ></template>
        </el-input>

        <el-checkbox v-model="filter.managed" @change="loadContainers"
          >只看本系统部署的</el-checkbox
        >
      </div>

      <div class="toolbar__right">
        <span class="toolbar__count tnum">
          共 <strong>{{ summary.total }}</strong> 个 · 运行 <strong>{{ summary.running }}</strong>
        </span>
        <el-button :loading="loading" @click="refreshAll">
          <el-icon><Refresh /></el-icon>刷新
        </el-button>
      </div>
    </section>

    <!-- ==================== 容器 / 镜像 ==================== -->
    <section class="surface">
      <el-tabs v-model="tab" class="tabs" @tab-change="onTabChange">
        <el-tab-pane name="containers">
          <template #label>
            <span class="tab-label"
              ><el-icon><Box /></el-icon>容器<span class="tab-badge">{{
                summary.total
              }}</span></span
            >
          </template>
        </el-tab-pane>
        <el-tab-pane name="images">
          <template #label>
            <span class="tab-label"
              ><el-icon><Files /></el-icon>镜像<span class="tab-badge">{{
                images.length
              }}</span></span
            >
          </template>
        </el-tab-pane>
      </el-tabs>

      <!-- ---------- 容器 ---------- -->
      <template v-if="tab === 'containers'">
        <StateBlock v-if="state === 'loading'" state="loading" loading-text="正在读取容器列表…" />
        <StateBlock
          v-else-if="state === 'error'"
          state="error"
          title="读取容器失败"
          :description="errorMessage"
          action-text="重试"
          @action="refreshAll"
        />
        <StateBlock
          v-else-if="state === 'empty'"
          state="empty"
          title="没有符合条件的容器"
          description="换个筛选条件试试；如果服务器上确实还没有容器，可以先到「应用商店」一键部署一个。"
          action-text="去应用商店"
          @action="$router.push('/apps')"
        />

        <!-- 窄屏：卡片视图（表格在手机上一行读不完，操作列会被压成一团） -->
        <ul v-if="isNarrow" class="cards">
          <li v-for="row in containers" :key="row.id" class="card">
            <div class="card__head">
              <div class="card__title">
                <span class="copyable">
                  <span class="copyable__text">{{ row.name }}</span>
                  <CopyBtn :text="row.name" title="复制容器名" ok-message="容器名已复制" />
                </span>
                <span v-if="row.managedByWorkbench" class="badge-managed">本系统</span>
                <span class="card__sub mono">{{ row.shortId }}</span>
              </div>
              <span class="pill" :class="row.running ? 'pill--ok' : 'pill--off'">
                {{ row.running ? '运行中' : '已停止' }}
              </span>
            </div>

            <dl class="card__meta">
              <div class="card__meta-row">
                <dt>镜像</dt>
                <dd class="mono">{{ row.image }}</dd>
              </div>
              <div v-if="row.portSummary.length" class="card__meta-row">
                <dt>端口</dt>
                <dd class="mono">{{ row.portSummary.join(' , ') }}</dd>
              </div>
              <div v-if="row.domain" class="card__meta-row">
                <dt>访问域名</dt>
                <dd>
                  <span class="copyable">
                    <span class="copyable__text">{{ row.domain }}</span>
                    <CopyBtn :text="row.domain" title="复制访问域名" ok-message="访问域名已复制" />
                  </span>
                </dd>
              </div>
              <div class="card__meta-row">
                <dt>状态</dt>
                <dd class="muted-xs">{{ row.status }}</dd>
              </div>
            </dl>

            <div class="card__actions">
              <el-button @click="openLogs(row)">日志</el-button>
              <el-button
                v-if="row.running"
                type="primary"
                :loading="actingId === row.id"
                @click="doAction(row, 'restart')"
              >
                重启
              </el-button>
              <el-button
                v-if="row.running"
                type="warning"
                plain
                :loading="actingId === row.id"
                @click="doAction(row, 'stop')"
              >
                停止
              </el-button>
              <el-button
                v-else
                type="success"
                :loading="actingId === row.id"
                @click="doAction(row, 'start')"
              >
                启动
              </el-button>
              <el-button type="danger" plain @click="confirmRemove(row)">删除</el-button>
            </div>
          </li>
        </ul>

        <!-- 宽屏：表格 -->
        <div v-else class="table-wrap">
          <el-table :data="containers" row-key="id" style="width: 100%">
            <el-table-column label="容器" min-width="240">
              <template #default="{ row }">
                <div class="cell-main">
                  <span class="cell-title">
                    <span class="copyable">
                      <span class="copyable__text">{{ row.name }}</span>
                      <CopyBtn :text="row.name" title="复制容器名" ok-message="容器名已复制" />
                    </span>
                    <span v-if="row.managedByWorkbench" class="badge-managed">本系统</span>
                  </span>
                  <span class="muted-xs mono">{{ row.shortId }}</span>
                </div>
              </template>
            </el-table-column>

            <el-table-column label="镜像" min-width="200" show-overflow-tooltip>
              <template #default="{ row }">
                <span class="mono">{{ row.image }}</span>
              </template>
            </el-table-column>

            <el-table-column label="状态" width="150">
              <template #default="{ row }">
                <span class="pill" :class="row.running ? 'pill--ok' : 'pill--off'">
                  {{ row.running ? '运行中' : '已停止' }}
                </span>
                <div class="muted-xs">{{ row.status }}</div>
              </template>
            </el-table-column>

            <el-table-column label="端口映射" min-width="160">
              <template #default="{ row }">
                <span v-if="row.portSummary.length" class="mono">{{
                  row.portSummary.join(' , ')
                }}</span>
                <span v-else class="muted-xs">—</span>
              </template>
            </el-table-column>

            <el-table-column label="访问域名" min-width="160">
              <template #default="{ row }">
                <span v-if="row.domain" class="copyable">
                  <span class="muted copyable__text">{{ row.domain }}</span>
                  <CopyBtn :text="row.domain" title="复制访问域名" ok-message="访问域名已复制" />
                </span>
                <span v-else class="muted-xs">—</span>
              </template>
            </el-table-column>

            <el-table-column label="操作" width="250" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openLogs(row)">日志</el-button>
                <el-button
                  v-if="row.running"
                  link
                  type="primary"
                  :loading="actingId === row.id"
                  @click="doAction(row, 'restart')"
                >
                  重启
                </el-button>
                <el-button
                  v-if="row.running"
                  link
                  type="warning"
                  :loading="actingId === row.id"
                  @click="doAction(row, 'stop')"
                >
                  停止
                </el-button>
                <el-button
                  v-else
                  link
                  type="success"
                  :loading="actingId === row.id"
                  @click="doAction(row, 'start')"
                >
                  启动
                </el-button>
                <el-button link type="danger" @click="confirmRemove(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </template>

      <!-- ---------- 镜像 ---------- -->
      <template v-else>
        <StateBlock
          v-if="imagesState === 'loading'"
          state="loading"
          loading-text="正在读取镜像列表…"
        />
        <StateBlock
          v-else-if="imagesState === 'error'"
          state="error"
          title="读取镜像失败"
          :description="imagesError"
          action-text="重试"
          @action="loadImages"
        />
        <StateBlock
          v-else-if="imagesState === 'empty'"
          state="empty"
          title="暂无本地镜像"
          description="部署应用时系统会自动拉取所需镜像。"
        />

        <!-- 窄屏：卡片视图 -->
        <ul v-if="isNarrow" class="cards">
          <li v-for="row in images" :key="row.id" class="card">
            <div class="card__head">
              <div class="card__title mono">
                {{ row.tags.length ? row.tags.join(' , ') : '未打标签' }}
                <span class="card__sub mono">{{ row.shortId }}</span>
              </div>
              <span class="muted tnum">{{ row.sizeText }}</span>
            </div>

            <dl class="card__meta">
              <div class="card__meta-row">
                <dt>被引用</dt>
                <dd class="tnum">{{ row.containers }}</dd>
              </div>
              <div class="card__meta-row">
                <dt>创建时间</dt>
                <dd>{{ row.createdText || '—' }}</dd>
              </div>
            </dl>
          </li>
        </ul>

        <!-- 宽屏：表格 -->
        <div v-else class="table-wrap">
          <el-table :data="images" row-key="id" style="width: 100%">
            <el-table-column label="镜像标签" min-width="240">
              <template #default="{ row }">
                <div class="cell-main">
                  <span class="cell-title mono">{{
                    row.tags.length ? row.tags.join(' , ') : '未打标签'
                  }}</span>
                  <span class="muted-xs mono">{{ row.shortId }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="大小" width="120">
              <template #default="{ row }">
                <span class="tnum">{{ row.sizeText }}</span>
              </template>
            </el-table-column>
            <el-table-column label="被容器引用" width="130">
              <template #default="{ row }">
                <span class="tnum">{{ row.containers }}</span>
              </template>
            </el-table-column>
            <el-table-column label="创建时间" min-width="180">
              <template #default="{ row }">
                <span class="muted">{{ row.createdText || '—' }}</span>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </template>
    </section>

    <!-- ==================== 日志抽屉 ==================== -->
    <el-drawer
      v-model="logVisible"
      :size="drawerSize"
      direction="rtl"
      :destroy-on-close="true"
      @closed="closeLogs"
    >
      <template #header>
        <div class="log-head">
          <strong>{{ logTarget?.name }}</strong>
          <span class="muted-xs mono">{{ logTarget?.image }}</span>
        </div>
      </template>

      <div class="log-panel">
        <div class="log-toolbar">
          <el-select v-model="logTail" size="small" class="log-tail" @change="reconnectLogs">
            <el-option :value="100" label="最近 100 行" />
            <el-option :value="300" label="最近 300 行" />
            <el-option :value="500" label="最近 500 行" />
          </el-select>
          <el-checkbox v-model="autoScroll" size="small">自动滚动</el-checkbox>
          <span class="log-status" :class="logConnected ? 'is-on' : 'is-off'">
            {{ logConnected ? '实时推送中' : '连接中断，重试中…' }}
          </span>
        </div>

        <pre ref="logPreRef" class="log-body">{{ logText || '暂无日志输出' }}</pre>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
// 深路径导入：不要改回 'element-plus'（barrel 入口会阻止 tree-shaking，详见 main.js）
import { ElMessage } from 'element-plus/es/components/message/index';
import { ElMessageBox } from 'element-plus/es/components/message-box/index';
import CopyBtn from '@/components/CopyBtn.vue';
import StateBlock from '@/components/StateBlock.vue';
import { useNarrow } from '@/composables/useNarrow';
import { dockerApi } from '@/api';

const tab = ref('containers');

/** 窄屏用卡片视图替代表格（断点与主布局的侧栏收起点保持一致） */
const isNarrow = useNarrow(900);

// ---------------- 容器 ----------------
const containers = ref([]);
const state = ref('loading');
const errorMessage = ref('');
const loading = ref(false);
const actingId = ref('');
const filter = reactive({ state: '', search: '', managed: false });

const summary = computed(() => ({
  total: containers.value.length,
  running: containers.value.filter((c) => c.running).length,
}));

async function loadContainers() {
  loading.value = true;
  state.value = 'loading';
  try {
    const data = await dockerApi.containers({
      all: true,
      state: filter.state || undefined,
      search: filter.search || undefined,
      managed: filter.managed ? 'true' : undefined,
    });
    containers.value = data.list || [];
    state.value = containers.value.length ? 'ready' : 'empty';
  } catch (err) {
    errorMessage.value = err.message || '未知错误';
    state.value = 'error';
  } finally {
    loading.value = false;
  }
}

// ---------------- 镜像 ----------------
const images = ref([]);
const imagesState = ref('loading');
const imagesError = ref('');

async function loadImages() {
  imagesState.value = 'loading';
  try {
    const data = await dockerApi.images();
    images.value = data.list || [];
    imagesState.value = images.value.length ? 'ready' : 'empty';
  } catch (err) {
    imagesError.value = err.message || '未知错误';
    imagesState.value = 'error';
  }
}

function refreshAll() {
  if (tab.value === 'containers') loadContainers();
  else loadImages();
}

function onTabChange(name) {
  if (name === 'images' && imagesState.value !== 'ready') loadImages();
}

// ---------------- 启停操作 ----------------
async function doAction(row, action) {
  actingId.value = row.id;
  try {
    if (action === 'start') await dockerApi.start(row.id);
    else if (action === 'stop') await dockerApi.stop(row.id);
    else await dockerApi.restart(row.id);
    ElMessage.success(
      `已${action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启'}：${row.name}`
    );
    loadContainers();
  } catch {
    /* 拦截器已提示 */
  } finally {
    actingId.value = '';
  }
}

async function confirmRemove(row) {
  try {
    await ElMessageBox.confirm(
      `确定删除容器「${row.name}」吗？运行中的容器会被强制停止，容器内未落盘的数据会丢失。`,
      '删除容器',
      {
        confirmButtonText: '确认删除',
        cancelButtonText: '取消',
        type: 'warning',
        confirmButtonClass: 'el-button--danger',
      }
    );
  } catch {
    return;
  }

  try {
    await dockerApi.remove(row.id, { force: true, volumes: false });
    ElMessage.success(`容器已删除：${row.name}`);
    loadContainers();
  } catch {
    /* 拦截器已提示 */
  }
}

// ---------------- 日志（SSE 实时） ----------------
const logVisible = ref(false);
const logTarget = ref(null);
const logText = ref('');
const logTail = ref(100);
const autoScroll = ref(true);
const logConnected = ref(false);
const logPreRef = ref(null);
let source = null;

const drawerSize = computed(() => (window.innerWidth < 768 ? '100%' : '720px'));

function openLogs(row) {
  logTarget.value = row;
  logText.value = '';
  logVisible.value = true;
  connectLogs();
}

function connectLogs() {
  closeSource();
  if (!logTarget.value) return;

  source = new EventSource(dockerApi.logStreamUrl(logTarget.value.id, logTail.value));
  logConnected.value = true;

  source.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      logConnected.value = true;
      if (payload.ok) {
        logText.value = payload.logs || '';
        if (autoScroll.value) {
          nextTick(() => {
            const el = logPreRef.value;
            if (el) el.scrollTop = el.scrollHeight;
          });
        }
      }
    } catch {
      // 解析失败忽略该帧（不影响后续推送）
    }
  };

  source.onerror = () => {
    logConnected.value = false;
    // EventSource 自带重连；这里只更新状态提示
  };
}

function reconnectLogs() {
  if (logVisible.value) connectLogs();
}

function closeSource() {
  if (source) {
    source.close();
    source = null;
  }
  logConnected.value = false;
}

function closeLogs() {
  closeSource();
  logTarget.value = null;
  logText.value = '';
}

onMounted(loadContainers);
onBeforeUnmount(closeSource);
</script>

<style scoped>
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
  gap: var(--sp-3);
  flex-wrap: wrap;
}

.toolbar__search {
  width: 220px;
}

.toolbar__count {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

.toolbar__count strong {
  color: var(--text-primary);
}

.tabs {
  padding: 0 var(--sp-5);
}

.tabs :deep(.el-tabs__header) {
  margin-bottom: 0;
}

.tab-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.tab-badge {
  display: inline-block;
  min-width: 20px;
  padding: 0 6px;
  border-radius: var(--r-full);
  background: var(--bg-subtle);
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 17px;
  text-align: center;
}

.cell-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.cell-title {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-weight: 500;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.badge-managed {
  padding: 0 6px;
  border-radius: var(--r-xs);
  background: var(--brand-soft);
  color: var(--brand);
  font-size: 11px;
  font-weight: 500;
  line-height: 17px;
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

.pill--off {
  background: var(--bg-subtle);
  color: var(--text-tertiary);
}

/* ---------------- 日志 ---------------- */
.log-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.log-panel {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  height: 100%;
}

.log-toolbar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
}

.log-tail {
  width: 140px;
}

.log-status {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-xs);
}

.log-status::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.log-status.is-on {
  color: var(--success);
}

.log-status.is-off {
  color: var(--warning);
}

/* 终端面板固定深底：日志是「原始输出」，深底更符合阅读预期 */
.log-body {
  flex: 1;
  margin: 0;
  padding: var(--sp-4);
  min-height: 320px;
  border-radius: var(--r-md);
  background: #071a12;
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #cfe6da;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  overflow-y: auto;
}

@media (max-width: 768px) {
  .toolbar__search {
    width: 100%;
  }

  .toolbar__left,
  .toolbar__right {
    width: 100%;
  }

  .tabs {
    padding: 0 var(--sp-4);
  }
}
</style>
