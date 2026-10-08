<template>
  <div class="page">
    <ReadOnlyNotice what="一键修复、开关自动自愈、调整巡检间隔" />
    <!-- ==================== 巡检结论 ==================== -->
    <!-- 加载 / 失败中不显示结论：此时 summary 全是 0，会误报成「尚未巡检」 -->
    <section v-if="state === 'ready'" class="verdict" :class="`verdict--${verdict.tone}`">
      <span class="verdict__icon" aria-hidden="true"
        ><el-icon><component :is="verdict.icon" /></el-icon
      ></span>
      <div class="verdict__text">
        <strong>{{ verdict.title }}</strong>
        <p>{{ verdict.desc }}</p>
      </div>
      <div class="verdict__actions">
        <el-button :loading="loading" @click="load">
          <el-icon><Refresh /></el-icon>重新巡检
        </el-button>
      </div>
    </section>

    <!-- 加载中：先给一条明确的等待提示，而不是留白（巡检要读证书、查云端、列容器） -->
    <section v-else-if="state === 'loading'" class="verdict verdict--neutral">
      <span class="verdict__icon" aria-hidden="true"
        ><el-icon><FirstAidKit /></el-icon
      ></span>
      <div class="verdict__text">
        <strong>正在巡检…</strong>
        <p>要读全站证书、查 Cloudflare、列容器，通常几秒钟，请稍候。</p>
      </div>
    </section>

    <!-- ==================== 自动自愈 ==================== -->
    <section class="surface auto">
      <header class="auto__head">
        <div class="auto__title">
          <span class="auto__icon" aria-hidden="true"
            ><el-icon><FirstAidKit /></el-icon
          ></span>
          <div>
            <h2>自动自愈</h2>
            <p>开启后会按固定间隔自动跑巡检，只执行「标记为可自动」的低风险修复</p>
          </div>
        </div>
        <div class="auto__switch">
          <span class="auto__state" :class="autoHeal.enabled ? 'is-on' : 'is-off'">
            {{ autoHeal.enabled ? '已开启' : '已关闭' }}
          </span>
          <el-switch
            v-model="autoHeal.enabled"
            :loading="autoSaving"
            :disabled="!auth.canWrite"
            @change="toggleAuto"
          />
        </div>
      </header>

      <div class="auto__body">
        <div class="auto__row">
          <span class="auto__label">巡检间隔</span>
          <el-select
            v-model="autoHeal.intervalMin"
            class="auto__select"
            :disabled="autoSaving || !auth.canWrite"
            @change="saveAuto"
          >
            <el-option :value="10" label="每 10 分钟" />
            <el-option :value="30" label="每 30 分钟" />
            <el-option :value="60" label="每 1 小时" />
            <el-option :value="180" label="每 3 小时" />
            <el-option :value="360" label="每 6 小时" />
          </el-select>
          <el-button v-if="auth.canWrite" :loading="autoRunning" @click="runAutoNow">
            <el-icon><RefreshRight /></el-icon>立即执行一次
          </el-button>
        </div>

        <div class="auto__rules">
          <span class="auto__rule">
            <strong>会</strong>自动执行：证书续签、启动本项目停掉的容器、清理无用镜像
          </span>
          <span class="auto__rule">
            <strong>不会</strong>自动执行：改 Cloudflare zone 级 SSL
            模式、改密码、补站点证书（风险较高，需你确认）
          </span>
          <span class="auto__rule auto__rule--warn">
            熔断：同一修复 30 分钟内最多 3 次 —— 反复失败说明问题没解决，应该去看日志而不是继续重试
          </span>
        </div>

        <div class="auto__event">
          <span class="auto__label">事件驱动</span>
          <span class="auto__state" :class="eventHealing.running ? 'is-on' : 'is-off'">
            {{ eventHealing.running ? '已接入 Docker 事件流' : '未接入' }}
          </span>
          <span class="auto__event-hint">
            容器一退出就立刻处理，不必等下一次巡检
            <template v-if="eventHealing.triggers"
              >· 本次运行已触发 {{ eventHealing.triggers }} 次</template
            >
            <template v-else-if="eventHealing.lastError"
              >· 最近一次连接失败：{{ eventHealing.lastError }}</template
            >
          </span>
        </div>

        <div v-if="lastAutoRun" class="auto__last">
          <span class="auto__last-title"
            >最近一次自动执行 · {{ lastAutoRun.at }}（耗时 {{ lastAutoRun.elapsedMs }} ms）</span
          >
          <ul class="auto__items">
            <li v-if="!lastAutoRun.applied.length && !lastAutoRun.skipped.length">
              没有可处理的项目
            </li>
            <li v-for="a in lastAutoRun.applied" :key="`a-${a.id}`">
              <span class="dot dot--ok" /> {{ a.title }} —— {{ a.message }}
            </li>
            <li v-for="s in lastAutoRun.skipped" :key="`s-${s.id}`">
              <span class="dot dot--muted" /> {{ s.title }} —— 已跳过（{{ s.reason }}）
            </li>
          </ul>
        </div>
      </div>
    </section>

    <!-- ==================== 检查项 ==================== -->
    <section class="surface">
      <StateBlock
        v-if="state === 'loading'"
        state="loading"
        loading-text="正在巡检（读证书、查云端、列容器，约需几秒）…"
      />
      <StateBlock
        v-else-if="state === 'error'"
        state="error"
        title="巡检失败"
        :description="errorMessage"
        action-text="重试"
        @action="load"
      />
      <StateBlock
        v-else-if="state === 'empty'"
        state="empty"
        title="没有巡检项"
        description="这不应该发生，请检查后端服务。"
      />

      <template v-else>
        <header class="list__head">
          <h2 class="list__title">巡检项</h2>
          <span class="list__meta tnum">
            {{ summary.total }} 项 · 严重 {{ summary.critical }} · 警告 {{ summary.warning }} · 提示
            {{ summary.info }} · 正常 {{ summary.ok }}
          </span>
        </header>

        <ul class="checks">
          <li v-for="c in checks" :key="c.id" class="check" :class="`check--${c.severity}`">
            <div class="check__top">
              <span class="check__dot" aria-hidden="true" />
              <div class="check__titles">
                <strong class="check__title">
                  {{ c.title }}
                  <span class="tag">{{ c.group }}</span>
                  <span class="tag tag--scope">{{
                    c.scope === 'project' ? '本项目' : '服务器'
                  }}</span>
                </strong>
                <p class="check__summary">{{ c.summary }}</p>
              </div>

              <div class="check__action">
                <el-button
                  v-if="c.fix && auth.canWrite"
                  type="primary"
                  :loading="fixingId === c.id"
                  @click="applyFix(c)"
                >
                  {{ c.fix.label }}
                </el-button>
                <span v-else-if="c.fix" class="check__manual">只读身份不可修复</span>
                <span v-else-if="c.severity !== 'ok'" class="check__manual">需人工处理</span>
              </div>
            </div>

            <p v-if="c.fix" class="check__fix-note">
              {{ c.fix.description }}
              <span class="check__budget tnum">
                · {{ c.fix.auto ? '可自动执行' : '需人工确认' }} · 熔断预算
                {{ c.budget.remaining }}/{{ c.budget.limit }}
              </span>
            </p>
            <p v-else-if="c.why" class="check__fix-note check__fix-note--why">{{ c.why }}</p>

            <ul v-if="c.items && c.items.length" class="check__items">
              <li v-for="(item, i) in c.items.slice(0, 12)" :key="`${c.id}-${i}`">
                <span class="dot" :class="`dot--${item.level}`" />
                <span class="check__item-name">{{ item.name }}</span>
                <span class="check__item-tag">{{ item.tag }}</span>
              </li>
              <li v-if="c.items.length > 12" class="check__more">
                还有 {{ c.items.length - 12 }} 项，未全部列出
              </li>
            </ul>

            <p v-if="c.error" class="check__error">该项巡检失败：{{ c.error }}</p>
          </li>
        </ul>

        <p class="list__foot">
          巡检只读、不加压；修复动作全部来自固定注册表，并且每次都会写入操作日志。
          作用域白名单：只自动修复本项目自己的站点与容器，其他项目的资源只报告、不动作。
        </p>
      </template>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
