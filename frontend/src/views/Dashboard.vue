<template>
  <div class="page">
    <!-- ==================== 未配置引导 ==================== -->
    <section v-if="!loading && server && !server.available" class="guide surface">
      <div class="guide__body">
        <span class="guide__glyph" aria-hidden="true"
          ><el-icon><Link /></el-icon
        ></span>
        <div>
          <h2 class="guide__title">仪表盘需要先完成对接配置</h2>
          <p class="guide__desc">{{ server.reason }}</p>
        </div>
      </div>
      <el-button type="primary" @click="$router.push('/settings')">去系统设置</el-button>
    </section>

    <!-- ==================== 体检提示（只在有问题时出现） ==================== -->
    <section
      v-if="healthHint"
      class="hint"
      :class="healthHint.tone === 'danger' ? 'hint--danger' : 'hint--warn'"
    >
      <span class="hint__icon" aria-hidden="true">
        <el-icon
          ><component :is="healthHint.tone === 'danger' ? 'CircleCloseFilled' : 'Warning'"
        /></el-icon>
      </span>
      <div class="hint__text">
        <strong>{{ healthHint.title }}</strong>
        <p>{{ healthHint.desc }}</p>
      </div>
      <el-button type="primary" @click="$router.push('/inspect')">去处理</el-button>
    </section>

    <!-- ==================== 资源 KPI ==================== -->
    <section class="kpi">
      <template v-if="loading">
        <div v-for="i in 4" :key="i" class="kpi__skeleton surface" />
      </template>
      <template v-else>
        <StatCard
          label="CPU 使用率"
          :value="metric.cpu"
          unit="%"
          icon="Cpu"
          show-bar
          :tone="toneOf(metric.cpu, 70, 88)"
          :hint="server?.cpuNum ? `${server.cpuNum} 核 · 系统负载 ${metric.load1}` : ''"
        />
        <StatCard
          label="内存使用率"
          :value="metric.mem"
          unit="%"
          icon="DataLine"
          show-bar
          :tone="toneOf(metric.mem, 75, 90)"
          :hint="server?.memTotalMb ? `${server.memUsedGb} / ${server.memTotalGb} GB` : ''"
        />
        <StatCard
          label="磁盘使用率"
          :value="metric.disk"
          unit="%"
          icon="Coin"
          show-bar
          :tone="toneOf(metric.disk, 75, 90)"
          :hint="diskHint"
        />
        <StatCard
          label="系统负载"
          :value="metric.load1"
          icon="TrendCharts"
          tone="neutral"
          :hint="loadHint"
        />
      </template>
    </section>

    <!-- ==================== 实时曲线 + 容器状态 ==================== -->
    <section class="charts">
      <div class="surface card">
        <header class="card__head">
          <div>
            <h2 class="card__title">资源趋势</h2>
            <p class="card__sub">
              后端每 {{ metricsStats?.intervalMinutes || 2 }} 分钟采样一次，保留
              {{ metricsStats?.keepDays || 30 }} 天{{
                metricsStats?.firstAt ? ` · 数据始于 ${metricsStats.firstAt}` : ' · 刚开始采集'
              }}
              <template v-if="updatedAt"> · {{ updatedAt }}</template>
            </p>
          </div>
          <div class="range-switch" role="group" aria-label="趋势时间范围">
            <button
              v-for="opt in RANGE_OPTIONS"
              :key="opt.value"
              type="button"
              class="range-switch__btn"
              :class="{ 'is-active': metricsRange === opt.value }"
              :aria-pressed="metricsRange === opt.value"
              @click="
                metricsRange = opt.value;
                onRangeChange();
              "
            >
              {{ opt.label }}
            </button>
          </div>
        </header>
        <div class="card__body">
          <StateBlock
            v-if="server && !server.available"
            state="error"
            title="暂时拿不到服务器指标"
            :description="server.reason"
            action-text="重试"
            @action="loadAll"
          />
          <div v-else ref="lineRef" class="chart chart--line" />
        </div>
      </div>

      <div class="surface card">
        <header class="card__head">
          <div>
            <h2 class="card__title">容器状态</h2>
            <p class="card__sub">Docker 引擎实时统计</p>
          </div>
        </header>
        <div class="card__body">
          <StateBlock
            v-if="counts.containers && !counts.containers.available"
            state="error"
            title="Docker 暂不可用"
            :description="counts.containers.reason"
            action-text="重试"
            @action="loadAll"
          />
          <div v-else class="donut">
            <div ref="donutRef" class="chart chart--donut" />
            <ul class="donut__legend">
              <li>
                <span class="donut__dot" style="background: var(--brand)" />
                <span class="donut__label">运行中</span>
                <strong class="tnum">{{ counts.containers?.running ?? 0 }}</strong>
              </li>
              <li>
                <span class="donut__dot" style="background: var(--text-tertiary)" />
                <span class="donut__label">已停止</span>
                <strong class="tnum">{{ counts.containers?.stopped ?? 0 }}</strong>
              </li>
              <li>
                <span class="donut__dot" style="background: var(--info)" />
                <span class="donut__label">镜像数</span>
                <strong class="tnum">{{ counts.containers?.images ?? 0 }}</strong>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </section>

    <!-- ==================== 统计概览 + 最近操作 ==================== -->
    <section class="bottom">
      <div class="surface card">
        <header class="card__head">
          <div>
            <h2 class="card__title">资源概览</h2>
            <p class="card__sub">网站、域名与应用部署统计</p>
          </div>
        </header>
        <ul class="rows">
          <li v-for="row in overviewRows" :key="row.label" class="rows__item">
            <span class="rows__icon" :style="{ color: row.color, background: row.bg }">
              <el-icon><component :is="row.icon" /></el-icon>
            </span>
            <span class="rows__text">
              <strong>{{ row.label }}</strong>
              <em>{{ row.hint }}</em>
            </span>
            <span class="rows__value tnum" :class="{ 'rows__value--muted': row.unavailable }">
              {{ row.value }}
            </span>
          </li>
        </ul>
      </div>

      <div class="surface card">
        <header class="card__head">
          <div>
            <h2 class="card__title">最近操作</h2>
            <p class="card__sub">Web 点击与 MCP 调用都在这里留痕</p>
          </div>
          <el-button link type="primary" @click="$router.push('/settings')">查看全部</el-button>
        </header>
        <StateBlock
          v-if="!recentLogs.length"
          state="empty"
          title="还没有操作记录"
          description="做过一次操作后，这里会显示最近 12 条记录"
        />
        <ul v-else class="logs">
          <li v-for="log in recentLogs" :key="log.id" class="logs__item">
            <span
              class="logs__badge"
              :class="`logs__badge--${log.status === 'success' ? 'ok' : 'fail'}`"
            >
              {{ moduleText(log.module) }}
            </span>
            <span class="logs__main">
              <strong>{{ actionText(log.action) }}</strong>
              <em v-if="log.target">{{ log.target }}</em>
              <em v-if="log.message" class="logs__msg">{{ log.message }}</em>
            </span>
            <span class="logs__side">
              <span class="logs__from">{{ log.source === 'mcp' ? 'MCP' : '网页' }}</span>
              <time>{{ shortTime(log.created_at) }}</time>
            </span>
          </li>
        </ul>
      </div>
    </section>

    <!-- ==================== 证书到期提醒 ==================== -->
    <section class="surface card">
      <header class="card__head">
        <div>
          <h2 class="card__title">证书到期提醒</h2>
          <p class="card__sub">最紧急的站点排在最前，剩余 15 天内标黄、已过期标红</p>
        </div>
        <el-button link type="primary" @click="$router.push('/certificates')">证书与安全</el-button>
      </header>

      <StateBlock v-if="certLoading" state="loading" loading-text="正在巡检站点证书…" />
      <StateBlock
        v-else-if="!certList.length"
        state="empty"
        title="还没有可巡检的证书"
        description="创建站点并申请证书后，这里会自动显示到期倒计时。"
      />
      <template v-else>
        <ul class="certs">
          <li v-for="item in certList" :key="item.siteName" class="certs__item">
            <span class="certs__name copyable">
              <span class="copyable__text">{{ item.siteName }}</span>
              <CopyBtn :text="item.siteName" title="复制域名" ok-message="域名已复制" />
            </span>
            <span class="pill" :class="`pill--${item.certTone}`">{{ item.certLabel }}</span>
            <strong class="certs__days tnum" :class="`certs__days--${item.certTone}`">{{
              item.daysText
            }}</strong>
            <time class="certs__until">{{ item.validToText || '—' }}</time>
          </li>
        </ul>
        <div class="certs__foot">
          <span class="tnum">
            共 {{ certSummary.total }} 个站点 ·
            <strong>{{ certSummary.withCert }}</strong> 个已部署证书 ·
            <strong :class="{ 'is-warn': certSummary.expiring > 0 }">{{
              certSummary.expiring
            }}</strong>
            个即将到期 ·
            <strong :class="{ 'is-danger': certSummary.expired > 0 }">{{
              certSummary.expired
            }}</strong>
            个已过期
          </span>
        </div>
      </template>
    </section>

    <!-- ==================== 系统信息 ==================== -->
    <section class="surface card">
      <header class="card__head">
        <div>
          <h2 class="card__title">服务器信息</h2>
          <p class="card__sub">由宝塔面板读取</p>
        </div>
        <el-button :loading="loading" @click="loadAll">
          <el-icon><Refresh /></el-icon>刷新
        </el-button>
      </header>
      <div class="meta">
        <div v-for="item in systemMeta" :key="item.label" class="meta__item">
          <span class="meta__label">{{ item.label }}</span>
          <span class="meta__value">{{ item.value }}</span>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts/core';
