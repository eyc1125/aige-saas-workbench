-- ============================================================
-- 艾哥SaaS工作台 · SQLite 数据库结构
-- 说明：使用 IF NOT EXISTS，每次启动执行，幂等安全
-- ============================================================

-- ---------------- 管理员账号 ----------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password      TEXT    NOT NULL,                 -- bcrypt 哈希，绝不存明文
  nickname      TEXT,
  role          TEXT    NOT NULL DEFAULT 'admin', -- admin / viewer（预留只读角色）
  last_login_at TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- ---------------- 系统配置（敏感值加密存储） ----------------
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,                                  -- is_secret=1 时存 AES-256-GCM 密文
  is_secret  INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- ---------------- 操作日志（Web 与 MCP 的操作都记录在此） ----------------
CREATE TABLE IF NOT EXISTS operation_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,
  username    TEXT,
  module      TEXT,                                  -- auth/dashboard/website/domain/docker/app/settings/mcp
  action      TEXT,                                  -- 动作标识，如 create_website
  target      TEXT,                                  -- 操作对象，如域名 / 容器名
  detail      TEXT,                                  -- 详情 JSON 字符串
  source      TEXT NOT NULL DEFAULT 'web',           -- web / mcp / system
  status      TEXT NOT NULL DEFAULT 'success',       -- success / failed
  message     TEXT,                                  -- 失败原因或结果说明
  ip          TEXT,
  duration_ms INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_logs_created ON operation_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_module  ON operation_logs (module);

-- ---------------- 应用部署任务 ----------------
CREATE TABLE IF NOT EXISTS deploy_tasks (
  id           TEXT PRIMARY KEY,                     -- 任务ID（uuid），MCP get_deploy_logs 用它查
  app_name     TEXT NOT NULL,                        -- 模板标识，如 uptime-kuma
  app_title    TEXT,                                 -- 模板中文名，如 运行状态监控
  domain       TEXT NOT NULL,                        -- 绑定的域名
  status       TEXT NOT NULL DEFAULT 'pending',      -- pending/running/success/failed
  total_steps  INTEGER NOT NULL DEFAULT 0,
  current_step INTEGER NOT NULL DEFAULT 0,
  progress     INTEGER NOT NULL DEFAULT 0,           -- 0-100
  result       TEXT,                                 -- 成功结果 JSON：{url, containerId, ...}
  error        TEXT,                                 -- 失败原因
  created_by   TEXT,                                 -- 触发人（管理员用户名 或 mcp）
  created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_deploy_created ON deploy_tasks (created_at DESC);

-- ---------------- 部署过程日志（用于前端实时滚屏 + MCP 查询） ----------------
CREATE TABLE IF NOT EXISTS deploy_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL,
  step       INTEGER,
  level      TEXT NOT NULL DEFAULT 'info',           -- info/success/warn/error
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_deploy_logs_task ON deploy_logs (task_id, id);

-- ---------------- 告警中心 ----------------
-- 设计要点（这几条决定了告警会不会把人淹掉）：
--   1. `fingerprint` 是「同一个问题」的唯一身份（如 health:ssl_expiring）。
--      同一个 fingerprint 未解决时**不新建行**，只累加 occurrences 并刷新时间；
--      否则巡检每跑一次就刷出 6 条一模一样的告警，页面立刻不可用。
--   2. `notified_at` 配合静默窗口：同一告警 30 分钟内只对外推一次，
--      避免 webhook / 飞书被刷屏。
--   3. `read_at` 为 null 即未读，用于顶栏红点。
CREATE TABLE IF NOT EXISTS alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT    NOT NULL,                    -- 去重指纹，如 health:ssl_expiring
  level       TEXT    NOT NULL DEFAULT 'warning',  -- critical / warning / info
  source      TEXT    NOT NULL DEFAULT 'system',   -- health / deploy / auth / system
  title       TEXT    NOT NULL,
  detail      TEXT,
  status      TEXT    NOT NULL DEFAULT 'open',     -- open / resolved
  occurrences INTEGER NOT NULL DEFAULT 1,
  notified_at TEXT,
  read_at     TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_open   ON alerts (status, level, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_fp     ON alerts (fingerprint, status);

-- ---------------- 资源趋势采样 ----------------
-- 为什么要落库：以前 CPU/内存曲线由前端轮询时**自行在内存里累积**，
-- 结果就是「一刷新页面曲线就空了」—— 主人看到的空曲线就是这个原因。
-- 改成后端每 2 分钟写一行，前端一打开就是满的。
--
-- 体积估算：每行约 90 字节，2 分钟一条 = 720 条/天
--          → 30 天约 2.2 万行 ≈ 2MB。对 40G 的盘可忽略。
CREATE TABLE IF NOT EXISTS metrics_samples (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,          -- epoch 秒（按范围查询用这个）
  at           TEXT    NOT NULL,          -- 'YYYY-MM-DD HH:MM:SS' 本地时间（展示用）
  cpu          REAL,                      -- CPU 使用率 %
  load1        REAL,
  load5        REAL,
  load15       REAL,
  mem_used_mb  INTEGER,
  mem_total_mb INTEGER,
  mem_percent  REAL,
  disk_used_gb REAL,
  disk_total_gb REAL,
  disk_percent REAL
);
CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics_samples (ts DESC);

