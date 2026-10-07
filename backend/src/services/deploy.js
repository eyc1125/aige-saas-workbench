/**
 * 应用部署编排服务
 * ------------------------------------------------------------------
 * 一次「一键部署」按固定步骤串行执行，每一步都写入 deploy_logs 表，
 * 前端轮询即可拿到实时进度与日志（MCP 的 get_deploy_logs 读同一份数据）。
 *
 * 步骤：
 *   1  前置检查（配置齐全 / 域名格式 / 是否重复部署）
 *   2  域名解析（Cloudflare：A 记录指向服务器公网 IP）
 *   3  准备运行环境（分配端口 / 准备数据卷）
 *   4  拉取镜像
 *   5  创建并启动容器
 *   6  配置反向代理（宝塔：域名 → 127.0.0.1:端口）
 *   7  配置 SSL（有 Cloudflare 代理时由边缘提供 HTTPS；再尽力申请源站证书）
 *
 * 失败策略：任一步失败即终止并把错误写入任务记录；已启动的容器不会自动删除，
 *          便于排查（界面上可手动删除）。SSL 步骤例外——失败只记警告不中断，
 *          因为容器此时已可访问。
 */
'use strict';

const crypto = require('crypto');
const db = require('../db');
const { getTemplate } = require('./apps');
const dockerService = require('./docker');
const baotaService = require('./baota');
const cloudflareService = require('./cloudflare');
const settings = require('./settings');
const notify = require('./notify');
const { writeLog } = require('../utils/logger');
const { AppError, badRequest, upstream } = require('../utils/errors');
const { request } = require('../utils/http');

/** 步骤定义：名称 + 权重（用于计算总进度） */
const STEPS = [
  { key: 'check', label: '前置检查' },
  { key: 'dns', label: '配置域名解析' },
  { key: 'prepare', label: '准备运行环境' },
  { key: 'image', label: '拉取镜像' },
  { key: 'container', label: '创建并启动容器' },
  // ⚠️ 顺序不可颠倒：宝塔在「申请证书」前会校验站点配置是否被改动过，
  //    必须先申请证书（此时站点还是宝塔默认配置），再写反向代理配置。
  { key: 'ssl', label: '配置 HTTPS 证书' },
  { key: 'proxy', label: '配置反向代理' },
];

const stmts = {
  insertTask: db.prepare(`
    INSERT INTO deploy_tasks (id, app_name, app_title, domain, status, total_steps, current_step, progress, created_by)
    VALUES (@id, @app_name, @app_title, @domain, 'pending', @total_steps, 0, 0, @created_by)
  `),
  updateTask: db.prepare(`
    UPDATE deploy_tasks SET
      status = COALESCE(@status, status),
      current_step = COALESCE(@current_step, current_step),
      progress = COALESCE(@progress, progress),
      result = COALESCE(@result, result),
      error = COALESCE(@error, error),
      finished_at = COALESCE(@finished_at, finished_at)
    WHERE id = @id
  `),
  getTask: db.prepare('SELECT * FROM deploy_tasks WHERE id = ?'),
  listTasks: db.prepare('SELECT * FROM deploy_tasks ORDER BY created_at DESC LIMIT ?'),
  insertLog: db.prepare(
    'INSERT INTO deploy_logs (task_id, step, level, message) VALUES (?, ?, ?, ?)'
  ),
  listLogs: db.prepare(
    'SELECT id, task_id, step, level, message, created_at FROM deploy_logs WHERE task_id = ? AND id > ? ORDER BY id ASC LIMIT ?'
  ),
  // 查重：同域名是否已有「进行中/成功」的部署记录。
  // ⚠️ 必须排除当前任务本身 —— 任务行在进入第一步之前就已经以 pending 落库，
  //    不排除的话会查到自己，把自己的部署拦下来（实测踩到过）。
  findManagedByDomain: db.prepare(
    `SELECT * FROM deploy_tasks
     WHERE domain = ? AND id != ? AND status IN ('pending','running','success')
     ORDER BY created_at DESC LIMIT 1`
  ),
};

