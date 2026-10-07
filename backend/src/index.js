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
    // eslint-disable-next-line global-require
    const { auditGroups, TOOL_COUNT } = require('./mcp/instructions');
    const audit = auditGroups();
    console.log(`[mcp] 已注册 ${TOOL_COUNT} 个工具${audit.ok ? '，分组一致' : '（分组有问题，见上方警告）'}`);
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

  // ---------------- 5. 告警表清理 ----------------
  // 已解决的告警只保留最近 200 条：表本身很小，但不清理会随部署次数无限增长。
  // 启动时清一次，之后每天一次。
  try {
    // eslint-disable-next-line global-require
    const notify = require('./services/notify');
    const removed = notify.prune();
    if (removed) console.log(`[alert] 启动清理：移除 ${removed} 条历史告警`);
    setInterval(() => notify.prune(), 24 * 60 * 60 * 1000).unref();
  } catch (err) {
    console.error(`[alert] 告警清理失败：${err.message}`);
  }

  // ---------------- 6. 优雅退出 ----------------
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
