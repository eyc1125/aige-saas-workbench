/**
 * MCP stdio 启动入口
 * ------------------------------------------------------------------
 * 用途：本地 AI 工具以「子进程」方式直连本工作台（无需联网、无需令牌，
 *      因为进程由客户端自己拉起，天然可信）。
 *
 * 使用方式（在 AI 工具的 mcp 配置里）：
 * {
 *   "mcpServers": {
 *     "aige-workbench": {
 *       "command": "node",
 *       "args": ["/绝对路径/backend/src/mcp/stdio.js"],
 *       "env": { "ENV_FILE": "/绝对路径/.env" }
 *     }
 *   }
 * }
 *
 * 注意：stdio 模式下所有日志必须写 stderr，
 *      写 stdout 会污染 JSON-RPC 协议，导致客户端解析失败。
 */
'use strict';

// 把 console.log 重定向到 stderr，避免污染协议通道
const originalLog = console.log;
console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);

const config = require('../config');
const { assertConfig } = require('../config');

async function main() {
  assertConfig();

  const { attachStdio } = require('./server');
  await attachStdio();

  console.error('[mcp:stdio] 已连接，等待客户端调用工具 …');
  console.error(`[mcp:stdio] 数据库：${config.dbPath}`);
}

// 兜底：初始化失败时明确退出，避免客户端一直等待
main().catch((err) => {
  console.error('[mcp:stdio] 启动失败：', err.message);
  process.exit(1);
});

// 保持进程存活（stdio 传输靠 stdin 事件驱动，这里不做额外处理）
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// 引用一次，防止 lint 报未使用
void originalLog;