import { LineChart, PieChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  GraphicComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import StatCard from '@/components/StatCard.vue';
import StateBlock from '@/components/StateBlock.vue';
import CopyBtn from '@/components/CopyBtn.vue';
import { dashboardApi, websiteApi, inspectApi } from '@/api';
import { useThemeStore } from '@/stores/theme';

// 按需注册：只打包用到的图表与组件，避免整包 ECharts 进首屏
echarts.use([
  LineChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  GraphicComponent,
  CanvasRenderer,
]);

const theme = useThemeStore();

const loading = ref(true);
const server = ref(null);
const counts = ref({});
const network = ref({});
const recentLogs = ref([]);
const updatedAt = ref('');
// 供「资源趋势」卡片旁显示最近一次刷新时间用

// 证书巡检（独立加载：它要逐站读证书文件，比服务器指标慢，不该拖住首屏）
const certLoading = ref(true);
const certSummary = ref({ total: 0, withCert: 0, expiring: 0, expired: 0 });
const certRows = ref([]);

/** 只展示「需要留意」的站点：已过期 → 即将到期 → 最近到期的正常证书，最多 6 条 */
const certList = computed(() => {
  const weight = { expired: 0, expiring: 1, ok: 2 };
  return certRows.value
    .filter((c) => c.hasCert)
    .slice()
    .sort((a, b) => {
      const wa = weight[a.status] ?? 2;
      const wb = weight[b.status] ?? 2;
      if (wa !== wb) return wa - wb;
      return (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999);
    })
    .slice(0, 6)
    .map((c) => ({
      siteName: c.siteName,
      validToText: c.validToText,
      certTone: c.status,
      certLabel: c.status === 'expired' ? '已过期' : c.status === 'expiring' ? '即将到期' : '正常',
      daysText:
        c.status === 'expired' ? `过期 ${Math.abs(c.daysLeft)} 天` : `剩余 ${c.daysLeft} 天`,
    }));
});

// 体检摘要：只在「有严重/警告」时才在仪表盘顶部出现一条提示条
const health = ref(null);
const healthHint = computed(() => {
  const s = health.value?.summary;
  if (!s || (!s.critical && !s.warning)) return null;

  // 取最严重的那一项作为说明文案（checks 已按严重度排好序）
  const top = (health.value.checks || []).find(
    (c) => c.severity === 'critical' || c.severity === 'warning'
  );
  const parts = [];
  if (s.critical) parts.push(`${s.critical} 项严重`);
  if (s.warning) parts.push(`${s.warning} 项警告`);

  return {
    tone: s.critical ? 'danger' : 'warning',
    title: `体检发现 ${parts.join('、')}`,
    desc: top ? `${top.title}：${top.summary}` : '点「去处理」查看详情并一键修复。',
  };
});

async function loadHealth() {
  try {
    health.value = await inspectApi.run();
    // 巡检会同步产生/关闭告警，广播一下让顶栏铃铛立刻更新（否则要等最多 60 秒）
    window.dispatchEvent(new CustomEvent('aige:alerts-changed'));
  } catch {
    // 体检失败不影响仪表盘其余部分
    health.value = null;
  }
}

async function loadCerts() {
  certLoading.value = true;
  try {
    const data = await websiteApi.sslCerts();
    certRows.value = data.certs || [];
    certSummary.value = {
      total: data.total || 0,
      withCert: data.withCert || 0,
      expiring: data.expiring || 0,
      expired: data.expired || 0,
    };
  } catch {
    // 证书巡检失败不影响仪表盘其余部分，静默降级为空列表
    certRows.value = [];
  } finally {
    certLoading.value = false;
  }
}

/**
 * 趋势曲线数据（由后端落库样本聚合而来，见 loadMetrics）
 * 以前这里是「客户端累积」—— 后端只给瞬时值、前端自己攒点，
 * 结果刷新页面曲线就空了，这是本次修正的核心问题。
 */
const samples = ref({ times: [], cpu: [], mem: [] });

const lineRef = ref(null);
const donutRef = ref(null);
let lineChart = null;
let donutChart = null;
let timer = null;
let trendTimer = null;

/** 是否降低动效偏好 */
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 读取当前主题的 CSS 变量，让图表跟随明暗主题 */
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const metric = computed(() => {
  const s = server.value || {};
  // cpuUsage 可能为 null：后端刚启动、还没攒够两次采样算差值。
  // 这时显示「—」而不是显示 0 —— 0% 是个会让人误判的假数字。
  const num = (v) =>
    v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Number(v);
  return {
    cpu: s.available ? num(s.cpuUsage) : '—',
    mem: s.available ? num(s.memUsage) : '—',
    disk: s.available ? num(s.disk?.root?.usage) : '—',
    load1: s.available ? num(s.load?.one) : '—',
  };
});

const diskHint = computed(() => {
  const root = server.value?.disk?.root;
  if (!root) return '';
  return `${root.used} 已用 / ${root.total} 总量`;
});

const loadHint = computed(() => {
  const load = server.value?.load;
  if (!load) return '';
  return `5 分钟 ${load.five} · 15 分钟 ${load.fifteen}`;
});

/** 数值越高越警示：tone 随阈值切换 */
function toneOf(value, warn, danger) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 'neutral';
  if (num >= danger) return 'danger';
  if (num >= warn) return 'warning';
  return 'brand';
}