// 深路径导入：不要改回 'element-plus'（barrel 入口会阻止 tree-shaking，详见 main.js）
import { ElMessage } from 'element-plus/es/components/message/index';
import { ElMessageBox } from 'element-plus/es/components/message-box/index';
import StateBlock from '@/components/StateBlock.vue';
import ReadOnlyNotice from '@/components/ReadOnlyNotice.vue';
import { inspectApi } from '@/api';
import { useAuthStore } from '@/stores/auth';

const loading = ref(true);

// 只读身份下：修复按钮 / 立即执行 / 自动自愈开关全部不可用（后端也会拦）
const auth = useAuthStore();
const state = ref('loading'); // loading | error | empty | ready
const errorMessage = ref('');

const checks = ref([]);
const summary = ref({ total: 0, critical: 0, warning: 0, info: 0, ok: 0, unknown: 0, fixable: 0 });
const lastAutoRun = ref(null);

const autoHeal = reactive({ enabled: false, intervalMin: 60, minIntervalMin: 10, running: false });
// 事件驱动自愈的实时状态（由 /api/inspect 附带返回）
const eventHealing = reactive({ running: false, triggers: 0, lastError: null, lastEventAt: null });
const autoSaving = ref(false);
const autoRunning = ref(false);
const fixingId = ref('');

