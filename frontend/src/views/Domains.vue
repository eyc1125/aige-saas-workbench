<template>
  <div class="page">
    <ReadOnlyNotice what="添加 / 修改 / 删除 DNS 解析、切换代理开关" />

    <section class="split">
      <!-- ==================== 左：域名区域 ==================== -->
      <aside class="surface zones">
        <header class="zones__head">
          <div>
            <h2 class="zones__title">域名区域</h2>
            <p class="zones__sub">Cloudflare 托管中的主域名</p>
          </div>
          <el-button text :loading="zonesLoading" @click="loadZones">
            <el-icon><Refresh /></el-icon>
          </el-button>
        </header>

        <div v-if="zones.length" class="zones__search">
          <el-input v-model="zoneKeyword" placeholder="筛选域名" clearable size="small">
            <template #prefix
              ><el-icon><Search /></el-icon
            ></template>
          </el-input>
        </div>

        <StateBlock
          v-if="zonesState === 'loading'"
          state="loading"
          loading-text="正在读取域名列表…"
        />
        <StateBlock
          v-else-if="zonesState === 'error'"
          state="error"
          title="读取域名失败"
          :description="zonesError"
          action-text="重试"
          @action="loadZones"
        />
        <StateBlock
          v-else-if="zonesState === 'empty'"
          state="empty"
          title="暂无域名区域"
          description="请到「系统设置」填写 Cloudflare API Token（需 Zone:Read 权限）。"
        />

        <ul v-else class="zones__list">
          <li
            v-for="zone in filteredZones"
            :key="zone.id"
            class="zones__item"
            :class="{ 'zones__item--active': zone.id === activeZoneId }"
            @click="selectZone(zone)"
          >
            <span class="zones__dot" :class="zone.status === 'active' ? 'is-on' : 'is-off'" />
            <span class="zones__text">
              <strong>{{ zone.name }}</strong>
              <em>{{ zone.plan }}</em>
            </span>
            <el-icon class="zones__caret"><ArrowRight /></el-icon>
          </li>
        </ul>
      </aside>

      <!-- ==================== 右：解析记录 ==================== -->
      <div class="surface records">
        <header class="records__head">
          <div class="records__titles">
            <h2 class="records__title">
              {{ activeZone ? activeZone.name : '解析记录' }}
            </h2>
            <p class="records__sub">
              <template v-if="activeZone">
                <span class="mono">{{ activeZone.id }}</span> · 共 {{ records.length }} 条
              </template>
              <template v-else>请先在左侧选择一个域名区域</template>
            </p>
          </div>

          <div class="records__actions">
            <el-select
              v-model="filterType"
              placeholder="全部类型"
              clearable
              size="default"
              class="records__filter"
              @change="loadRecords"
            >
              <el-option v-for="t in TYPES" :key="t" :label="t" :value="t" />
            </el-select>
            <el-button :disabled="!activeZone" :loading="recordsLoading" @click="loadRecords">
              <el-icon><Refresh /></el-icon>刷新
            </el-button>
            <el-button v-if="auth.canWrite" type="primary" :disabled="!activeZone" @click="openAdd">
              <el-icon><Plus /></el-icon>添加解析
            </el-button>
          </div>
        </header>

        <StateBlock
          v-if="!activeZone"
          state="empty"
          title="还没有选中域名"
          description="选中左侧任意域名区域后，这里会显示它名下的全部 DNS 解析。"
        />
        <StateBlock
          v-else-if="recordsState === 'loading'"
          state="loading"
          loading-text="正在读取解析记录…"
        />
        <StateBlock
          v-else-if="recordsState === 'error'"
          state="error"
          title="读取解析记录失败"
          :description="recordsError"
          action-text="重试"
          @action="loadRecords"
        />
        <StateBlock
          v-else-if="recordsState === 'empty'"
          state="empty"
          title="该域名下没有解析记录"
          description="点击右上角「添加解析」创建第一条记录。"
        />

        <template v-else>
          <!-- 窄屏：卡片视图（6 列表格在手机上无法阅读） -->
          <ul v-if="isNarrow" class="cards">
            <li v-for="row in records" :key="row.id" class="card">
              <div class="card__head">
                <div class="card__title">
                  <span class="copyable">
                    <span class="copyable__text">{{ row.name }}</span>
                    <CopyBtn :text="row.name" title="复制名称" ok-message="名称已复制" />
                  </span>
                  <span class="card__sub">{{ row.ttl === 1 ? 'TTL 自动' : `TTL ${row.ttl}` }}</span>
                </div>
                <span class="type-badge">{{ row.type }}</span>
              </div>

              <dl class="card__meta">
                <div class="card__meta-row">
                  <dt>记录值</dt>
                  <dd>
                    <span class="copyable">
                      <span class="mono copyable__text">{{ row.content }}</span>
                      <CopyBtn :text="row.content" title="复制记录值" ok-message="记录值已复制" />
                    </span>
                  </dd>
                </div>
                <div v-if="row.proxiable" class="card__meta-row">
                  <dt>代理</dt>
                  <dd>
                    <el-switch
                      :model-value="row.proxied"
                      :loading="row.__switching"
                      :disabled="!auth.canWrite"
                      @change="(val) => toggleProxy(row, val)"
                    />
                  </dd>
                </div>
              </dl>

              <div class="card__actions">
                <el-button v-if="auth.canWrite" type="danger" plain @click="confirmRemove(row)"
                  >删除</el-button
                >
              </div>
            </li>
          </ul>

          <!-- 宽屏：表格 -->
          <div v-else class="table-wrap">
            <el-table :data="records" row-key="id" style="width: 100%">
              <el-table-column label="类型" width="88">
                <template #default="{ row }">
                  <span class="type-badge">{{ row.type }}</span>
                </template>
              </el-table-column>

              <el-table-column label="名称" min-width="220">
                <template #default="{ row }">
                  <span class="copyable">
                    <span class="cell-name copyable__text">{{ row.name }}</span>
                    <CopyBtn :text="row.name" title="复制名称" ok-message="名称已复制" />
                  </span>
                </template>
              </el-table-column>

              <el-table-column label="记录值" min-width="220">
                <template #default="{ row }">
                  <span class="copyable">
                    <span class="mono copyable__text">{{ row.content }}</span>
                    <CopyBtn :text="row.content" title="复制记录值" ok-message="记录值已复制" />
                  </span>
                </template>
              </el-table-column>

              <el-table-column label="代理" width="96">
                <template #default="{ row }">
                  <el-switch
                    v-if="row.proxiable"
                    :model-value="row.proxied"
                    :loading="row.__switching"
                    :disabled="!auth.canWrite"
                    @change="(val) => toggleProxy(row, val)"
                  />
                  <span v-else class="muted-xs">—</span>
                </template>
              </el-table-column>

              <el-table-column label="TTL" width="88">
                <template #default="{ row }">
                  <span class="muted-xs">{{ row.ttl === 1 ? '自动' : row.ttl }}</span>
                </template>
              </el-table-column>

              <el-table-column label="操作" width="90" fixed="right">
                <template #default="{ row }">
                  <el-button v-if="auth.canWrite" link type="danger" @click="confirmRemove(row)"
                    >删除</el-button
                  >
                  <span v-else class="muted-xs">—</span>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </template>
      </div>
    </section>

    <!-- ==================== 添加解析 ==================== -->
    <el-dialog
      v-model="addVisible"
      title="添加解析记录"
      width="520px"
      :close-on-click-modal="false"
      @closed="resetAdd"
    >
      <el-form ref="addFormRef" :model="addForm" :rules="addRules" label-position="top">
        <el-form-item label="记录类型" prop="type">
          <el-select v-model="addForm.type" class="w-full">
            <el-option v-for="t in ADD_TYPES" :key="t" :label="t" :value="t" />
          </el-select>
        </el-form-item>

        <el-form-item label="记录名" prop="name">
          <el-input v-model="addForm.name" :placeholder="namePlaceholder" clearable>
            <template #prepend v-if="activeZone">{{ activeZone.name }}</template>
          </el-input>
          <p class="form-tip">{{ nameTip }}</p>
        </el-form-item>

        <el-form-item label="记录值" prop="content">
          <el-input v-model="addForm.content" :placeholder="contentPlaceholder" clearable />
        </el-form-item>

        <el-form-item v-if="['A', 'AAAA', 'CNAME'].includes(addForm.type)" label="Cloudflare 代理">
          <el-switch
            v-model="addForm.proxied"
            active-text="开启（橙色云，隐藏源站 IP）"
            inactive-text="关闭（灰色云，直连源站）"
          />
        </el-form-item>

        <el-form-item v-if="addForm.type === 'MX'" label="优先级">
          <el-input-number v-model="addForm.priority" :min="0" :max="65535" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="addVisible = false">取消</el-button>
        <el-button type="primary" :loading="addSubmitting" @click="submitAdd">
          {{ addSubmitting ? '提交中…' : '确认添加' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
// 深路径导入：不要改回 'element-plus'（barrel 入口会阻止 tree-shaking，详见 main.js）
import { ElMessage } from 'element-plus/es/components/message/index';
import { ElMessageBox } from 'element-plus/es/components/message-box/index';
import CopyBtn from '@/components/CopyBtn.vue';
import ReadOnlyNotice from '@/components/ReadOnlyNotice.vue';
import StateBlock from '@/components/StateBlock.vue';
import { useNarrow } from '@/composables/useNarrow';
import { domainApi } from '@/api';
import { useAuthStore } from '@/stores/auth';

const TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA'];
const ADD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS'];

// 只读身份下隐藏写操作入口（代理开关用 disabled，删除/添加用 v-if）
const auth = useAuthStore();

// ---------------- 区域列表 ----------------
const zones = ref([]);
const zonesState = ref('loading');
const zonesError = ref('');
const zonesLoading = ref(false);
const zoneKeyword = ref('');

/** 窄屏用卡片视图替代表格（断点与主布局的侧栏收起点保持一致） */
const isNarrow = useNarrow(900);
const activeZoneId = ref('');

const filteredZones = computed(() => {
  const kw = zoneKeyword.value.trim().toLowerCase();
  return kw ? zones.value.filter((z) => z.name.toLowerCase().includes(kw)) : zones.value;
});

const activeZone = computed(() => zones.value.find((z) => z.id === activeZoneId.value) || null);

async function loadZones() {
  zonesLoading.value = true;
  zonesState.value = 'loading';
  try {
    const data = await domainApi.zones();
    zones.value = data.list || [];
    zonesState.value = zones.value.length ? 'ready' : 'empty';
    // 首次进入自动选中第一个区域
    if (zones.value.length && !activeZoneId.value) {
      selectZone(zones.value[0]);
    }
  } catch (err) {
    zonesError.value = err.message || '未知错误';
    zonesState.value = 'error';
  } finally {
    zonesLoading.value = false;
  }
}

function selectZone(zone) {
  activeZoneId.value = zone.id;
  loadRecords();
}

// ---------------- 解析记录 ----------------
const records = ref([]);
const recordsState = ref('empty');
const recordsError = ref('');
const recordsLoading = ref(false);
const filterType = ref('');

async function loadRecords() {
  if (!activeZoneId.value) return;

  recordsLoading.value = true;
  recordsState.value = 'loading';
  try {
    const data = await domainApi.records(activeZoneId.value, { type: filterType.value });
    records.value = (data.list || []).map((r) => ({ ...r, __switching: false }));
    recordsState.value = records.value.length ? 'ready' : 'empty';
  } catch (err) {
    recordsError.value = err.message || '未知错误';
    recordsState.value = 'error';
  } finally {
    recordsLoading.value = false;
  }
}

/** 切换橙色云 / 灰色云 */
async function toggleProxy(row, value) {
  row.__switching = true;
  const previous = row.proxied;
  row.proxied = value;
  try {
    await domainApi.updateRecord(activeZoneId.value, row.id, { proxied: value });
    ElMessage.success(value ? '已开启 Cloudflare 代理' : '已关闭代理，改为直连源站');
  } catch {
    row.proxied = previous; // 失败回滚，避免界面与真实状态不一致
  } finally {
    row.__switching = false;
  }
}

async function confirmRemove(row) {
  try {
    await ElMessageBox.confirm(
      `确定删除解析「${row.name} → ${row.content}」吗？删除后域名将立即无法解析，且不可恢复。`,
      '删除确认',
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
    await domainApi.removeRecord(activeZoneId.value, row.id);
    ElMessage.success('解析已删除');
    loadRecords();
  } catch {
    /* 拦截器已提示 */
  }
}

// ---------------- 添加解析 ----------------
const addVisible = ref(false);
const addSubmitting = ref(false);
const addFormRef = ref(null);
const addForm = reactive({ type: 'A', name: '', content: '', proxied: true, priority: 10 });

const namePlaceholder = computed(() => (addForm.type === 'CNAME' ? 'cdn' : 'test'));
const contentPlaceholder = computed(() => {
  if (addForm.type === 'A') return '例如 120.53.102.56';
  if (addForm.type === 'AAAA') return '例如 2400:3200::1';
  if (addForm.type === 'CNAME') return '例如 target.example.com';
  if (addForm.type === 'TXT') return '例如 v=spf1 include:example.com ~all';
  if (addForm.type === 'MX') return '例如 mx1.example.com';
  return '记录值';
});

const nameTip = computed(() => {
  if (addForm.name === '@' || addForm.name === '')
    return '填 @ 表示主域名本身（' + (activeZone.value?.name || '') + '）';
  return '子域名只填前缀即可，系统会补全为完整域名';
});

const addRules = {
  type: [{ required: true, message: '请选择记录类型', trigger: 'change' }],
  name: [{ required: true, message: '请输入记录名（主域名填 @）', trigger: 'blur' }],
  content: [{ required: true, message: '请输入记录值', trigger: 'blur' }],
};

function openAdd() {
  addForm.type = 'A';
  addForm.name = '';
  addForm.content = '';
  addForm.proxied = true;
  addForm.priority = 10;
  addVisible.value = true;
}

function resetAdd() {
  addFormRef.value?.resetFields();
}

async function submitAdd() {
  try {
    await addFormRef.value.validate();
  } catch {
    return;
  }

  // 把前缀拼成 Cloudflare 需要的完整记录名
  const raw = addForm.name.trim();
  const zoneName = activeZone.value?.name || '';
  let fullName;
  if (raw === '@' || raw === '') fullName = zoneName;
  else if (raw.endsWith(zoneName)) fullName = raw;
  else fullName = `${raw}.${zoneName}`;

  // A 记录且开启代理时，源站 IP 由后端自动补齐（留空即用服务器公网 IP）
  const content = addForm.content.trim();

  addSubmitting.value = true;
  try {
    await domainApi.addRecord(activeZoneId.value, {
      type: addForm.type,
      name: fullName,
      content,
      proxied: addForm.proxied,
      priority: addForm.type === 'MX' ? addForm.priority : undefined,
    });
    ElMessage.success('解析已添加');
    addVisible.value = false;
    loadRecords();
  } catch {
    /* 拦截器已提示 */
  } finally {
    addSubmitting.value = false;
  }
}

onMounted(loadZones);
</script>

<style scoped>
.split {
  display: grid;
  grid-template-columns: 292px minmax(0, 1fr);
  gap: var(--sp-4);
  align-items: start;
}

/* ---------------- 左栏 ---------------- */
.zones {
  display: flex;
  flex-direction: column;
  max-height: calc(100dvh - 140px);
  overflow: hidden;
}

.zones__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: var(--sp-4) var(--sp-4) var(--sp-3);
  border-bottom: 1px solid var(--border-hairline);
}

.zones__title {
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text-primary);
}

.zones__sub {
  margin-top: 2px;
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}

.zones__search {
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--border-hairline);
}