const overviewRows = computed(() => {
  const w = counts.value.websites || {};
  const d = counts.value.domains || {};
  const c = counts.value.containers || {};
  const a = counts.value.apps || {};
  return [
    {
      label: '宝塔网站',
      hint: w.available ? `${w.running} 运行中 · ${w.stopped} 已停止` : w.reason || '未配置',
      value: w.available ? w.total : '—',
      unavailable: !w.available,
      icon: 'Monitor',
      color: 'var(--brand)',
      bg: 'var(--brand-soft)',
    },
    {
      label: '域名区域',
      hint: d.available ? 'Cloudflare 托管中' : d.reason || '未配置',
      value: d.available ? d.total : '—',
      unavailable: !d.available,
      icon: 'Connection',
      color: 'var(--info)',
      bg: 'var(--info-soft)',
    },
    {
      label: 'Docker 容器',
      hint: c.available ? `运行 ${c.running} · 停止 ${c.stopped}` : c.reason || '未配置',
      value: c.available ? c.total : '—',
      unavailable: !c.available,
      icon: 'Box',
      color: 'var(--success)',
      bg: 'var(--success-soft)',
    },
    {
      label: '一键部署应用',
      hint: `成功 ${a.success || 0} 次 · 进行中 ${a.running || 0} 次`,
      value: a.total || 0,
      unavailable: false,
      icon: 'Grid',
      color: 'var(--warning)',
      bg: 'var(--warning-soft)',
    },
  ];
});