/**
 * 更新部署任务
 * ------------------------------------------------------------------
 * ⚠️ 必须走这个函数，不要直接调 stmts.updateTask.run()。
 *    原因：better-sqlite3 要求 SQL 里出现的**每一个具名参数都必须提供**，
 *    少传一个就抛 `Missing named parameter "xxx"`，整个部署流程会当场中断
 *    （实测踩到过：任务卡在 pending、日志为空，只在控制台留一行异常）。
 *    这里统一把未传的字段补成 null —— SQL 里用了 COALESCE，null 会被忽略，语义不变。
 */
function updateTask(patch) {
  stmts.updateTask.run({
    id: patch.id,
    status: patch.status ?? null,
    current_step: patch.current_step ?? null,
    progress: patch.progress ?? null,
    result: patch.result ?? null,
    error: patch.error ?? null,
    finished_at: patch.finished_at ?? null,
  });
}

/** 生成短随机串，用于容器/卷名去重 */
const token = (len = 6) => crypto.randomBytes(16).toString('hex').slice(0, len);

/** 生成随机密钥，用于模板里的 {{secret:*}} 与 {{random:*}} */
function randomSecret(spec) {
  const m = /^random:(\d+)$/.exec(String(spec || ''));
  const size = m ? Number(m[1]) : 24;
  return crypto.randomBytes(Math.ceil(size / 2)).toString('hex').slice(0, size);
}

/** 把域名整理成合法的 DNS 名称 */
function normalizeDomain(domain) {
  const clean = String(domain || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '');
  if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(clean)) {
    throw badRequest(`域名格式不正确：${domain}`);
  }
  return clean;
}

class DeployRunner {
  /**
   * @param {object} opts { taskId, appKey, domain, actor, source }
   */
  constructor({ taskId, appKey, domain, actor, source }) {
    this.taskId = taskId;
    this.appKey = appKey;
    this.domain = domain;
    this.actor = actor;
    this.source = source;
    this.template = getTemplate(appKey);
    this.warnings = [];
    this.result = {};
    this.token = token(6);
    this.baseName = `aige-${appKey}-${this.token}`;
    // 每个模板的随机密钥在同一任务内保持一致（多容器共享，如 WordPress 的 DB 密码）
    this.secrets = {};
  }

  // ---------------- 日志与进度 ----------------

  /**
   * 写一条部署日志
   * @param {'info'|'success'|'warn'|'error'} level
   * @param {string} message
   */
  log(level, message) {
    const stepIndex = this.currentStepIndex ?? 0;
    stmts.insertLog.run(this.taskId, stepIndex, level, message);
    if (level === 'warn') this.warnings.push(message);
    const prefix = { info: '·', success: '✓', warn: '!', error: '✕' }[level] || '·';
    console.log(`[deploy:${this.taskId.slice(0, 8)}] ${prefix} ${message}`);
  }

  /** 进入第 index 步（从 0 开始），并刷新进度 */
  enterStep(index) {
    this.currentStepIndex = index;
    const progress = Math.round((index / STEPS.length) * 100);
    updateTask({ id: this.taskId, status: 'running', current_step: index, progress });
    this.log('info', `【${index + 1}/${STEPS.length}】${STEPS[index].label}`);
  }

  /** 完成第 index 步 */
  finishStep(index) {
    const progress = Math.round(((index + 1) / STEPS.length) * 100);
    updateTask({ id: this.taskId, current_step: index, progress });
  }

  // ---------------- 占位符解析 ----------------

  /**
   * 解析模板里的占位符
   * @param {any} value
   * @param {Map<string,string>} serviceHosts 服务名 → 容器名
   */
  resolveValue(value, serviceHosts) {
    if (typeof value !== 'string') return value;
    return value
      .replace(/\{\{domain\}\}/g, this.domain)
      .replace(/\{\{appUrl\}\}/g, `https://${this.domain}`)
      .replace(/\{\{secret:([A-Z0-9_]+)\}\}/g, (_m, name) => {
        if (!this.secrets[name]) this.secrets[name] = randomSecret(this.template.secrets?.[name] || 'random:24');
        return this.secrets[name];
      })
      .replace(/\{\{serviceHost:([a-z0-9_-]+)\}\}/gi, (_m, svc) => serviceHosts.get(svc) || svc)
      .replace(/\{\{random:(\d+)\}\}/g, (_m, n) => randomSecret(`random:${n}`));
  }

