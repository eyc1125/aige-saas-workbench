/**
 * 系统配置读写服务
 * ------------------------------------------------------------------
 * 职责：把「用户可在界面里改的配置」统一从 settings 表读写，敏感项自动加解密。
 * 关键约定：
 *   - 所有配置项都有默认值（来自 .env），数据库里有值就用数据库的
 *   - 敏感配置存密文；对外展示时一律脱敏，前端不会拿到明文
 *   - 传入空字符串表示「保持原值不变」（界面上留空就是不改），
 *     传 __CLEAR__ 表示清空
 */
'use strict';

const db = require('../db');
const config = require('../config');
const { encrypt, decrypt, mask, isEncrypted } = require('../utils/crypto');
const { notConfigured } = require('../utils/errors');

/** 配置项元信息：key → { secret, label, default } */
const SCHEMA = {
  bt_panel_url: { secret: false, label: '宝塔面板地址', def: () => config.baota.url },
  bt_api_key: { secret: true, label: '宝塔 API 密钥', def: () => config.baota.apiKey },
  bt_allow_insecure_tls: {
    secret: false,
    label: '跳过面板证书校验',
    def: () => (config.baota.allowInsecureTls ? 'true' : 'false'),
  },
  cf_api_token: {
    secret: true,
    label: 'Cloudflare API Token',
    def: () => config.cloudflare.apiToken,
  },
  cf_account_email: {
    secret: false,
    label: 'Cloudflare 账号邮箱',
    def: () => config.cloudflare.accountEmail,
  },
  docker_host: { secret: false, label: 'Docker 连接地址', def: () => config.docker.host },
  server_public_ip: {
    secret: false,
    label: '服务器公网 IP',
    def: () => config.deploy.serverPublicIp,
  },
  deploy_network: { secret: false, label: '应用容器网络', def: () => config.deploy.network },
  deploy_data_dir: {
    secret: false,
    label: '应用数据目录（容器内）',
    def: () => config.deploy.dataDir,
  },
  // 关键：后端自身跑在容器里，交给 Docker Daemon 的挂载路径必须是「宿主机路径」，
  // 所以这里单独配置。留空则改用 Docker 命名卷（无需关心宿主机路径）。
  host_data_dir: { secret: false, label: '宿主机数据目录', def: () => config.deploy.hostDataDir },
  registry_mirror: {
    secret: false,
    label: 'Docker 镜像加速',
    def: () => config.deploy.registryMirror,
  },
  // MCP 连接令牌：数据库里有值就优先用它（便于在界面上重新生成），否则用 .env 里的
  mcp_auth_token: { secret: true, label: 'MCP 连接令牌', def: () => config.mcpAuthToken },
  // ---------------- 告警外部通道 ----------------
  // 这几个地址里通常带着机器人的 access_token/key，等于凭据，所以按敏感项加密存储。
  // ⚠️ 飞书与企业微信是**两种不同协议**，地址不能混填（格式差异见 services/notify.js 顶部）
  alert_webhook_url: { secret: true, label: '告警 Webhook 地址', def: () => '' },
  alert_feishu_webhook: { secret: true, label: '飞书机器人 Webhook', def: () => '' },
  // 飞书机器人开启「签名校验」时需要的密钥；留空=按未开启签名校验发送
  alert_feishu_secret: { secret: true, label: '飞书机器人签名密钥', def: () => '' },
  alert_wecom_webhook: { secret: true, label: '企业微信群机器人 Webhook', def: () => '' },
};

const selectStmt = db.prepare('SELECT key, value, is_secret FROM settings WHERE key = ?');
const upsertStmt = db.prepare(`
  INSERT INTO settings (key, value, is_secret, updated_at)
  VALUES (@key, @value, @is_secret, datetime('now', 'localtime'))
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    is_secret = excluded.is_secret,
    updated_at = excluded.updated_at
`);
const allStmt = db.prepare('SELECT key, value, is_secret FROM settings');

/**
 * 读取单个配置（明文）
 * @param {string} key
 * @param {string} [fallback] 未配置时的兜底值，不传则用 SCHEMA 里的默认
 */