/** 顶部结论：把「要不要现在动手」一句话说清 */
const verdict = computed(() => {
  const { critical, warning, info, ok } = summary.value;
  if (critical > 0) {
    return {
      tone: 'danger',
      icon: 'CircleCloseFilled',
      title: `${critical} 项严重问题需要处理`,
      desc: '先看下面的红色项，能一键修复的直接点修复；标「需人工处理」的需要你判断。',
    };
  }
  if (warning > 0) {
    return {
      tone: 'warning',
      icon: 'Warning',
      title: `${warning} 项警告值得留意`,
      desc: '目前不影响访问，但不处理会演变成故障。建议现在就顺手修掉。',
    };
  }
  if (info > 0) {
    return {
      tone: 'neutral',
      icon: 'Bell',
      title: `${info} 项提示（不影响使用）`,
      desc: '多为「其他项目的容器已停止」这类只报告项，本项目资源正常。',
    };
  }
  if (ok > 0) {
    return {
      tone: 'success',
      icon: 'CircleCheck',
      title: '全部检查通过',
      desc: `共 ${ok} 项检查全部正常。可以把「自动自愈」打开，让它定期替你盯着。`,
    };
  }
  return { tone: 'neutral', icon: 'Bell', title: '尚未巡检', desc: '点击右侧「重新巡检」开始。' };
});

function applyPayload(data) {
  checks.value = data.checks || [];
  summary.value = data.summary || summary.value;
  lastAutoRun.value = data.lastAutoRun || null;
  if (data.autoHeal) {
    autoHeal.enabled = !!data.autoHeal.enabled;
    autoHeal.intervalMin = data.autoHeal.intervalMin || 60;
    autoHeal.minIntervalMin = data.autoHeal.minIntervalMin || 10;
    autoHeal.running = !!data.autoHeal.running;
  }
  if (data.eventHealing) {
    eventHealing.running = !!data.eventHealing.running;
    eventHealing.triggers = data.eventHealing.triggers || 0;
    eventHealing.lastError = data.eventHealing.lastError || null;
    eventHealing.lastEventAt = data.eventHealing.lastEventAt || null;
  }
}