  // ---------------- 各步骤实现 ----------------

  /** 步骤 1：前置检查 */
  async stepCheck() {
    if (!this.template) throw badRequest(`应用模板不存在：${this.appKey}`);

    // 同一域名已有成功/进行中的部署 → 直接拦下，避免重复部署与资源冲突（项目查重规则）
    // 注意排除当前任务自身，否则会把自己拦下来
    const dup = stmts.findManagedByDomain.get(this.domain, this.taskId);
    if (dup && dup.status !== 'failed') {
      throw new AppError(
        `域名 ${this.domain} 已有一条部署记录（应用：${dup.app_title || dup.app_name}，状态：${dup.status}，任务号：${dup.id}）。` +
          '请先删除旧容器或在「应用商店」里换个域名，避免重复部署。',
        409,
        'DUPLICATE_DEPLOY'
      );
    }

    const dockerCfg = settings.getDockerConfig();
    if (!dockerCfg.host) throw badRequest('Docker 连接地址未配置');

    this.log('success', `模板校验通过：${this.template.name}（${this.template.services.length} 个服务）`);
    this.log('info', `推荐内存：${this.template.recommendMemory || '未标注'}`);
  }

  /** 步骤 2：Cloudflare 域名解析 */
  async stepDns() {
    const cf = cloudflareService.createClient();

    // 没有手动配置公网 IP 时，自动探测一次并回写配置，免去手工填写
    let ip = settings.get('server_public_ip');
    if (!ip) {
      this.log('info', '未配置服务器公网 IP，正在自动探测 …');
      ip = await request('https://api.ipify.org?format=json', { timeout: 10000, serviceName: '公网 IP 探测' })
        .then((r) => (typeof r === 'object' ? r.ip : String(r).trim()))
        .catch(() => '');
      if (ip) {
        settings.set('server_public_ip', ip);
        this.log('success', `探测到服务器公网 IP：${ip}`);
      }
    }
    if (!ip) {
      throw badRequest('无法确定服务器公网 IP，请到「系统设置」手动填写后再部署');
    }

    const zone = await cf.findZoneByDomain(this.domain);
    this.log('info', `域名归属区域：${zone.name}（zone_id: ${zone.id}）`);

    const { record, created } = await cf.ensureDnsRecord(zone.id, {
      type: 'A',
      name: this.domain,
      content: ip,
      proxied: true, // 默认开启 Cloudflare 代理：边缘自动提供 HTTPS
      comment: `艾哥SaaS工作台部署 ${this.template.name}`,
    });

    if (created) {
      this.log('success', `已添加 A 记录：${this.domain} → ${ip}（云朵已点亮）`);
    } else {
      this.log('warn', `A 记录已存在，直接复用：${record.name} → ${record.content}（未重复添加）`);
    }

    this.result.dns = { zoneId: zone.id, recordId: record.id, ip, proxied: record.proxied !== false };
  }