const systemMeta = computed(() => {
  const s = server.value;
  if (!s || !s.available) {
    return [{ label: '服务器', value: '未接入宝塔面板' }];
  }
  const net = network.value || {};
  return [
    { label: '操作系统', value: s.system || '-' },
    { label: '系统版本', value: s.version || '-' },
    { label: 'CPU 核心', value: `${s.cpuNum || 0} 核` },
    { label: '内存总量', value: `${s.memTotalGb || 0} GB` },
    { label: '累计上行', value: net.unavailable ? '—' : formatBytes(net.upTotal) },
    { label: '累计下行', value: net.unavailable ? '—' : formatBytes(net.downTotal) },
  ];
});

const MODULE_TEXT = {
  auth: '登录',
  dashboard: '仪表盘',
  website: '网站',
  domain: '域名',
  docker: '容器',
  app: '应用',
  settings: '设置',
  mcp: 'MCP',
  system: '系统',
};
const moduleText = (m) => MODULE_TEXT[m] || m || '其他';

const ACTION_TEXT = {
  login: '登录系统',
  logout: '退出登录',
  change_password: '修改密码',
  create_website: '新建网站',
  delete_website: '删除网站',
  apply_ssl: '申请证书',
  add_dns_record: '添加解析',
  reuse_dns_record: '复用解析',
  update_dns_record: '修改解析',
  toggle_dns_proxy: '切换代理',
  delete_dns_record: '删除解析',
  start_container: '启动容器',
  stop_container: '停止容器',
  restart_container: '重启容器',
  remove_container: '删除容器',
  deploy_app: '部署应用',
  update_settings: '保存配置',
  update_admin: '修改账号',
  regenerate_mcp_token: '重置 MCP 令牌',
};
const actionText = (a) => ACTION_TEXT[a] || a || '操作';

