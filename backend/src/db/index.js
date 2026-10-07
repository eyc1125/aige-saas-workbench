/**
 * SQLite 数据库连接与初始化
 * ------------------------------------------------------------------
 * 使用 better-sqlite3（同步 API，性能好、无需额外数据库服务）。
 * 首次启动会：建表 → 创建默认管理员 → 写入默认配置。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { open } = require('./driver');

// 打开数据库（better-sqlite3 优先，装不上时回退 Node 内置 SQLite，详见 driver.js）
const { db, driver } = open(config.dbPath);

/** 执行建表脚本（幂等） */
function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
}

/**
 * 确保「配置里的管理员账号」存在
 * ------------------------------------------------------------------
 * 1) 用户表为空 → 直接创建配置中的管理员
 * 2) 用户表非空但配置的用户名不存在（例如从 admin 切到 elyac）→ 补建，不动任何已有账号
 * 3) 清理历史遗留：若仍存在未被使用过的默认账号 admin/admin888，则移除，避免公网面板留下弱口令后门
 * 注意：只在「用户名不存在」时创建，绝不覆盖已有账号的密码。
 */
function initAdmin() {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get();
  const existing = db.prepare('SELECT id, username, password FROM users WHERE username = ?');

  if (count === 0) {
    const hash = bcrypt.hashSync(config.admin.password, 10);
    db.prepare(
      'INSERT INTO users (username, password, nickname, role) VALUES (?, ?, ?, ?)'
    ).run(config.admin.username, hash, '超级管理员', 'admin');
    console.log(
      `[db] 已创建默认管理员：${config.admin.username} / ${config.admin.password}  ← 登录后请立即修改`
    );
    return;
  }

  if (!existing.get(config.admin.username)) {
    const hash = bcrypt.hashSync(config.admin.password, 10);
    db.prepare(
      'INSERT INTO users (username, password, nickname, role) VALUES (?, ?, ?, ?)'
    ).run(config.admin.username, hash, '超级管理员', 'admin');
    console.log(`[db] 已补建管理员账号：${config.admin.username}`);
  }

  // 清掉「从未被改动过」的历史默认账号，只认 admin/admin888 这一种形态
  const legacy = existing.get('admin');
  if (legacy && config.admin.username !== 'admin' && bcrypt.compareSync('admin888', legacy.password)) {
    db.prepare('DELETE FROM users WHERE id = ?').run(legacy.id);
    console.log('[db] 已移除未使用的历史默认账号 admin（弱口令，避免公网风险）');
  }
}

/**
 * 初始化默认系统配置
 * 只填「空表时才写」，之后一律以用户在界面里改的值为准
 */
function initSettings() {
  const defaults = [
    ['bt_panel_url', config.baota.url, 0],
    ['bt_api_key', config.baota.apiKey, 1],
    ['bt_allow_insecure_tls', config.baota.allowInsecureTls ? 'true' : 'false', 0],
    ['cf_api_token', config.cloudflare.apiToken, 1],
    ['cf_account_email', config.cloudflare.accountEmail, 0],
    ['docker_host', config.docker.host, 0],
    ['server_public_ip', config.deploy.serverPublicIp, 0],
    ['deploy_network', config.deploy.network, 0],
    ['deploy_data_dir', config.deploy.dataDir, 0],
    ['host_data_dir', config.deploy.hostDataDir, 0],
    ['registry_mirror', config.deploy.registryMirror, 0],
    // 告警外部通道（留空=只用站内告警；在「系统设置 → 告警通知」里填）
    ['alert_webhook_url', '', 1],
    ['alert_feishu_webhook', '', 1],
  ];

  const insert = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value, is_secret) VALUES (?, ?, ?)'
  );
  const tx = db.transaction((rows) => rows.forEach((r) => insert.run(...r)));
  tx(defaults);
}

/** 一键初始化 */
function init() {
  initSchema();
  initAdmin();
  initSettings();
  console.log(`[db] SQLite 就绪：${config.dbPath}（驱动：${driver}）`);
}

/**
 * 关闭数据库（进程退出时调用，保证 WAL 落盘）
 */
function close() {
  try {
    db.close();
  } catch {
    /* 忽略重复关闭 */
  }
}

init();

module.exports = db;
module.exports.init = init;
module.exports.close = close;