  /** 步骤 3：准备运行环境（端口 + 数据卷 + 网络） */
  async stepPrepare() {
    const docker = dockerService.createClient();
    const deployCfg = settings.getDeployConfig();

    // 网络：所有应用容器接入同一自定义网络，容器之间可用容器名互访
    await docker.ensureNetwork(deployCfg.network);
    this.log('success', `容器网络就绪：${deployCfg.network}`);

    // 端口：主服务需要一个宿主机端口对外（反向代理指向它）
    const primary = this.template.services.find((s) => s.primary) || this.template.services[0];
    this.hostPort = await docker.findFreePort(31000, 31999);
    this.primaryService = primary;
    this.log('success', `已分配宿主机端口：${this.hostPort}（对应容器端口 ${primary.containerPort}）`);

    // 数据卷：优先使用宿主机目录（便于备份/查看）；未配置宿主机目录时用 Docker 命名卷
    this.useBind = !!settings.get('host_data_dir');
    this.log(
      'info',
      this.useBind
        ? `数据将以目录方式持久化到宿主机：${settings.get('host_data_dir')}`
        : '未配置「宿主机数据目录」，将使用 Docker 命名卷持久化（更省事，备份用 docker volume 命令）'
    );

    // 容器名：单服务模板不加后缀，多服务模板加服务名后缀
    this.serviceHosts = new Map();
    const multi = this.template.services.length > 1;
    this.template.services.forEach((svc) => {
      this.serviceHosts.set(svc.name, multi ? `${this.baseName}-${svc.name}` : this.baseName);
    });
    this.log('info', `容器命名：${[...this.serviceHosts.values()].join('、')}`);
  }

  /** 步骤 4：拉取镜像 */
  async stepImage() {
    const docker = dockerService.createClient();
    for (const svc of this.template.services) {
      await docker.pullImage(svc.image, (msg) => this.log('info', msg));
    }
    this.log('success', '所有镜像已就绪');
  }

  /** 步骤 5：创建并启动容器 */
  async stepContainer() {
    const docker = dockerService.createClient();
    const deployCfg = settings.getDeployConfig();
    const created = [];

    for (const svc of this.template.services) {
      const containerName = this.serviceHosts.get(svc.name);

      // 容器已存在 → 说明上次部署残留，直接报错让人处理，不静默覆盖
      const exists = (await docker.listContainers(true)).find((c) => c.name === containerName);
      if (exists) {
        throw new AppError(
          `容器 ${containerName} 已存在（状态：${exists.status}）。请先到「Docker 管理」删除它，或更换应用名后重试。`,
          409,
          'CONTAINER_EXISTS'
        );
      }

      const env = {};
      Object.entries(svc.env || {}).forEach(([k, v]) => {
        env[k] = this.resolveValue(v, this.serviceHosts);
      });

      const binds = (svc.volumes || []).map((v) => {
        if (this.useBind) {
          const hostPath = `${String(settings.get('host_data_dir')).replace(/\/+$/, '')}/${this.appKey}-${this.token}/${v.subdir}`;
          return `${hostPath}:${v.container}`;
        }
        const volumeName = `${this.baseName}-${v.subdir}`;
        return `${volumeName}:${v.container}`;
      });

      // 只有主服务对外暴露端口，其余走容器内网
      const isPrimary = svc.primary || svc === this.primaryService;
      const ports = {
        hostPort: isPrimary ? this.hostPort : undefined,
        containerPort: isPrimary ? svc.containerPort : undefined,
      };

      const { id } = await docker.createContainer({
        name: containerName,
        image: svc.image,
        ...ports,
        env,
        binds,
        network: deployCfg.network,
        labels: {
          'aige.app': this.appKey,
          'aige.domain': this.domain,
          'aige.task': this.taskId,
          'aige.role': svc.name,
        },
      });
      this.log('success', `容器已创建：${containerName}`);

      await docker.startContainer(id);
      this.log('success', `容器已启动：${containerName}`);
      created.push({ name: containerName, id, service: svc.name, image: svc.image });
    }

    // 主容器可能是「依赖型启动」（如 WordPress 等 MySQL），稍等一下再探测状态
    const primaryName = this.serviceHosts.get(this.primaryService.name);
    const primaryContainer = created.find((c) => c.name === primaryName);
    if (primaryContainer) {
      try {
        await docker.waitRunning(primaryContainer.id, { timeoutMs: 60000 });
        this.log('success', `主服务已进入运行状态：${primaryName}`);
      } catch (err) {
        this.log('warn', `主服务状态确认失败（可能仍在初始化）：${err.message}`);
      }
    }

    this.result.containers = created;
    this.result.hostPort = this.hostPort;
  }