const shortTime = (text) => (text ? String(text).slice(5, 16) : '—');

function formatBytes(bytes) {
  const num = Number(bytes) || 0;
  if (num <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(num) / Math.log(1024)), units.length - 1);
  return `${(num / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ==================== 图表 ====================

function buildLineOption() {
  const textColor = cssVar('--text-secondary');
  const gridColor = cssVar('--border-hairline');
  const brand = cssVar('--brand');

  return {
    animation: !reducedMotion,
    animationDuration: 400,
    grid: { left: 38, right: 16, top: 26, bottom: 26 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: cssVar('--bg-surface'),
      borderColor: cssVar('--border-hairline'),
      textStyle: { color: cssVar('--text-primary'), fontSize: 12 },
      valueFormatter: (v) => `${v}%`,
    },
    legend: {
      top: 0,
      right: 0,
      icon: 'roundRect',
      itemWidth: 8,
      itemHeight: 8,
      textStyle: { color: textColor, fontSize: 12 },
      data: ['CPU', '内存'],
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: samples.value.times,
      axisLine: { lineStyle: { color: gridColor } },
      axisTick: { show: false },
      axisLabel: {
        color: textColor,
        fontSize: 11,
        interval: Math.ceil(samples.value.times.length / 6),
      },
    },
    yAxis: {
      type: 'value',
      max: 100,
      min: 0,
      splitLine: { lineStyle: { color: gridColor } },
      axisLabel: { color: textColor, fontSize: 11, formatter: '{value}%' },
    },
    series: [
      {
        name: 'CPU',
        type: 'line',
        smooth: true,
        symbol: 'none',
        data: samples.value.cpu,
        lineStyle: { width: 2, color: brand },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: `${brand}33` },
              { offset: 1, color: `${brand}00` },
            ],
          },
        },
      },
      {
        name: '内存',
        type: 'line',
        smooth: true,
        symbol: 'none',
        data: samples.value.mem,
        lineStyle: { width: 2, color: cssVar('--info') },
      },
    ],
  };
}

function buildDonutOption() {
  const running = counts.value.containers?.running ?? 0;
  const stopped = counts.value.containers?.stopped ?? 0;
  const total = running + stopped;

  return {
    animation: !reducedMotion,
    tooltip: {
      trigger: 'item',
      backgroundColor: cssVar('--bg-surface'),
      borderColor: cssVar('--border-hairline'),
      textStyle: { color: cssVar('--text-primary'), fontSize: 12 },
    },
    series: [
      {
        type: 'pie',
        radius: ['62%', '84%'],
        center: ['50%', '50%'],
        avoidLabelOverlap: false,
        label: { show: false },
        labelLine: { show: false },
        itemStyle: { borderWidth: 0 },
        data: total
          ? [
              { value: running, name: '运行中', itemStyle: { color: cssVar('--brand') } },
              { value: stopped, name: '已停止', itemStyle: { color: cssVar('--text-tertiary') } },
            ]
          : [{ value: 1, name: '暂无容器', itemStyle: { color: cssVar('--bg-subtle') } }],
      },
    ],
    graphic: [
      {
        type: 'text',
        left: 'center',
        top: '42%',
        style: {
          text: String(total),
          fontSize: 26,
          fontWeight: 600,
          fill: cssVar('--text-primary'),
        },
      },
      {
        type: 'text',
        left: 'center',
        top: '60%',
        style: { text: '容器总数', fontSize: 11, fill: cssVar('--text-tertiary') },
      },
    ],
  };
}

function initCharts() {
  if (lineRef.value && !lineChart) lineChart = echarts.init(lineRef.value);
  if (donutRef.value && !donutChart) donutChart = echarts.init(donutRef.value);
  renderCharts();
}

function renderCharts() {
  if (lineChart) lineChart.setOption(buildLineOption(), true);
  if (donutChart) donutChart.setOption(buildDonutOption(), true);
}

function resizeCharts() {
  lineChart?.resize();
  donutChart?.resize();
}

function disposeCharts() {
  lineChart?.dispose();
  donutChart?.dispose();
  lineChart = null;
  donutChart = null;
}

// ==================== 数据加载 ====================

/** 趋势范围选项（与后端 metricsStore.RANGES 一一对应） */
const RANGE_OPTIONS = [
  { value: '1h', label: '1 小时' },
  { value: '6h', label: '6 小时' },
  { value: '24h', label: '24 小时' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
];

const metricsRange = ref('1h');
const metricsStats = ref(null);

/** 时间轴标签：长范围只显示到日期，短范围显示到分钟 */
function axisLabel(at, range) {
  const s = String(at || '');
  return range === '7d' || range === '30d' ? s.slice(5, 10) : s.slice(11, 16);
}

/**
 * 拉历史趋势 —— 数据来自后端落库样本（services/metricsStore.js）
 * 以前是前端轮询时自己在内存里攒样本，结果一刷新页面曲线就空了。
 */
async function loadMetrics() {
  try {
    const data = await dashboardApi.metrics(metricsRange.value);
    const points = data.points || [];
    samples.value = {
      times: points.map((p) => axisLabel(p.at, metricsRange.value)),
      cpu: points.map((p) => (p.cpu === null || p.cpu === undefined ? null : Number(p.cpu))),
      mem: points.map((p) =>
        p.memPercent === null || p.memPercent === undefined ? null : Number(p.memPercent)
      ),
    };
    metricsStats.value = data.stats || null;
    renderCharts();
  } catch {
    // 拉取失败不清空已有曲线，避免界面闪一下变空
  }
}

async function onRangeChange() {
  await loadMetrics();
}

async function loadServer() {
  try {
    const data = await dashboardApi.server();
    server.value = data.server;
    if (data.server?.available) {
      updatedAt.value = `${data.time} 更新`;
    }
    if (counts.value.containers) {
      counts.value = {
        ...counts.value,
        containers: {
          ...counts.value.containers,
          running: data.containers.running ?? counts.value.containers.running,
          total: data.containers.total ?? counts.value.containers.total,
        },
      };
    }
    renderCharts();
  } catch {
    // 静默：整体加载失败时会由 loadAll 给出错误态
  }
}

async function loadOverview() {
  const data = await dashboardApi.overview();
  server.value = data.server || server.value;
  counts.value = data.counts || {};
  network.value = data.network || {};
  recentLogs.value = data.recentLogs || [];
}

async function loadAll() {
  loading.value = true;
  // 证书巡检与体检都与主数据并行、且不阻塞首屏（它们逐站读证书文件，本身较慢）
  loadCerts();
  loadHealth();
  try {
    await loadOverview();
    await nextTick();
    initCharts();
    // 趋势来自落库样本，与 overview 并行拉即可
    await loadMetrics();
  } catch (err) {
    // 顶层失败（例如后端不可达）：用 server 区块承载错误信息
    server.value = { available: false, reason: err.message || '加载失败，请检查后端服务是否正常' };
  } finally {
    loading.value = false;
    updatedAt.value = new Date().toLocaleTimeString('zh-CN') + ' 更新';
  }
}

onMounted(async () => {
  await loadAll();
  // 每 10 秒刷新 KPI 卡（瞬时值）
  timer = setInterval(loadServer, 10000);
  // 趋势每 2 分钟刷新一次 —— 后端就是这个采样周期，刷得再快也没有新点，
  // 反而白占带宽（这条是「别让监控拖垮主流程」的同一原则）
  trendTimer = setInterval(loadMetrics, 120000);
  window.addEventListener('resize', resizeCharts);
});

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  if (trendTimer) clearInterval(trendTimer);
  window.removeEventListener('resize', resizeCharts);
  disposeCharts();
});

// 切换主题时重建图表（颜色取自 CSS 变量，必须重新读取）
watch(
  () => theme.isDark,
  async () => {
    disposeCharts();
    await nextTick();
    initCharts();
  }
);
</script>

<style scoped>
/* ---------------- 未配置引导 ---------------- */
.guide {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-5);
  flex-wrap: wrap;
  padding: var(--sp-5);
  border-left: 2px solid var(--warning);
}

.guide__body {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
}

.guide__glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  border-radius: var(--r-md);
  background: var(--warning-soft);
  color: var(--warning);
  font-size: 18px;
}

.guide__title {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-primary);
}

.guide__desc {
  margin-top: 2px;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  overflow-wrap: anywhere;
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
  background: linear-gradient(
    90deg,
    var(--bg-subtle) 25%,
    var(--bg-hover) 37%,
    var(--bg-subtle) 63%
  );
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

/* ---------------- 图表区 ---------------- */
.charts {
  display: grid;
  grid-template-columns: minmax(0, 2.1fr) minmax(0, 1fr);
  gap: var(--sp-4);
}

.card {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-4) var(--sp-5);
  border-bottom: 1px solid var(--border-hairline);
}

.card__title {
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text-primary);
}

.card__sub {
  margin-top: 2px;
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}

.card__meta {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  white-space: nowrap;
}

/* 趋势范围切换：分段控件（选中态用主色描边+浅底，未选保持中性） */
.range-switch {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 2px;
  padding: 2px;
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
}

.range-switch__btn {
  appearance: none;
  border: 0;
  background: transparent;
  padding: 4px 10px;
  border-radius: calc(var(--r-sm) - 2px);
  font: inherit;
  font-size: var(--fs-xs);
  line-height: 18px;
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color 180ms var(--ease),
    color 180ms var(--ease);
}

.range-switch__btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.range-switch__btn:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 1px;
}

.range-switch__btn.is-active {
  background: var(--bg-surface);
  color: var(--brand);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}

.card__body {
  padding: var(--sp-4) var(--sp-4) var(--sp-3);
  flex: 1;
}

.chart--line {
  width: 100%;
  height: 244px;
}

.donut {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-3);
}

.chart--donut {
  width: 100%;
  height: 176px;
}

.donut__legend {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  width: 100%;
  margin: 0;
  padding: 0 var(--sp-2);
  list-style: none;
}

.donut__legend li {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-sm);
}

.donut__dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex: 0 0 8px;
}

.donut__label {
  color: var(--text-secondary);
}

.donut__legend strong {
  margin-left: auto;
  font-weight: 600;
  color: var(--text-primary);
}

/* ---------------- 底部两栏 ---------------- */
.bottom {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.35fr);
  gap: var(--sp-4);
  align-items: start;
}

/* 概览行 */
.rows {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.rows__item {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-5);
  border-bottom: 1px solid var(--border-hairline);
}

.rows__item:last-child {
  border-bottom: none;
}

.rows__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  border-radius: var(--r-md);
  font-size: 15px;
}

.rows__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.rows__text strong {
  font-size: var(--fs-base);
  font-weight: 500;
  color: var(--text-primary);
}

.rows__text em {
  font-size: var(--fs-xs);
  font-style: normal;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rows__value {
  margin-left: auto;
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--text-primary);
}

.rows__value--muted {
  color: var(--text-tertiary);
}

/* 日志行 */
.logs {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 420px;
  overflow-y: auto;
}

.logs__item {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-5);
  border-bottom: 1px solid var(--border-hairline);
}

.logs__item:last-child {
  border-bottom: none;
}

.logs__badge {
  flex: 0 0 auto;
  padding: 1px 7px;
  border-radius: var(--r-xs);
  font-size: 11px;
  font-weight: 500;
  line-height: 18px;
}

.logs__badge--ok {
  background: var(--brand-soft);
  color: var(--brand);
}

.logs__badge--fail {
  background: var(--danger-soft);
  color: var(--danger);
}

.logs__main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.logs__main strong {
  font-size: var(--fs-sm);
  font-weight: 500;
  color: var(--text-primary);
}

.logs__main em {
  font-size: var(--fs-xs);
  font-style: normal;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.logs__msg {
  color: var(--text-tertiary) !important;
}

.logs__side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  flex: 0 0 auto;
}

.logs__from {
  font-size: 11px;
  color: var(--text-tertiary);
}

.logs__side time {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

/* ---------------- 体检查询提示条（有问题才出现） ---------------- */
.hint {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  flex-wrap: wrap;
  padding: var(--sp-4) var(--sp-5);
  background: var(--bg-surface);
  border: 1px solid var(--border-hairline);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-md);
  border-left: 2px solid var(--tone, var(--warning));
}

.hint--warn {
  --tone: var(--warning);
}
.hint--danger {
  --tone: var(--danger);
}

.hint__icon {
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

.hint__text {
  flex: 1;
  min-width: 200px;
}

.hint__text strong {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-primary);
}

.hint__text p {
  margin-top: 2px;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

/* ---------------- 证书到期提醒 ---------------- */
.certs {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.certs__item {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-5);
  border-bottom: 1px solid var(--border-hairline);
}

.certs__item:last-child {
  border-bottom: none;
}

.certs__name {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-sm);
  font-weight: 500;
  color: var(--text-primary);
}

.certs__until {
  flex: 0 0 auto;
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.certs__days {
  flex: 0 0 auto;
  min-width: 74px;
  text-align: right;
  font-size: var(--fs-sm);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--success);
}

.certs__days--expiring {
  color: var(--warning);
}
.certs__days--expired {
  color: var(--danger);
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
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

.certs__foot {
  padding: var(--sp-3) var(--sp-5);
  border-top: 1px solid var(--border-hairline);
  font-size: var(--fs-xs);
  color: var(--text-secondary);
}

.certs__foot strong {
  color: var(--text-primary);
}

.certs__foot .is-warn {
  color: var(--warning);
}

.certs__foot .is-danger {
  color: var(--danger);
}

/* ---------------- 系统信息 ---------------- */
.meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 1px;
  background: var(--border-hairline);
}

.meta__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--sp-4) var(--sp-5);
  background: var(--bg-surface);
}

.meta__label {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}

.meta__value {
  font-size: var(--fs-base);
  font-weight: 500;
  color: var(--text-primary);
}

/* ---------------- 响应式 ---------------- */
@media (max-width: 1280px) {
  .kpi {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 1024px) {
  .charts,
  .bottom {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 640px) {
  .kpi {
    grid-template-columns: minmax(0, 1fr);
  }

  .card__head,
  .rows__item,
  .logs__item,
  .meta__item,
  .certs__item,
  .certs__foot,
  .hint {
    padding-left: var(--sp-4);
    padding-right: var(--sp-4);
  }

  /* 手机上到期时间与倒计时抢宽度，先保倒计时（用户最关心的信息） */
  .certs__until {
    display: none;
  }

  /* 5 个范围按钮在窄屏放不进一行，换行后平铺整行 */
  .card__head {
    flex-wrap: wrap;
  }

  .range-switch {
    width: 100%;
  }

  .range-switch__btn {
    flex: 1 1 auto;
    padding-inline: 6px;
    text-align: center;
  }

  .chart--line {
    height: 200px;
  }
}
</style>