function get(key, fallback) {
  const row = selectStmt.get(key);
  const meta = SCHEMA[key];
  const def = fallback !== undefined ? fallback : meta?.def ? meta.def() : '';

  if (!row || row.value === null || row.value === '') return def || '';
  return row.is_secret ? decrypt(row.value) : row.value;
}

/**
 * 写入单个配置
 * @param {string} key
 * @param {string} value  空串=保持原值；__CLEAR__=清空；其他=写入
 */
function set(key, value) {
  const meta = SCHEMA[key];
  if (!meta) throw new Error(`未知配置项：${key}`);

  const str = value === undefined || value === null ? '' : String(value).trim();

  // 空串：如果库里已有值就保持不变（前端留空=不改）
  if (str === '') {
    const exists = selectStmt.get(key);
    if (exists && exists.value !== null && exists.value !== '') return;
  }

  const clearing = str === '__CLEAR__';
  const finalValue = clearing ? '' : meta.secret ? encrypt(str) : str;

  upsertStmt.run({ key, value: finalValue, is_secret: meta.secret ? 1 : 0 });
}

/**
 * 批量写入
 * @param {object} patch  { key: value }
 * @returns {string[]} 实际发生变更的配置项
 */
function setMany(patch = {}) {
  const changed = [];
  const tx = db.transaction(() => {
    Object.entries(patch).forEach(([key, value]) => {
      if (!SCHEMA[key]) return; // 未知项直接忽略，防止乱写
      const before = get(key);
      const plain = value === undefined || value === null ? '' : String(value);
      set(key, value);
      if (plain !== '' || before === '') changed.push(key);
    });
  });
  tx();
  return changed;
}

/**
 * 获取给前端展示的配置（敏感项脱敏）
 * 说明：只返回 key 是否有值 + 掩码，绝不返回明文密钥
 */
function getForDisplay() {
  const rows = new Map(allStmt.all().map((r) => [r.key, r]));
  const result = {};
  Object.entries(SCHEMA).forEach(([key, meta]) => {
    const row = rows.get(key);
    const hasValue = !!(row && row.value !== null && row.value !== '');
    const plain = get(key);

    result[key] = {
      label: meta.label,
      secret: meta.secret,
      hasValue,
      configured: !!(row && row.value) || !!plain,
      // 敏感项只给掩码；非敏感项直接给明文（前端用于回显）
      value: meta.secret ? (hasValue ? mask(row.value) : '') : plain,
    };
  });
  return result;
}

/** 判断某组配置是否齐全，缺则给出友好错误 */
function assertConfigured(keys, featureName) {
  const missing = keys.filter((k) => !get(k));
  if (missing.length) {
    const labels = missing.map((k) => SCHEMA[k]?.label || k).join('、');
    throw notConfigured(`${featureName}尚未配置完整，请先到「系统设置」填写：${labels}`);
  }
}

// ---------------- 常用配置组装 ----------------

const getBaotaConfig = () => ({
  // 注意：宝塔 API 只认根地址，浏览器地址里的「安全入口」路径（/c6b348fb）必须去掉，
  //      客户端内也做了 404 自动回退兜底。
  baseUrl: String(get('bt_panel_url') || '').replace(/\/+$/, ''),
  apiKey: get('bt_api_key'),
  allowInsecureTls: String(get('bt_allow_insecure_tls')).toLowerCase() === 'true',
});

const getCloudflareConfig = () => ({
  apiToken: get('cf_api_token'),
  accountEmail: get('cf_account_email'),
});

const getDockerConfig = () => ({
  host: get('docker_host') || 'unix:///var/run/docker.sock',
  tlsCertPath: config.docker.tlsCertPath,
});

const getDeployConfig = () => ({
  network: get('deploy_network') || 'aige-apps',
  dataDir: get('deploy_data_dir') || config.deploy.dataDir,
  serverPublicIp: get('server_public_ip'),
  registryMirror: get('registry_mirror'),
});

module.exports = {
  SCHEMA,
  get,
  set,
  setMany,
  getForDisplay,
  assertConfigured,
  getBaotaConfig,
  getCloudflareConfig,
  getDockerConfig,
  getDeployConfig,
  isEncrypted,
};