  /** 步骤 6：宝塔反向代理 */
  async stepProxy() {
    const baota = baotaService.createClient();
    const upstreamUrl = `http://127.0.0.1:${this.hostPort}`;
    const info = await baota.setReverseProxy({ domain: this.domain, targetUrl: upstreamUrl });

    this.log('success', `已创建站点并配置反向代理：${this.domain} → ${upstreamUrl}`);
    if (info.backupPath) this.log('info', `原 Nginx 配置已备份：${info.backupPath}`);
    if (!info.reloaded) {
      this.log('warn', '自动重载 Nginx 未成功，若域名打不开，请到宝塔面板手动重载一次 Nginx');
    }

    this.result.proxy = { confPath: info.confPath, upstream: upstreamUrl, backupPath: info.backupPath };
  }

  /**
   * 步骤 6：HTTPS 证书
   * ⚠️ 两个硬性约束（都由宝塔的实际行为决定）：
   *    1. 必须在「配置反向代理」之前执行 —— 宝塔申请证书前会校验站点配置是否被改动过
   *       （can_use_base_file_check），先写自定义反代配置会导致申请被拒。
   *    2. 申请前站点必须已存在 —— 宝塔会按站点 ID 查库，站点不存在直接报「网站丢失」。
   */
  async stepSsl() {
    const baota = baotaService.createClient();
    const proxied = this.result.dns?.proxied !== false;

    if (proxied) {
      this.log('info', '域名已开启 Cloudflare 代理，访客侧 HTTPS 由 Cloudflare 边缘证书自动提供');
    }

    try {
      // 证书申请的前置条件：站点必须已存在
      if (!(await baota.siteExists(this.domain))) {
        await baota.addSite({ domain: this.domain, ps: `艾哥SaaS工作台部署 ${this.template.name}` });
        this.log('info', `已创建宝塔站点（证书申请的前置条件）：${this.domain}`);
      }

      const info = await baota.applyLetsEncrypt({ siteName: this.domain, domains: [this.domain] });
      this.log('success', `源站证书申请已提交：${info.message}`);
      this.result.ssl = { mode: 'letsencrypt', pending: true, ...info };
    } catch (err) {
      // SSL 失败不中断部署：容器与域名此时已可用
      this.log('warn', `源站证书自动申请未成功：${err.message}`);
      this.log(
        'warn',
        proxied
          ? '不影响访问：Cloudflare 代理已提供 HTTPS。如需源站也加密，请稍后在宝塔面板为该站点一键申请证书。'
          : '未开启 Cloudflare 代理且源站证书未签发，域名目前只能通过 http 访问，请到宝塔面板申请证书。'
      );
      this.result.ssl = { mode: proxied ? 'cloudflare-edge' : 'none', error: err.message };
    }
  }

  /** 执行完整流程 */
  async run() {
    try {
      updateTask({ id: this.taskId, status: 'running', current_step: 0, progress: 0 });

      const handlers = [
        () => this.stepCheck(),
        () => this.stepDns(),
        () => this.stepPrepare(),
        () => this.stepImage(),
        () => this.stepContainer(),
        () => this.stepSsl(),
        () => this.stepProxy(),
      ];

      for (let i = 0; i < handlers.length; i += 1) {
        this.enterStep(i);
        // eslint-disable-next-line no-await-in-loop
        await handlers[i]();
        this.finishStep(i);
      }

      this.result.url = `https://${this.domain}`;
      this.result.appKey = this.appKey;
      this.result.appTitle = this.template.title;
      this.result.warnings = this.warnings;

      updateTask({
        id: this.taskId,
        status: 'success',
        current_step: STEPS.length,
        progress: 100,
        result: JSON.stringify(this.result),
        finished_at: new Date().toLocaleString('zh-CN'),
      });
      this.log('success', `部署完成，访问地址：https://${this.domain}`);

      writeLog({
        module: 'app',
        action: 'deploy_app',
        target: this.domain,
        source: this.source,
        status: 'success',
        detail: { appKey: this.appKey, taskId: this.taskId, url: this.result.url },
        username: this.actor,
      });

      // 部署成功 → 清掉同一应用同一域名的历史失败告警
      notify.resolve(`deploy:${this.appKey}:${this.domain}`);

      return this.result;
    } catch (err) {
      updateTask({
        id: this.taskId,
        status: 'failed',
        error: err.message,
        result: JSON.stringify(this.result),
        finished_at: new Date().toLocaleString('zh-CN'),
      });
      this.log('error', `部署失败：${err.message}`);

      writeLog({
        module: 'app',
        action: 'deploy_app',
        target: this.domain,
        source: this.source,
        status: 'failed',
        message: err.message,
        detail: { appKey: this.appKey, taskId: this.taskId },
        username: this.actor,
      });

      // 部署失败要告警：这是「用户已经点了按钮在等结果」的场景，不能只躺在日志里
      notify.raiseDetached({
        fingerprint: `deploy:${this.appKey}:${this.domain}`,
        level: 'critical',
        source: 'deploy',
        title: `应用部署失败：${this.appTitle || this.appKey} → ${this.domain}`,
        detail: `${err.message}\n任务号：${this.taskId}`,
      });

      throw err;
    }
  }
}

