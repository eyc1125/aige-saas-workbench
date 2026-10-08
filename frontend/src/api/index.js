/**
 * 接口封装
 * ------------------------------------------------------------------
 * 所有后端接口在这里集中定义，页面里只调用语义化函数，不写裸 URL。
 * 与后端 routes 一一对应，改接口时只动这一处。
 */
import request, { getToken } from './request';

// ==================== 登录鉴权 ====================
export const authApi = {
  login: (data) => request.post('/auth/login', data, { silent: true }),
  // 二次验证（D1）：用密码换来的临时票据 + 6 位码（或恢复码）换正式令牌
  loginTotp: (data) => request.post('/auth/login/totp', data, { silent: true }),
  profile: () => request.get('/auth/profile', { silent: true }),
  changePassword: (data) => request.put('/auth/password', data),
  logout: () => request.post('/auth/logout', {}, { silent: true }),
  // 二次验证的绑定管理（都在「系统设置」里用）
  totpStatus: () => request.get('/auth/totp', { silent: true }),
  totpSetup: () => request.post('/auth/totp/setup'),
  totpEnable: (code) => request.post('/auth/totp/enable', { code }),
  totpDisable: (data) => request.post('/auth/totp/disable', data),
  totpRecovery: (code) => request.post('/auth/totp/recovery', { code }),
};

// ==================== 仪表盘 ====================
export const dashboardApi = {
  overview: () => request.get('/dashboard/overview', { silent: true }),
  server: () => request.get('/dashboard/server', { silent: true }),
  /** 历史趋势：range = 1h / 6h / 24h / 7d / 30d（后端按时间桶聚合后返回） */
  metrics: (range = '1h') => request.get('/dashboard/metrics', { params: { range }, silent: true }),
};

// ==================== 网站管理 ====================
export const websiteApi = {
  list: (params) => request.get('/websites', { params, silent: true }),
  detail: (name) => request.get(`/websites/${encodeURIComponent(name)}`),
  create: (data) => request.post('/websites', data),
  remove: (name) => request.delete(`/websites/${encodeURIComponent(name)}`),
  applySsl: (name, data) => request.post(`/websites/${encodeURIComponent(name)}/ssl`, data),
  /** 站点访问 / 错误日志（type: access | error） */
  logs: (name, params) =>
    request.get(`/websites/${encodeURIComponent(name)}/logs`, { params, silent: true }),
  /** 站点 Nginx 配置（只读） */
  nginxConfig: (name) =>
    request.get(`/websites/${encodeURIComponent(name)}/nginx-config`, { silent: true }),

  // ---------------- 配置快照（变更历史 + 一键回滚） ----------------
  /** 该站点的配置备份列表 + 当前线上配置 */
  snapshots: (name) =>
    request.get(`/websites/${encodeURIComponent(name)}/snapshots`, { silent: true }),
  /** 两份配置的行级差异；a 省略时表示「当前线上」 */
  snapshotDiff: (name, params) =>
    request.get(`/websites/${encodeURIComponent(name)}/snapshots/diff`, { params, silent: true }),
  /**
   * 回滚到某份备份。
   * confirm 必须显式传 true —— 服务端也会校验，避免误点直接覆盖线上配置。
   */
  restoreSnapshot: (name, file) =>
    request.post(`/websites/${encodeURIComponent(name)}/snapshots/restore`, {
      file,
      confirm: true,
    }),
  /** SSL 证书台账：含剩余天数与状态（expired | expiring | ok） */
  sslCerts: () => request.get('/websites/ssl-certs', { silent: true }),
  /** 批量续签即将到期的证书 */
  renewSsl: (sites) => request.post('/websites/ssl-certs/renew', { sites }),
};

// ==================== 告警中心 ====================
export const alertApi = {
  /** 告警列表 + 汇总 + 通道状态 */
  list: (params) => request.get('/alerts', { params, silent: true }),
  /** 只要汇总（顶栏红点轮询，很轻） */
  summary: () => request.get('/alerts/summary', { silent: true }),
  /** 全部标记已读 */
  readAll: () => request.post('/alerts/read', {}),
  /** 手动解决某条 */
  resolve: (id) => request.post(`/alerts/${id}/resolve`, {}),
  /** 发一条测试告警验证通道 */
  test: () => request.post('/alerts/test', {}),
};