.zones__list {
  margin: 0;
  padding: var(--sp-2);
  list-style: none;
  overflow-y: auto;
  flex: 1;
}

.zones__item {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3);
  border-radius: var(--r-md);
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease);
}

.zones__item:hover {
  background: var(--bg-hover);
}

.zones__item--active {
  background: var(--brand-soft);
  box-shadow: inset 0 0 0 1px var(--brand-soft-border);
}

.zones__dot {
  width: 7px;
  height: 7px;
  flex: 0 0 7px;
  border-radius: 50%;
}

.zones__dot.is-on {
  background: var(--success);
}

.zones__dot.is-off {
  background: var(--text-disabled);
}

.zones__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.zones__text strong {
  font-size: var(--fs-base);
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.zones__text em {
  font-size: var(--fs-xs);
  font-style: normal;
  color: var(--text-tertiary);
}

.zones__caret {
  font-size: 12px;
  color: var(--text-tertiary);
}

.zones__item--active .zones__caret {
  color: var(--brand);
}

/* ---------------- 右栏 ---------------- */
.records {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.records__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-4);
  flex-wrap: wrap;
  padding: var(--sp-4) var(--sp-5);
  border-bottom: 1px solid var(--border-hairline);
}

.records__title {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-primary);
}

.records__sub {
  margin-top: 2px;
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  overflow-wrap: anywhere;
}

.records__actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.records__filter {
  width: 118px;
}

.type-badge {
  display: inline-block;
  min-width: 42px;
  padding: 1px 6px;
  border-radius: var(--r-xs);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: var(--fs-xs);
  font-weight: 600;
  text-align: center;
}

.cell-name {
  font-weight: 500;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.w-full {
  width: 100%;
}

.form-tip {
  margin-top: 4px;
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}

@media (max-width: 1024px) {
  .split {
    grid-template-columns: minmax(0, 1fr);
  }

  .zones {
    max-height: none;
  }

  .zones__list {
    max-height: 300px;
  }
}

@media (max-width: 640px) {
  .records__actions {
    width: 100%;
    flex-wrap: wrap;
  }

  .records__filter {
    flex: 1;
    min-width: 110px;
  }
}
</style>
