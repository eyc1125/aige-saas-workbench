/**
 * 后端主入口
 * ------------------------------------------------------------------
 * 同时启动两个服务：
 *   1. REST API（默认 3000）—— 前端界面调用 + 静态前端托管
 *   2. MCP SSE 服务（默认 3001）—— AI 工具远程连接
 *
 * 另外提供优雅退出：收到 SIGTERM / SIGINT 时关闭 HTTP 服务并落盘 SQLite。
 */
'use strict';

const config = require('./config');
const { assertConfig } = require('./config');
const db = require('./db');
const app = require('./app');
const { startMcpServer } = require('./mcp/server');
const healthService = require('./services/health');

async function bootstrap() {
  // 配置自检：生产环境用默认密钥直接拒绝启动
  assertConfig();

  console.log('====================================================');
  console.log('  艾哥SaaS工作台 · 后端服务');
  console.log(`  运行模式：${config.env}`);
  console.log(`  数据文件：${config.dbPath}`);
  console.log('====================================================');

  // ---------------- 1. REST API ----------------
  const apiServer = app.listen(config.port, '0.0.0.0', () => {
    console.log(`[api] REST 接口已启动：http://0.0.0.0:${config.port}/api`);
    console.log(`[api] 健康检查：http://0.0.0.0:${config.port}/api/health`);
  });

  // ---------------- 2. MCP SSE ----------------
  let mcpServer = null;
  try {
    mcpServer = await startMcpServer();
  } catch (err) {
    // MCP 端口被占用不应拖垮整个后端，打日志提示即可
    console.error(`[mcp] SSE 服务启动失败：${err.message}`);
    console.error(`[mcp] 请检查 ${config.mcpPort} 端口是否被占用，或修改 .env 中的 MCP_PORT`);
  }

  // ---------------- 3. MCP 工具分组自检 ----------------
  // 注册了却没归组、或归组了却不存在——都会让「能力清单」与实际不符，启动时就点出来
  try {
    // 懒加载：这一步只是自检，失败不该影响服务启动
    const { auditGroups, TOOL_COUNT } = require('./mcp/instructions');
    const audit = auditGroups();
    console.log(
      `[mcp] 已注册 ${TOOL_COUNT} 个工具${audit.ok ? '，分组一致' : '（分组有问题，见上方警告）'}`
    );
  } catch (err) {
    console.error(`[mcp] 工具分组自检失败：${err.message}`);
  }

  // ---------------- 4. 自动自愈定时器 ----------------
  // 默认关闭；是否启动由「健康巡检」页的开关决定（配置存在 settings 表，重启后保持）。
  // 只执行检查项里标记了 auto:true 的修复，且每次都受熔断约束。
  try {
    const auto = healthService.syncAutoHealTimer();
    if (auto.running) {
      console.log(`[health] 自动自愈已启用：每 ${auto.intervalMin} 分钟巡检一次`);
    } else {
      console.log('[health] 自动自愈当前关闭（可在「健康巡检」页开启）');
    }
  } catch (err) {
    console.error(`[health] 自动自愈定时器启动失败：${err.message}`);
  }

  // ---------------- 5. 指标采样与趋势落库 ----------------
  // CPU 使用率必须靠「两次采样的差值」算，所以需要一个常驻采样器（5 秒）；
  // 趋势曲线每 2 分钟写一行进 SQLite（见 services/metricsStore.js 的体积估算）。
  try {
    // 懒加载：确保前面的服务都起来了再引入，避免循环依赖把启动顺序搞乱
    const metrics = require('./services/metrics');
    const metricsStore = require('./services/metricsStore');

    metrics.startSampler(5000);
    // 首次落库延后 1.2 秒：CPU 使用率要靠两次采样算差值，
    // 采样器启动后约 0.6 秒才有第一个有效值，立刻写会存进一条 cpu = null 的空样本。
    setTimeout(() => metricsStore.startRecorder(), 1200).unref?.();

    const removed = metricsStore.prune();
    if (removed) console.log(`[metrics] 启动清理：移除 ${removed} 条过期样本`);
    setInterval(() => metricsStore.prune(), 24 * 60 * 60 * 1000).unref();

    console.log(
      `[metrics] 采样已启动：CPU 每 5 秒，趋势每 ${metricsStore.SAMPLE_INTERVAL_MS / 60000} 分钟，保留 ${metricsStore.KEEP_DAYS} 天`
    );
  } catch (err) {
    console.error(`[metrics] 采样启动失败：${err.message}`);
  }

  // ---------------- 6. 告警表清理 ----------------
  // 已解决的告警只保留最近 200 条：表本身很小，但不清理会随部署次数无限增长。
  // 启动时清一次，之后每天一次。
  try {
    // 懒加载：告警模块在 db 初始化后才可用
    const notify = require('./services/notify');
    const removed = notify.prune();
    if (removed) console.log(`[alert] 启动清理：移除 ${removed} 条历史告警`);
    setInterval(() => notify.prune(), 24 * 60 * 60 * 1000).unref();
  } catch (err) {
    console.error(`[alert] 告警清理失败：${err.message}`);
  }

  // ---------------- 6.5 操作日志清理 ----------------
  // 与指标、告警同一套模式：保留 90 天 + 20000 条硬上限。
  // 之前这张表只写不清，MCP 高频调用几天就能堆上万行。
  try {
    // 懒加载：日志模块在 db 初始化后才可用
    const logger = require('./utils/logger');
    const removed = logger.prune();
    if (removed) console.log(`[log] 启动清理：移除 ${removed} 条过期操作日志`);
    setInterval(() => logger.prune(), 24 * 60 * 60 * 1000).unref();
    console.log(`[log] 操作日志保留策略：${logger.KEEP_DAYS} 天 / 最多 ${logger.MAX_ROWS} 条`);
  } catch (err) {
    console.error(`[log] 操作日志清理失败：${err.message}`);
  }

  // ---------------- 7. 优雅退出 ----------------
  const shutdown = (signal) => {
    console.log(`\n[app] 收到 ${signal}，正在关闭服务 …`);
    const done = () => {
      db.close();
      console.log('[app] 已安全退出');
      process.exit(0);
    };
    let closing = 0;
    const tick = () => {
      closing += 1;
      if (closing >= (mcpServer ? 2 : 1)) done();
    };
    apiServer.close(tick);
    if (mcpServer) mcpServer.close(tick);
    // 兜底：5 秒内没关完就强制退出
    setTimeout(done, 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // 未捕获异常：记录但不立即退出，避免一次外部接口抖动导致服务不可用
  process.on('unhandledRejection', (reason) => {
    console.error('[app] 未处理的 Promise 拒绝：', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[app] 未捕获异常：', err);
  });
}

bootstrap().catch((err) => {
  console.error('[app] 启动失败：', err.message);
  process.exit(1);
});
