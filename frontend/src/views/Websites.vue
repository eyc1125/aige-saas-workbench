<template>
  <div class="page">
    <!-- ==================== 工具条 ==================== -->
    <section class="surface toolbar">
      <div class="toolbar__left">
        <el-input
          v-model="query.search"
          placeholder="搜索域名 / 备注"
          clearable
          class="toolbar__search"
          @keyup.enter="reload(1)"
          @clear="reload(1)"
        >
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
        <el-button :loading="loading" @click="reload(1)">
          <el-icon><Refresh /></el-icon>刷新
        </el-button>
      </div>

      <div class="toolbar__right">
        <span class="toolbar__count tnum">
          共 <strong>{{ total }}</strong> 个站点
        </span>
        <el-button type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon>新建网站
        </el-button>
      </div>
    </section>

    <!-- ==================== 列表 ==================== -->
    <section class="surface">
      <StateBlock
        v-if="state === 'loading'"
        state="loading"
        loading-text="正在读取宝塔站点列表…"
      />
      <StateBlock
        v-else-if="state === 'error'"
        state="error"
        title="读取网站列表失败"
        :description="errorMessage"
        action-text="重试"
        @action="reload()"
      />
      <StateBlock
        v-else-if="state === 'empty'"
        state="empty"
        :title="query.search ? '没有匹配的网站' : '还没有任何网站'"
        :description="query.search ? '换个关键词试试，或清空搜索条件。' : '点击右上角「新建网站」创建第一个站点。'"
        :action-text="query.search ? '清空搜索' : ''"
        @action="onEmptyAction"
      />

      <template v-else>
        <!-- 窄屏（≤900px）：卡片视图。6 列表格在手机上横向拖动没法用，
             换成一行一卡，字段竖排、操作独立成行，320px 也能读完一条。 -->
        <ul v-if="isNarrow" class="cards">
          <li v-for="row in rows" :key="row.name" class="card">
            <div class="card__head">
              <div class="card__title">
                <span class="copyable">
                  <span class="copyable__text">{{ row.name }}</span>
                  <CopyBtn :text="row.name" title="复制域名" ok-message="域名已复制" />
                </span>
                <span v-if="row.domains.length > 1" class="card__sub">
                  另有 {{ row.domains.length - 1 }} 个绑定域名
                </span>
              </div>
              <span class="pill" :class="row.status === 'running' ? 'pill--ok' : 'pill--off'">
                {{ row.status === 'running' ? '运行中' : '已停止' }}
              </span>
            </div>

            <dl class="card__meta">
              <div class="card__meta-row">
                <dt>证书</dt>
                <dd>
                  <span class="cert" :class="`cert--${certTone(row.cert)}`">{{ certText(row.cert) }}</span>
                </dd>
              </div>
              <div class="card__meta-row">
                <dt>类型 / 版本</dt>
                <dd>{{ row.projectType }} · {{ row.phpVersion }}</dd>
              </div>
              <div class="card__meta-row">
                <dt>网站目录</dt>
                <dd class="mono">{{ row.path || '—' }}</dd>
              </div>
              <div class="card__meta-row">
                <dt>备注</dt>
                <dd>{{ row.ps || '—' }}</dd>
              </div>
            </dl>

            <div class="card__actions">
              <el-button @click="openDetail(row)">详情</el-button>
              <el-button type="primary" @click="openSsl(row)">申请证书</el-button>
              <el-button type="danger" plain @click="confirmRemove(row)">删除</el-button>
            </div>
          </li>
        </ul>

        <!-- 宽屏：表格 -->
        <div v-else class="table-wrap">
          <el-table :data="rows" row-key="name" style="width: 100%">
            <el-table-column label="站点域名" min-width="260">
              <template #default="{ row }">
                <div class="cell-main">
                  <span class="copyable">
                    <strong class="cell-domain copyable__text">{{ row.name }}</strong>
                    <CopyBtn :text="row.name" title="复制域名" ok-message="域名已复制" />
                  </span>
                  <span v-if="row.domains.length > 1" class="muted-xs">
                    另有 {{ row.domains.length - 1 }} 个绑定域名
                  </span>
                </div>
              </template>
            </el-table-column>

            <el-table-column label="状态" width="110">
              <template #default="{ row }">
                <span class="pill" :class="row.status === 'running' ? 'pill--ok' : 'pill--off'">
                  {{ row.status === 'running' ? '运行中' : '已停止' }}
                </span>
              </template>
            </el-table-column>

            <el-table-column label="证书" width="118">
              <template #default="{ row }">
                <span class="cert" :class="`cert--${certTone(row.cert)}`">{{ certText(row.cert) }}</span>
              </template>
            </el-table-column>

            <el-table-column label="类型 / 版本" width="120">
              <template #default="{ row }">
                <span class="muted">{{ row.projectType }}</span>
                <span class="muted-xs"> · {{ row.phpVersion }}</span>
              </template>
            </el-table-column>

            <el-table-column label="网站目录" min-width="150" show-overflow-tooltip>
              <template #default="{ row }">
                <span class="mono">{{ row.path || '—' }}</span>
              </template>
            </el-table-column>

            <el-table-column label="备注" min-width="100" show-overflow-tooltip>
              <template #default="{ row }">{{ row.ps || '—' }}</template>
            </el-table-column>

            <el-table-column label="操作" width="210" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openDetail(row)">详情</el-button>
                <el-button link type="primary" @click="openSsl(row)">申请证书</el-button>
                <el-button link type="danger" @click="confirmRemove(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
        <div v-if="total > query.limit" class="pager">
          <el-pagination
            v-model:current-page="query.page"
            :page-size="query.limit"
            :total="total"
            layout="prev, pager, next, total"
            background
            @current-change="reload()"
          />
        </div>
      </template>
    </section>

    <!-- ==================== 新建网站 ==================== -->
    <el-dialog v-model="createVisible" title="新建网站" width="520px" :close-on-click-modal="false" @closed="resetCreate">
      <el-form ref="createFormRef" :model="createForm" :rules="createRules" label-position="top">
        <el-form-item label="网站域名" prop="domain">
          <el-input v-model="createForm.domain" placeholder="例如 demo.example.com" clearable />
          <p class="form-tip">会在宝塔创建一个「纯静态」站点，目录默认为 /www/wwwroot/&lt;域名&gt;</p>
        </el-form-item>

        <el-form-item label="网站目录（选填）" prop="path">
          <el-input v-model="createForm.path" placeholder="留空则自动填 /www/wwwroot/<域名>" clearable />
        </el-form-item>

        <el-form-item label="备注（选填）" prop="ps">
          <el-input v-model="createForm.ps" placeholder="例如：公司官网" clearable maxlength="60" show-word-limit />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="submitCreate">
          {{ creating ? '正在创建…' : '确认创建' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- ==================== 站点详情（概览 / 日志 / 配置） ==================== -->
    <el-drawer v-model="detailVisible" title="站点详情" size="480px" @closed="resetDetail">
      <template v-if="detail">
        <el-tabs v-model="detailTab" class="detail-tabs">
          <!-- ---------- 概览 ---------- -->
          <el-tab-pane label="概览" name="info">
            <el-descriptions :column="1" border>
              <el-descriptions-item label="站点名称">{{ detail.name }}</el-descriptions-item>
              <el-descriptions-item label="绑定域名">
                <span v-if="detail.domains.length" class="mono">{{ detail.domains.join('、') }}</span>
                <span v-else class="muted">—</span>
              </el-descriptions-item>
              <el-descriptions-item label="运行状态">
                {{ detail.status === 'running' ? '运行中' : '已停止' }}
              </el-descriptions-item>
              <el-descriptions-item label="证书状态">
                <span class="cert" :class="`cert--${certTone(detail.cert)}`">{{ certText(detail.cert) }}</span>
                <span v-if="detail.cert?.hasCert" class="muted-xs">（{{ detail.cert.validToText }} 到期）</span>
              </el-descriptions-item>
              <el-descriptions-item label="项目类型">{{ detail.projectType }} · PHP {{ detail.phpVersion }}</el-descriptions-item>
              <el-descriptions-item label="网站目录">
                <span class="mono">{{ detail.path || '—' }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="备注">{{ detail.ps || '—' }}</el-descriptions-item>
              <el-descriptions-item label="添加时间">{{ detail.addTime || '—' }}</el-descriptions-item>
            </el-descriptions>
          </el-tab-pane>

          <!-- ---------- 日志（访问 / 错误共用一套面板） ---------- -->
          <el-tab-pane label="访问日志" name="access" lazy>
            <div class="logbar">
              <el-select v-model="logPanel.lines" size="small" class="logbar__lines" @change="loadLogs">
                <el-option :value="100" label="最后 100 行" />
                <el-option :value="200" label="最后 200 行" />
                <el-option :value="500" label="最后 500 行" />
                <el-option :value="1000" label="最后 1000 行" />
              </el-select>
              <span class="logbar__meta tnum">
                {{ logPanel.path || '—' }}<template v-if="logPanel.totalLines"> · 共 {{ logPanel.totalLines }} 行</template>
              </span>
              <el-button size="small" :loading="logPanel.loading" @click="loadLogs">
                <el-icon><Refresh /></el-icon>
              </el-button>
              <CopyBtn :text="logPanel.content" title="复制日志内容" ok-message="日志已复制" />
            </div>
            <StateBlock v-if="logPanel.loading" state="loading" loading-text="正在读取日志…" />
            <StateBlock v-else-if="logPanel.error" state="error" title="日志读取失败" :description="logPanel.error" action-text="重试" @action="loadLogs" />
            <StateBlock v-else-if="!logPanel.content.trim()" state="empty" title="日志还是空的" description="该站点还没有产生访问记录。" />
            <pre v-else class="console">{{ logPanel.content }}</pre>
          </el-tab-pane>

          <el-tab-pane label="错误日志" name="error" lazy>
            <div class="logbar">
              <el-select v-model="logPanel.lines" size="small" class="logbar__lines" @change="loadLogs">
                <el-option :value="100" label="最后 100 行" />
                <el-option :value="200" label="最后 200 行" />
                <el-option :value="500" label="最后 500 行" />
                <el-option :value="1000" label="最后 1000 行" />
              </el-select>
              <span class="logbar__meta tnum">
                {{ logPanel.path || '—' }}<template v-if="logPanel.totalLines"> · 共 {{ logPanel.totalLines }} 行</template>
              </span>
              <el-button size="small" :loading="logPanel.loading" @click="loadLogs">
                <el-icon><Refresh /></el-icon>
              </el-button>
              <CopyBtn :text="logPanel.content" title="复制日志内容" ok-message="日志已复制" />
            </div>
            <StateBlock v-if="logPanel.loading" state="loading" loading-text="正在读取日志…" />
            <StateBlock v-else-if="logPanel.error" state="error" title="日志读取失败" :description="logPanel.error" action-text="重试" @action="loadLogs" />
            <StateBlock v-else-if="!logPanel.content.trim()" state="empty" title="没有错误日志" description="这是好事 —— 该站点近期没有产生错误。" />
            <pre v-else class="console">{{ logPanel.content }}</pre>
          </el-tab-pane>

          <!-- ---------- Nginx 配置 ---------- -->
          <el-tab-pane label="Nginx 配置" name="config" lazy>
            <div class="logbar">
              <span class="logbar__meta mono">{{ configPanel.confPath || '—' }}</span>
              <el-button size="small" :loading="configPanel.loading" @click="loadConfig">
                <el-icon><Refresh /></el-icon>
              </el-button>
              <CopyBtn :text="configPanel.content" title="复制配置内容" ok-message="配置已复制" />
            </div>
            <StateBlock v-if="configPanel.loading" state="loading" loading-text="正在读取配置…" />
            <StateBlock v-else-if="configPanel.error" state="error" title="配置读取失败" :description="configPanel.error" action-text="重试" @action="loadConfig" />
            <pre v-else class="console">{{ configPanel.content }}</pre>
            <p class="drawer-tip">
              此页仅用于查看。修改配置请让 AI 通过 MCP 的 <code>save_nginx_config</code> 执行 —— 它会先备份再写入，并自动重载 Nginx。
            </p>
          </el-tab-pane>
        </el-tabs>
      </template>

      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
      </template>
    </el-drawer>

    <!-- ==================== 申请 SSL ==================== -->
    <el-dialog v-model="sslVisible" title="申请 SSL 证书" width="560px" :close-on-click-modal="false">
      <p class="form-tip form-tip--standalone">
        为站点 <strong>{{ sslTarget?.name }}</strong> 配置 HTTPS。
      </p>

      <el-radio-group v-model="sslForm.mode" class="ssl-modes">
        <el-radio value="letsencrypt">自动申请（Let's Encrypt 免费证书，推荐）</el-radio>
        <el-radio value="manual">手动部署（粘贴自有证书）</el-radio>
      </el-radio-group>

      <template v-if="sslForm.mode === 'manual'">
        <el-form-item label="证书内容（PEM，含证书链）">
          <el-input v-model="sslForm.cert" type="textarea" :rows="5" placeholder="-----BEGIN CERTIFICATE-----" />
        </el-form-item>
        <el-form-item label="私钥内容（PEM）">
          <el-input v-model="sslForm.key" type="textarea" :rows="4" placeholder="-----BEGIN PRIVATE KEY-----" />
        </el-form-item>
      </template>

      <el-alert
        v-else
        type="info"
        :closable="false"
        show-icon
        title="申请前请确认"
        description="域名需已解析到本服务器并可通过 80 端口访问；若域名开启了 Cloudflare 代理，访客侧 HTTPS 已由边缘证书提供，源站证书属可选加固。"
      />

      <template #footer>
        <el-button @click="sslVisible = false">取消</el-button>
        <el-button type="primary" :loading="sslSubmitting" @click="submitSsl">
          {{ sslSubmitting ? '提交中…' : '提交申请' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
// 深路径导入：不要改回 'element-plus'（barrel 入口会阻止 tree-shaking，详见 main.js）
import { ElMessage } from 'element-plus/es/components/message/index';
import { ElMessageBox } from 'element-plus/es/components/message-box/index';
import CopyBtn from '@/components/CopyBtn.vue';
import StateBlock from '@/components/StateBlock.vue';
import { useNarrow } from '@/composables/useNarrow';
import { websiteApi } from '@/api';

const loading = ref(false);
const state = ref('loading'); // loading | error | empty | ready
const errorMessage = ref('');
const rows = ref([]);
const total = ref(0);

/** 窄屏用卡片视图替代表格（断点与主布局的侧栏收起点保持一致） */
const isNarrow = useNarrow(900);

const query = reactive({ page: 1, limit: 20, search: '' });

const DOMAIN_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

// ---------------- 列表 ----------------
async function reload(page) {
  if (typeof page === 'number') query.page = page;

  loading.value = true;
  state.value = 'loading';
  try {
    // 站点列表与证书台账并行拉取；证书是增值信息，取不到不该让整页失败
    const [data, certData] = await Promise.all([
      websiteApi.list({ ...query }),
      websiteApi.sslCerts().catch(() => null),
    ]);
    const bySite = new Map((certData?.certs || []).map((c) => [c.siteName, c]));
    rows.value = (data.list || []).map((r) => ({ ...r, cert: bySite.get(r.name) || null }));
    total.value = data.total || 0;
    state.value = rows.value.length ? 'ready' : 'empty';
  } catch (err) {
    errorMessage.value = err.message || '未知错误';
    state.value = 'error';
  } finally {
    loading.value = false;
  }
}

/** 证书倒计时文案：与宝塔面板口径一致（剩余 ≤15 天为「即将到期」） */
function certText(cert) {
  if (!cert || !cert.hasCert) return '未部署';
  if (cert.status === 'expired') return `已过期 ${Math.abs(cert.daysLeft)} 天`;
  return `剩余 ${cert.daysLeft} 天`;
}

function certTone(cert) {
  if (!cert || !cert.hasCert) return 'none';
  return cert.status;
}

function onEmptyAction() {
  if (query.search) {
    query.search = '';
    reload(1);
  }
}

// ---------------- 新建 ----------------
const createVisible = ref(false);
const creating = ref(false);
const createFormRef = ref(null);
const createForm = reactive({ domain: '', path: '', ps: '' });

const createRules = {
  domain: [
    { required: true, message: '请输入网站域名', trigger: 'blur' },
    {
      validator: (_rule, value, callback) => {
        if (!value) return callback();
        return DOMAIN_RE.test(String(value).trim().toLowerCase())
          ? callback()
          : callback(new Error('域名格式不正确，例如 demo.example.com'));
      },
      trigger: 'blur',
    },
  ],
};

function openCreate() {
  createVisible.value = true;
}

function resetCreate() {
  createFormRef.value?.resetFields();
  createForm.domain = '';
  createForm.path = '';
  createForm.ps = '';
}

async function submitCreate() {
  try {
    await createFormRef.value.validate();
  } catch {
    return;
  }

  creating.value = true;
  try {
    await websiteApi.create({
      domain: createForm.domain.trim().toLowerCase(),
      path: createForm.path.trim(),
      ps: createForm.ps.trim(),
    });
    ElMessage.success('网站创建成功');
    createVisible.value = false;
    reload(1);
  } catch {
    // 错误提示已由拦截器统一弹出（例如「网站已存在」）
  } finally {
    creating.value = false;
  }
}

// ---------------- 详情 ----------------
const detailVisible = ref(false);
const detail = ref(null);
const detailTab = ref('info');

const logPanel = reactive({ loading: false, error: '', content: '', path: '', totalLines: 0, lines: 200 });
const configPanel = reactive({ loading: false, error: '', content: '', confPath: '' });

async function openDetail(row) {
  detail.value = row;
  detailTab.value = 'info';
  detailVisible.value = true;
  try {
    // 详情接口不返回证书信息，用列表里已有的数据兜底补齐
    const fetched = await websiteApi.detail(row.name);
    detail.value = { ...fetched, cert: row.cert || null };
  } catch {
    // 拉详情失败时先用列表里的数据兜底展示
  }
}

function resetDetail() {
  detail.value = null;
  detailTab.value = 'info';
  Object.assign(logPanel, { loading: false, error: '', content: '', path: '', totalLines: 0 });
  Object.assign(configPanel, { loading: false, error: '', content: '', confPath: '' });
}

async function loadLogs() {
  if (!detail.value) return;
  const type = detailTab.value === 'error' ? 'error' : 'access';
  logPanel.loading = true;
  logPanel.error = '';
  try {
    const data = await websiteApi.logs(detail.value.name, { type, lines: logPanel.lines });
    logPanel.content = data.content || '';
    logPanel.path = data.path || '';
    logPanel.totalLines = data.totalLines || 0;
  } catch (err) {
    logPanel.error = err.message || '读取失败';
    logPanel.content = '';
  } finally {
    logPanel.loading = false;
  }
}

async function loadConfig() {
  if (!detail.value) return;
  configPanel.loading = true;
  configPanel.error = '';
  try {
    const data = await websiteApi.nginxConfig(detail.value.name);
    configPanel.content = data.content || '';
    configPanel.confPath = data.confPath || '';
    if (!configPanel.content) configPanel.error = '该站点暂无 Nginx 配置文件';
  } catch (err) {
    configPanel.error = err.message || '读取失败';
    configPanel.content = '';
  } finally {
    configPanel.loading = false;
  }
}

// 切到日志 / 配置页时才去拉数据（懒加载，避免每次点详情都多打三次接口）
watch(detailTab, (tab) => {
  if (tab === 'access' || tab === 'error') loadLogs();
  else if (tab === 'config') loadConfig();
});

// ---------------- 删除 ----------------
async function confirmRemove(row) {
  try {
    await ElMessageBox.confirm(
      `确定要删除网站「${row.name}」吗？站点目录 ${row.path || ''} 也会一并删除，该操作不可恢复。`,
      '删除确认',
      { confirmButtonText: '确认删除', cancelButtonText: '取消', type: 'warning', confirmButtonClass: 'el-button--danger' }
    );
  } catch {
    return;
  }

  try {
    await websiteApi.remove(row.name);
    ElMessage.success(`已删除：${row.name}`);
    reload(rows.value.length === 1 && query.page > 1 ? query.page - 1 : undefined);
  } catch {
    /* 拦截器已提示 */
  }
}

// ---------------- SSL ----------------
const sslVisible = ref(false);
const sslSubmitting = ref(false);
const sslTarget = ref(null);
const sslForm = reactive({ mode: 'letsencrypt', cert: '', key: '' });

function openSsl(row) {
  sslTarget.value = row;
  sslForm.mode = 'letsencrypt';
  sslForm.cert = '';
  sslForm.key = '';
  sslVisible.value = true;
}

async function submitSsl() {
  if (sslForm.mode === 'manual' && (!sslForm.cert.trim() || !sslForm.key.trim())) {
    ElMessage.warning('手动部署需要同时填写证书与私钥');
    return;
  }

  sslSubmitting.value = true;
  try {
    const payload =
      sslForm.mode === 'manual'
        ? { mode: 'manual', cert: sslForm.cert, key: sslForm.key }
        : { mode: 'letsencrypt' };
    const data = await websiteApi.applySsl(sslTarget.value.name, payload);
    ElMessage.success(data.message || '证书申请已提交');
    sslVisible.value = false;
  } catch {
    /* 拦截器已提示 */
  } finally {
    sslSubmitting.value = false;
  }
}

onMounted(() => reload(1));
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
}

.toolbar__search {
  width: 260px;
}

.toolbar__count {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

.toolbar__count strong {
  color: var(--text-primary);
}

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

/* 证书倒计时：数字等宽，颜色即状态 */
.cert {
  font-size: var(--fs-xs);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.cert--ok {
  color: var(--success);
}
.cert--expiring {
  color: var(--warning);
}
.cert--expired {
  color: var(--danger);
}
.cert--none {
  color: var(--text-tertiary);
}

/* ---------------- 详情抽屉 ---------------- */
.detail-tabs :deep(.el-tabs__header) {
  margin-bottom: var(--sp-4);
}

.logbar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}

.logbar__lines {
  width: 132px;
  flex: 0 0 auto;
}

.logbar__meta {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 日志 / 配置查看器：终端质感，等宽字体、可滚动 */
.console {
  margin: 0;
  padding: var(--sp-3) var(--sp-4);
  max-height: 52vh;
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

.drawer-tip {
  margin-top: var(--sp-3);
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-tertiary);
}

.drawer-tip code {
  padding: 1px 5px;
  border-radius: var(--r-xs);
  background: var(--bg-subtle);
  font-family: 'SFMono-Regular', Consolas, Menlo, monospace;
  color: var(--text-secondary);
}

.pager {
  padding: var(--sp-3) var(--sp-5);
  border-top: 1px solid var(--border-hairline);
}

.form-tip {
  margin-top: 4px;
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-tertiary);
}

.form-tip--standalone {
  margin-bottom: var(--sp-4);
}

.ssl-modes {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-2);
  margin-bottom: var(--sp-4);
}

@media (max-width: 768px) {
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
}
</style>