async function load() {
  loading.value = true;
  state.value = 'loading';
  try {
    const data = await inspectApi.run();
    applyPayload(data);
    state.value = checks.value.length ? 'ready' : 'empty';
    // 巡检会同步产生/关闭告警 → 通知顶栏铃铛立刻刷新
    window.dispatchEvent(new CustomEvent('aige:alerts-changed'));
  } catch (err) {
    errorMessage.value = err.message || '未知错误';
    state.value = 'error';
  } finally {
    loading.value = false;
  }
}

// ---------------- 单项修复 ----------------
async function applyFix(check) {
  const fx = check.fix;
  try {
    await ElMessageBox.confirm(
      `${fx.description}（影响范围：${fx.risk === 'low' ? '低，可逆' : '中等，涉及线上配置'}）`,
      `执行修复：${check.title}`,
      {
        confirmButtonText: '确认执行',
        cancelButtonText: '取消',
        type: fx.risk === 'low' ? 'info' : 'warning',
      }
    );
  } catch {
    return;
  }

  fixingId.value = check.id;
  try {
    const r = await inspectApi.fix(check.id);
    ElMessage.success(r.message || '修复已完成');
    await load();
  } catch {
    /* 拦截器已提示（含熔断提示） */
  } finally {
    fixingId.value = '';
  }
}

// ---------------- 自动自愈 ----------------
async function saveAuto() {
  autoSaving.value = true;
  try {
    const r = await inspectApi.setAuto({
      enabled: autoHeal.enabled,
      intervalMin: autoHeal.intervalMin,
    });
    autoHeal.enabled = !!r.enabled;
    autoHeal.intervalMin = r.intervalMin;
    autoHeal.running = !!r.running;
    ElMessage.success(
      autoHeal.enabled ? `已开启：每 ${r.intervalMin} 分钟自动巡检一次` : '已关闭自动自愈'
    );
  } catch {
    autoHeal.enabled = !autoHeal.enabled; // 保存失败就回滚开关，避免显示与实际不符
  } finally {
    autoSaving.value = false;
  }
}

function toggleAuto() {
  saveAuto();
}

async function runAutoNow() {
  autoRunning.value = true;
  try {
    const r = await inspectApi.runAuto();
    lastAutoRun.value = r;
    ElMessage.success(
      r.applied.length ? `已处理 ${r.applied.length} 项` : '巡检完成，暂无需要自动处理的项目'
    );
    await load();
  } catch {
    /* 拦截器已提示 */
  } finally {
    autoRunning.value = false;
  }
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

/* ---------------- 自动自愈 ---------------- */
.auto__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
  flex-wrap: wrap;
  padding: var(--sp-4) var(--sp-5);
  border-bottom: 1px solid var(--border-hairline);
}

.auto__title {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.auto__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  border-radius: var(--r-md);
  background: var(--brand-soft);
  color: var(--brand);
  font-size: 17px;
}

.auto__title h2 {
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text-primary);
}

.auto__title p {
  margin-top: 2px;
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--text-tertiary);
}

.auto__switch {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.auto__state {
  font-size: var(--fs-xs);
  font-weight: 500;
}

.auto__state.is-on {
  color: var(--success);
}
.auto__state.is-off {
  color: var(--text-tertiary);
}

.auto__body {
  padding: var(--sp-4) var(--sp-5);
}

.auto__row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
}

.auto__label {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

.auto__select {
  width: 150px;
}

.auto__rules {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  margin-top: var(--sp-3);
  font-size: var(--fs-xs);
  line-height: 1.7;
  color: var(--text-tertiary);
}

.auto__rule strong {
  color: var(--text-secondary);
  font-weight: 600;
}

.auto__rule--warn {
  color: var(--warning);
}

.auto__event {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
  font-size: var(--fs-xs);
}

.auto__event-hint {
  color: var(--text-tertiary);
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.auto__last {
  margin-top: var(--sp-4);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border-hairline);
}

.auto__last-title {
  font-size: var(--fs-xs);
  font-weight: 500;
  color: var(--text-secondary);
}

.auto__items {
  margin: var(--sp-2) 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--fs-xs);
  color: var(--text-secondary);
}