// ==================== 健康巡检与自愈 ====================
export const inspectApi = {
  /** 跑一遍巡检，返回各项结论 + 自动自愈状态 */
  run: () => request.get('/inspect', { silent: true }),
  /** 执行指定检查项的修复（受后端熔断约束） */
  fix: (checkId) => request.post('/inspect/fix', { checkId }),
  /** 开关自动自愈 / 调巡检间隔 */
  setAuto: (data) => request.put('/inspect/auto', data),
  /** 立刻跑一轮自动自愈 */
  runAuto: () => request.post('/inspect/auto/run'),
};

// ==================== 域名管理 ====================
export const domainApi = {
  zones: () => request.get('/domains/zones', { silent: true }),
  records: (zoneId, params) =>
    request.get(`/domains/zones/${zoneId}/records`, { params, silent: true }),
  addRecord: (zoneId, data) => request.post(`/domains/zones/${zoneId}/records`, data),
  updateRecord: (zoneId, recordId, data) =>
    request.put(`/domains/zones/${zoneId}/records/${recordId}`, data),
  removeRecord: (zoneId, recordId) =>
    request.delete(`/domains/zones/${zoneId}/records/${recordId}`),
  quickAdd: (data) => request.post('/domains/quick-add', data),
};

// ==================== Docker ====================
export const dockerApi = {
  containers: (params) => request.get('/docker/containers', { params, silent: true }),
  start: (id) => request.post(`/docker/containers/${id}/start`),
  stop: (id) => request.post(`/docker/containers/${id}/stop`),
  restart: (id) => request.post(`/docker/containers/${id}/restart`),
  remove: (id, params) => request.delete(`/docker/containers/${id}`, { params }),
  logs: (id, params) => request.get(`/docker/containers/${id}/logs`, { params, silent: true }),
  images: () => request.get('/docker/images', { silent: true }),
  networks: () => request.get('/docker/networks', { silent: true }),
  /**
   * 容器日志实时推送地址（SSE，直接给 EventSource 用）
   * 说明：EventSource 无法自定义请求头，所以令牌只能走 query。
   *      该地址只在本机/内网使用，如需对外暴露请让 Nginx 过滤 access_log 中的 token 参数。
   */
  logStreamUrl: (id, tail = 100) =>
    `/api/docker/containers/${id}/logs/stream?tail=${tail}&token=${encodeURIComponent(getToken())}`,
};

// ==================== 应用商店 ====================
export const appApi = {
  templates: () => request.get('/apps/templates', { silent: true }),
  compose: (key) => request.get(`/apps/templates/${key}/compose`),
  deploy: (data) => request.post('/apps/deploy', data),
  tasks: (params) => request.get('/apps/tasks', { params, silent: true }),
  task: (taskId) => request.get(`/apps/tasks/${taskId}`, { silent: true }),
  taskLogs: (taskId, params) => request.get(`/apps/tasks/${taskId}/logs`, { params, silent: true }),
  clearTaskLogs: (taskId) => request.delete(`/apps/tasks/${taskId}/logs`),
};

// ==================== 代码仓库（B4） ====================
export const repoApi = {
  /** 配置状态：有没有配令牌、关注了哪些仓库、当前配额 */
  config: () => request.get('/repos/config', { silent: true }),
  /** 关注的仓库概览 */
  list: () => request.get('/repos', { silent: true }),
  /** 单个仓库的完整数据（提交 / Actions / Issue / PR 一次取回） */
  detail: (owner, repo) =>
    request.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      silent: true,
    }),
};

// ==================== 系统设置 ====================
export const settingApi = {
  get: () => request.get('/settings'),
  save: (data) => request.put('/settings', data),
  test: (target, data) => request.post(`/settings/test/${target}`, data || {}, { silent: true }),
  mcp: () => request.get('/settings/mcp'),
  // scope: 'full'（默认）| 'readonly'；revoke=true 时吊销只读令牌
  mcpToken: (payload) => request.post('/settings/mcp/token', payload || {}),
  updateAdmin: (data) => request.put('/settings/admin', data),
  system: () => request.get('/settings/system', { silent: true }),
};

/** 用户与角色管理（B5，仅管理员可用 —— 后端按角色拦截，前端只是配合隐藏入口） */
export const userApi = {
  list: () => request.get('/users'),
  create: (data) => request.post('/users', data),
  update: (id, data) => request.put(`/users/${id}`, data),
  remove: (id) => request.delete(`/users/${id}`),
};

// ==================== 操作日志 ====================
export const logApi = {
  list: (params) => request.get('/logs', { params, silent: true }),
};
