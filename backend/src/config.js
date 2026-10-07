/**
 * 全局配置中心
 * ------------------------------------------------------------------
 * 统一从环境变量读取配置，供全局引用。
 * 原则：凡是「每个环境可能不同」的值都放这里；凡是「用户可在界面里改」的值
 *       放数据库 settings 表（见 services/settings.js）。
 */
'use strict';

const path = require('path');
const dotenv = require('dotenv');

// 优先加载项目根目录的 .env（docker-compose 也支持 env_file 注入）
dotenv.config({ path: process.env.ENV_FILE || path.resolve(__dirname, '../../.env') });

/** 读取字符串环境变量，带默认值 */
const str = (key, def = '') => {
  const v = process.env[key];
  return v === undefined || v === null || v === '' ? def : String(v).trim();
};

/** 读取数字环境变量 */
const num = (key, def) => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : def;
};

/** 读取数组环境变量（英文逗号分隔） */
const list = (key, def = []) => {
  const v = str(key);
  if (!v) return def;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
};

const rootDir = path.resolve(__dirname, '..');

const config = {
  env: str('NODE_ENV', 'development'),
  isProd: str('NODE_ENV', 'development') === 'production',

  // ---------------- 端口 ----------------
  port: num('PORT', 3000),
  mcpPort: num('MCP_PORT', 3001),

  // ---------------- 密钥 ----------------
  jwtSecret: str('JWT_SECRET', 'aige-workbench-dev-secret-please-change'),
  jwtExpiresIn: str('JWT_EXPIRES_IN', '7d'),
  encryptionKey: str('ENCRYPTION_KEY', 'aige-workbench-dev-encryption-key-change'),
  mcpAuthToken: str('MCP_AUTH_TOKEN', ''),

  // ---------------- 默认管理员 ----------------
  // 首次启动（用户表为空）或该账号不存在时自动创建，不会覆盖已存在账号的密码。
  admin: {
    username: str('ADMIN_USERNAME', 'elyac'),
    password: str('ADMIN_PASSWORD', 'elyac123456'),
  },

  // ---------------- 宝塔 / Cloudflare（环境变量仅作为兜底默认值） ----------------
  baota: {
    url: str('BT_PANEL_URL', ''),
    apiKey: str('BT_API_KEY', ''),
    // 面板多为 IP + 自签证书，需允许跳过 TLS 校验才能调用其 API
    allowInsecureTls: str('BT_ALLOW_INSECURE_TLS', 'false') === 'true',
  },
  cloudflare: {
    apiToken: str('CF_API_TOKEN', ''),
    accountEmail: str('CF_ACCOUNT_EMAIL', ''),
  },

  // ---------------- Docker ----------------
  docker: {
    host: str('DOCKER_HOST', 'unix:///var/run/docker.sock'),
    tlsCertPath: str('DOCKER_TLS_CERT_PATH', ''),
  },

  // ---------------- 应用部署 ----------------
  deploy: {
    network: str('DEPLOY_NETWORK', 'aige-apps'),
    dataDir: str('DEPLOY_DATA_DIR', path.join(rootDir, 'data', 'apps')),
    // 宿主机上对应的数据目录（交给 Docker Daemon 做挂载时使用）。
    // 留空 → 部署应用时改用 Docker 命名卷，避免“容器内路径 ≠ 宿主机路径”的坑。
    hostDataDir: str('HOST_DATA_DIR', ''),
    serverPublicIp: str('SERVER_PUBLIC_IP', ''),
    registryMirror: str('DOCKER_REGISTRY_MIRROR', ''),
  },

  // ---------------- 数据库 ----------------
  dbPath: path.resolve(rootDir, str('DB_PATH', './data/workbench.db')),

  // ---------------- 其他 ----------------
  corsOrigins: list('CORS_ORIGINS', ['http://localhost:5173', 'http://127.0.0.1:5173']),

  // ---------------- 对外访问地址 ----------------
  // 「系统设置 → MCP」里给 AI 工具复制的那份配置，必须是外网真正可达的地址。
  // 之前用 `http://<内网IP>:3001` 是连不上的（端口没对外开），所以这里单独配置。
  // 留空则自动退回「当前请求的 host + 端口」，仅供本地开发使用。
  public: {
    panelUrl: str('PUBLIC_PANEL_URL', ''),
    mcpUrl: str('PUBLIC_MCP_URL', ''),
  },
  rateLimit: {
    max: num('RATE_LIMIT_MAX', 600),
    loginMax: num('LOGIN_RATE_LIMIT_MAX', 20),
    windowMs: 15 * 60 * 1000,
  },
  logLevel: str('LOG_LEVEL', 'info'),

  rootDir,
  // 后端托管的静态前端目录（把 frontend/dist 拷到这里，即可只用 3000 端口对外）
  staticDir: path.join(rootDir, 'public'),
};

/**
 * 启动自检：把「生产环境下还用默认密钥」这种致命配置直接拦下来
 * 开发环境只警告，生产环境直接退出，避免裸奔上线
 */
function assertConfig() {
  const problems = [];
  const defaults = [
    ['JWT_SECRET', config.jwtSecret.includes('please_change_me') || config.jwtSecret.includes('dev-secret')],
    ['ENCRYPTION_KEY', config.encryptionKey.includes('please_change_me') || config.encryptionKey.includes('dev-encryption')],
  ];
  defaults.forEach(([key, isDefault]) => {
    if (isDefault) problems.push(`${key} 仍是默认值`);
  });

  if (!config.isProd) {
    if (problems.length) {
      console.warn(`[config] ⚠️  开发模式提示：${problems.join('、')}，正式部署前请务必修改 .env`);
    }
    return;
  }

  if (problems.length) {
    throw new Error(
      `[config] ❌ 生产环境配置不安全：${problems.join('、')}。请在 .env 中改为随机字符串后重启。`
    );
  }
}

module.exports = config;
module.exports.assertConfig = assertConfig;