.auto__items li {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  overflow-wrap: anywhere;
}

/* ---------------- 检查项列表 ---------------- */
.list__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-3);
  flex-wrap: wrap;
  padding: var(--sp-4) var(--sp-5);
  border-bottom: 1px solid var(--border-hairline);
}

.list__title {
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text-primary);
}

.list__meta {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}

.checks {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 每一项左侧 2px 的严重度细线（不是 3px 色条那种廉价装饰） */
.check {
  padding: var(--sp-4) var(--sp-5);
  border-bottom: 1px solid var(--border-hairline);
  border-left: 2px solid var(--sev, transparent);
}

.check:last-child {
  border-bottom: none;
}

.check--critical {
  --sev: var(--danger);
}
.check--warning {
  --sev: var(--warning);
}
.check--info {
  --sev: var(--info);
}
.check--ok {
  --sev: var(--success);
}
.check--unknown {
  --sev: var(--text-tertiary);
}

.check__top {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
}

.check__dot {
  width: 8px;
  height: 8px;
  flex: 0 0 8px;
  margin-top: 7px;
  border-radius: 50%;
  background: var(--sev, var(--text-tertiary));
}

.check__titles {
  flex: 1;
  min-width: 0;
}

.check__title {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text-primary);
}

.tag {
  padding: 0 6px;
  border-radius: var(--r-xs);
  background: var(--bg-subtle);
  font-size: 11px;
  font-weight: 500;
  line-height: 18px;
  color: var(--text-secondary);
}

.tag--scope {
  background: var(--brand-soft);
  color: var(--brand);
}

.check__summary {
  margin-top: 2px;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.check__action {
  flex: 0 0 auto;
}

.check__manual {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  white-space: nowrap;
}

.check__fix-note {
  margin: var(--sp-2) 0 0 20px;
  font-size: var(--fs-xs);
  line-height: 1.7;
  color: var(--text-tertiary);
  overflow-wrap: anywhere;
}

.check__fix-note--why {
  color: var(--text-tertiary);
}

.check__budget {
  color: var(--text-tertiary);
}

.check__items {
  margin: var(--sp-3) 0 0 20px;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.check__items li {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  font-size: var(--fs-xs);
  overflow-wrap: anywhere;
}

.check__item-name {
  color: var(--text-primary);
  font-weight: 500;
}

.check__item-tag {
  color: var(--text-tertiary);
}

.check__more {
  color: var(--text-tertiary);
}

.check__error {
  margin: var(--sp-2) 0 0 20px;
  font-size: var(--fs-xs);
  color: var(--danger);
}

.dot {
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: 50%;
  background: var(--text-tertiary);
}

.dot--critical {
  background: var(--danger);
}
.dot--warning {
  background: var(--warning);
}
.dot--info {
  background: var(--info);
}
.dot--ok {
  background: var(--success);
}
.dot--muted {
  background: var(--text-disabled);
}

.list__foot {
  padding: var(--sp-4) var(--sp-5);
  border-top: 1px solid var(--border-hairline);
  font-size: var(--fs-xs);
  line-height: 1.7;
  color: var(--text-tertiary);
}

/* ---------------- 响应式 ---------------- */
@media (max-width: 768px) {
  .verdict,
  .auto__head,
  .auto__body,
  .list__head,
  .check,
  .list__foot {
    padding-left: var(--sp-4);
    padding-right: var(--sp-4);
  }

  /* 手机上修复按钮独占一行，避免和标题挤在一起 */
  .check__top {
    flex-wrap: wrap;
  }

  .check__action {
    width: 100%;
  }

  .check__action :deep(.el-button) {
    width: 100%;
  }

  .check__budget {
    display: block;
  }

  .auto__select {
    width: 100%;
  }
}
</style>