// ==================== 对外接口 ====================

/**
 * 发起部署（立即返回 task_id，实际部署在后台异步执行）
 * @param {object} opts
 * @param {string} opts.appKey   模板 key
 * @param {string} opts.domain   绑定域名
 * @param {string} [opts.actor]  触发人
 * @param {string} [opts.source] web / mcp
 * @returns {{ taskId: string, status: string }}
 */
function startDeploy({ appKey, domain, actor = 'system', source = 'web' }) {
  const tpl = getTemplate(appKey);
  if (!tpl) throw badRequest(`应用模板不存在：${appKey}。可用模板见「应用商店」列表。`);

  const cleanDomain = normalizeDomain(domain);
  const taskId = crypto.randomUUID();

  stmts.insertTask.run({
    id: taskId,
    app_name: appKey,
    app_title: tpl.title,
    domain: cleanDomain,
    total_steps: STEPS.length,
    created_by: actor,
  });

  const runner = new DeployRunner({ taskId, appKey, domain: cleanDomain, actor, source });

  // 后台执行：不 await，让 HTTP 请求立刻返回任务号，前端轮询进度
  runner.run().catch((err) => {
    console.error(`[deploy] 任务 ${taskId} 执行异常：`, err.message);
  });

  return { taskId, status: 'running', totalSteps: STEPS.length, steps: STEPS.map((s) => s.label) };
}

/** 查询任务（把 result/error 字段转成对象） */
function getTask(taskId) {
  const row = stmts.getTask.get(taskId);
  if (!row) return null;
  return {
    ...row,
    result: safeJson(row.result),
    steps: STEPS.map((s) => s.label),
  };
}

/** 最近的任务列表 */
function listTasks(limit = 20) {
  return stmts.listTasks.all(Math.min(Number(limit) || 20, 100)).map((row) => ({
    ...row,
    result: safeJson(row.result),
  }));
}

/**
 * 拉取任务日志
 * @param {string} taskId
 * @param {number} [sinceId=0] 只取该 id 之后的日志（增量轮询用）
 */
function getLogs(taskId, sinceId = 0, limit = 500) {
  return stmts.listLogs.all(taskId, Number(sinceId) || 0, Math.min(Number(limit) || 500, 2000));
}

/**
 * 等待任务结束（供 MCP 同步返回结果使用）
 * @param {string} taskId
 * @param {number} [timeoutMs=180000]
 */
async function waitForTask(taskId, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  /* eslint-disable no-await-in-loop */
  while (Date.now() < deadline) {
    const task = getTask(taskId);
    if (!task) throw badRequest(`任务不存在：${taskId}`);
    if (task.status === 'success' || task.status === 'failed') return task;
    await new Promise((r) => setTimeout(r, 2000));
  }
  /* eslint-enable no-await-in-loop */
  return getTask(taskId);
}

/** 安全解析 JSON 字段 */
function safeJson(text) {
  if (!text) return null;
  try {
    return typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    return null;
  }
}

module.exports = { startDeploy, getTask, listTasks, getLogs, waitForTask, STEPS, normalizeDomain };
