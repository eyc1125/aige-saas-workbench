/**
 * Docker API 对接
 * ------------------------------------------------------------------
 * 直接对接 Docker Engine REST API（不引入第三方 Docker SDK）：
 *   - 本机：通过 /var/run/docker.sock（docker-compose 已挂载）
 *   - 远程：tcp://host:2375
 * 启动时会向 /version 探测 Docker 的 API 版本，后续请求都带 /vX.XX 前缀，
 * 避免不同 Docker 版本间的兼容问题。
 *
 * 覆盖需求中列出的全部接口：
 *   容器列表 / 启动 / 停止 / 重启 / 日志 / 删除、镜像列表，
 *   另外补充了部署应用所需的：拉镜像、建容器、网络管理、端口分配。
 */
'use strict';

const http = require('http');
const net = require('net');
const settings = require('./settings');
const { AppError, upstream, badRequest } = require('../utils/errors');

/** Docker 日志流是 8 字节头 + 负载的多路复用格式，这里做解复用 */
function demuxLogStream(buffer) {
  const lines = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);
    // 头 8 字节；若剩余长度不足说明这条被截断了，直接跳出
    if (offset + 8 + size > buffer.length) break;
    const payload = buffer.subarray(offset + 8, offset + 8 + size);
    if (streamType === 0 || streamType === 1 || streamType === 2) {
      lines.push(payload.toString('utf8'));
    }
    offset += 8 + size;
  }
  return lines.join('');
}

class DockerClient {
  /**
   * @param {object} options
   * @param {string} options.host unix:///var/run/docker.sock 或 tcp://1.2.3.4:2375
   */
  constructor({ host }) {
    this.host = host || 'unix:///var/run/docker.sock';
    this.socketPath = null;
    this.tcpHost = null;
    this.tcpPort = 2375;

    if (this.host.startsWith('unix://')) {
      this.socketPath = this.host.replace('unix://', '');
    } else if (this.host.startsWith('tcp://') || this.host.startsWith('http://')) {
      const raw = this.host.replace(/^tcp:\/\//, 'http://');
      const url = new URL(raw.startsWith('http') ? raw : `http://${raw}`);
      this.tcpHost = url.hostname;
      this.tcpPort = Number(url.port || 2375);
    } else {
      throw new AppError(`不支持的 Docker 连接方式：${this.host}`, 400, 'INVALID_DOCKER_HOST');
    }

    this.apiPrefix = ''; // 探测后填充，如 /v1.44
    this._probed = false;
  }

  /**
   * 底层请求：支持 unix socket 与 tcp 两种通道
   * @param {string} path  形如 /containers/json?all=true
   * @param {object} [opts] { method, body, headers, timeout, raw }
   */
  _request(path, opts = {}) {
    const { method = 'GET', body, headers = {}, timeout = 60000, raw = false } = opts;
    const fullPath = `${this.apiPrefix}${path}`;
    const payload =
      body === undefined || body === null
        ? null
        : typeof body === 'string'
          ? body
          : JSON.stringify(body);

    const requestOptions = {
      path: fullPath,
      method,
      headers: {
        ...(payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {}),
        ...headers,
      },
    };

    return new Promise((resolve, reject) => {
      const base = this.socketPath
        ? { socketPath: this.socketPath }
        : { host: this.tcpHost, port: this.tcpPort };

      const req = http.request({ ...base, ...requestOptions }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          // 304：容器已启动/已停止，属于幂等情况，按成功处理
          if (res.statusCode >= 200 && res.statusCode < 300) {
            if (raw) return resolve(buffer);
            const text = buffer.toString('utf8');
            if (!text) return resolve(null);
            try {
              return resolve(JSON.parse(text));
            } catch {
              return resolve(text);
            }
          }
          if (res.statusCode === 304) return resolve({ unchanged: true });

          const text = buffer.toString('utf8');
          let message = text;
          try {
            const parsed = JSON.parse(text);
            message = parsed.message || text;
          } catch {
            /* 非 JSON 错误体，原样用 */
          }
          return reject(
            upstream(`Docker 接口调用失败（HTTP ${res.statusCode}）：${message}`, {
              path: fullPath,
            })
          );
        });
      });

      // 超时保护：Docker 的拉镜像/日志接口可能较慢，默认给 60 秒
      req.setTimeout(timeout, () => {
        req.destroy(new Error(`请求 Docker 超时（${timeout / 1000} 秒）`));
      });
      req.on('error', (err) => {
        const hint =
          err.code === 'ENOENT'
            ? `找不到 Docker Socket（${this.socketPath}），请确认容器已挂载 /var/run/docker.sock`
            : err.code === 'ECONNREFUSED'
              ? `连接 Docker 被拒绝（${this.host}），请确认 Docker 服务已启动`
              : err.message;
        reject(upstream(`无法连接 Docker：${hint}`));
      });

      if (payload) req.write(payload);
      req.end();
    });
  }

  /** 探测 Docker API 版本（只需一次） */
  async _ensureVersion() {
    if (this._probed) return;
    try {
      const version = await this._request('/version', { timeout: 8000 });
      if (version?.ApiVersion) this.apiPrefix = `/v${version.ApiVersion}`;
      this._probed = true;
    } catch (err) {
      // 探测失败不阻塞：可能是旧版本 Docker，退回不带版本前缀的调用方式
      console.warn(`[docker] API 版本探测失败，改用默认路径：${err.message}`);
      this._probed = true;
    }
  }

  /** 所有对外方法统一先做版本探测 */
  async _ready() {
    await this._ensureVersion();
  }

  // ==================== 容器 ====================

  /**
   * 容器列表
   * @param {boolean} [all=true] 是否包含已停止的容器
   */
  async listContainers(all = true) {
    await this._ready();
    const raw = await this._request(`/containers/json?all=${all ? 'true' : 'false'}`);
    return (Array.isArray(raw) ? raw : []).map((c) => {
      const names = (c.Names || []).map((n) => n.replace(/^\//, ''));
      const ports = (c.Ports || []).map((p) => ({
        ip: p.IP,
        privatePort: p.PrivatePort,
        publicPort: p.PublicPort,
        type: p.Type,
      }));
      return {
        id: c.Id,
        shortId: c.Id.slice(0, 12),
        name: names[0] || c.Id.slice(0, 12),
        names,
        image: c.Image,
        imageId: c.ImageID,
        command: c.Command,
        state: c.State, // running / exited / paused / created / restarting
        status: c.Status, // 人类可读，如 "Up 3 hours"
        running: c.State === 'running',
        ports,
        // 便于前端直接展示「宿主机端口 → 容器端口」
        portSummary: ports
          .filter((p) => p.publicPort)
          .map((p) => `${p.publicPort} → ${p.privatePort}/${p.type}`),
        created: c.Created,
        createdText: c.Created ? new Date(c.Created * 1000).toLocaleString('zh-CN') : '',
        labels: c.Labels || {},
        // 本项目自己部署的应用（靠标签识别，便于筛选与清理）
        managedByWorkbench: (c.Labels || {})['aige.managed'] === 'true',
        appName: (c.Labels || {})['aige.app'] || '',
        domain: (c.Labels || {})['aige.domain'] || '',
      };
    });
  }

  /** 容器详情 */
  async inspectContainer(id) {
    await this._ready();
    if (!id) throw badRequest('容器 ID 不能为空');
    return this._request(`/containers/${encodeURIComponent(id)}/json`);
  }

  /** 启动容器 */
  async startContainer(id) {
    await this._ready();
    if (!id) throw badRequest('容器 ID 不能为空');
    return this._request(`/containers/${encodeURIComponent(id)}/start`, { method: 'POST' });
  }

  /** 停止容器（默认等待 10 秒优雅退出） */
  async stopContainer(id, timeoutSec = 10) {
    await this._ready();
    if (!id) throw badRequest('容器 ID 不能为空');
    return this._request(`/containers/${encodeURIComponent(id)}/stop?t=${timeoutSec}`, {
      method: 'POST',
    });
  }

  /** 重启容器（默认等待 10 秒优雅退出） */
  async restartContainer(id, timeoutSec = 10) {
    await this._ready();
    if (!id) throw badRequest('容器 ID 不能为空');
    return this._request(`/containers/${encodeURIComponent(id)}/restart?t=${timeoutSec}`, {
      method: 'POST',
    });
  }

  /**
   * 删除容器
   * @param {string} id
   * @param {object} [opts] { force: 强制删除运行中的容器, volumes: 同时删除匿名卷 }
   */
  async removeContainer(id, { force = false, volumes = false } = {}) {
    await this._ready();
    if (!id) throw badRequest('容器 ID 不能为空');
    return this._request(
      `/containers/${encodeURIComponent(id)}?force=${force ? 'true' : 'false'}&v=${volumes ? 'true' : 'false'}`,
      { method: 'DELETE', timeout: 30000 }
    );
  }

  /**
   * 获取容器日志
   * @param {string} id
   * @param {object} [opts] { tail: 末尾行数, timestamps: 是否带时间戳 }
   * @returns {Promise<string>} 纯文本日志
   */
  async getContainerLogs(id, { tail = 100, timestamps = true } = {}) {
    await this._ready();
    if (!id) throw badRequest('容器 ID 不能为空');

    const buffer = await this._request(
      `/containers/${encodeURIComponent(id)}/logs?stdout=true&stderr=true&tail=${tail}&timestamps=${timestamps ? 'true' : 'false'}`,
      { raw: true, timeout: 30000 }
    );

    const raw = buffer.toString('utf8');
    // 判断是否为多路复用流：前 8 字节的 byte1~3 必为 0，且 streamType 在 0~2
    const looksMux =
      buffer.length > 8 && buffer[1] === 0 && buffer[2] === 0 && buffer[3] === 0 && buffer[0] <= 2;

    const text = looksMux ? demuxLogStream(buffer) : raw;
    // 去除 Docker 日志里常见的 ANSI 颜色控制符，前端直接展示
    // eslint-disable-next-line no-control-regex
    return text.replace(/\u001b\[[0-9;]*m/g, '');
  }

  // ==================== 事件流 ====================

  /**
   * 订阅 Docker 事件流（长连接，NDJSON：一行一个事件）
   * ------------------------------------------------------------------
   * 用于「事件驱动自愈」：容器 die 的瞬间就能知道，不必等下一次定时巡检。
   *
   * ⚠️ 这是**长连接**，自己不会结束：
   *    · 连接中断时通过 onError / onEnd 通知调用方（由调用方决定何时重连）；
   *    · 不再需要时**必须**调用返回句柄的 close()，否则 socket 会一直挂着。
   * ⚠️ 不能用 `_request`：它会把响应体完整缓冲到结束才返回，而事件流永远不结束。
   *
   * @param {(evt: object) => void} onEvent 每收到一个事件回调一次
   * @param {object} [opts]
   * @param {object} [opts.filters] Docker 事件过滤，如 { type: ['container'], event: ['die'] }
   * @param {(err: Error) => void} [opts.onError] 出错（调用方据此重连）
   * @param {() => void} [opts.onEnd] 连接被对端正常关闭（同样应视为需要重连）
   * @returns {Promise<{ close: () => void }>}
   */
  async streamEvents(onEvent, { filters, onError, onEnd } = {}) {
    await this._ready();
    const query = filters ? `?filters=${encodeURIComponent(JSON.stringify(filters))}` : '';
    const base = this.socketPath
      ? { socketPath: this.socketPath }
      : { host: this.tcpHost, port: this.tcpPort };

    let closed = false;
    const req = http.request(
      { ...base, path: `${this.apiPrefix}/events${query}`, method: 'GET' },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          if (!closed) onError?.(new Error(`Docker 事件流返回 HTTP ${res.statusCode}`));
          return;
        }
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk;
          let idx;
          // 按换行切分：一行一个 JSON 事件
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try {
              onEvent(JSON.parse(line));
            } catch {
              /* 半行 / 坏行直接丢，不影响后续事件 */
            }
          }
        });
        res.on('end', () => {
          if (!closed) onEnd?.();
        });
        res.on('error', (err) => {
          if (!closed) onError?.(err);
        });
      }
    );

    req.on('error', (err) => {
      if (!closed) onError?.(err);
    });
    // 事件流是长连接：显式关掉请求超时，否则会被默认值掐断
    req.setTimeout(0);
    req.end();

    return {
      close: () => {
        closed = true;
        req.destroy();
      },
    };
  }

  // ==================== 镜像 ====================

  /** 镜像列表 */
  async listImages() {
    await this._ready();
    const raw = await this._request('/images/json?all=false');
    return (Array.isArray(raw) ? raw : []).map((i) => ({
      id: i.Id,
      shortId: i.Id.replace('sha256:', '').slice(0, 12),
      tags: (i.RepoTags || []).filter((t) => t !== '<none>:<none>'),
      size: i.Size,
      sizeText: DockerClient.formatSize(i.Size),
      created: i.Created,
      createdText: i.Created ? new Date(i.Created * 1000).toLocaleString('zh-CN') : '',
      containers: i.Containers ?? 0,
    }));
  }

  /**
   * 拉取镜像（若本地已有则跳过）
   * @param {string} image 形如 louislam/uptime-kuma:1
   * @param {(msg: string) => void} [onProgress] 进度回调，用于部署日志
   */
  async pullImage(image, onProgress) {
    await this._ready();
    if (!image) throw badRequest('镜像名不能为空');

    const [name, tag = 'latest'] = image.split(':');
    try {
      const local = await this._request(`/images/${encodeURIComponent(image)}/json`, {
        timeout: 10000,
      });
      if (local?.Id) {
        onProgress?.(`镜像 ${image} 已存在于本地，跳过拉取`);
        return { image, skipped: true };
      }
    } catch {
      // 本地没有该镜像，继续走拉取流程
    }

    onProgress?.(`开始拉取镜像 ${image} …`);
    const buffer = await this._request(
      `/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`,
      { method: 'POST', raw: true, timeout: 600000 } // 大镜像可能拉很久，给 10 分钟
    );

    // 拉取过程是流式 JSON，逐行解析出错误（Docker 在流里返回 error 字段）
    const lines = buffer.toString('utf8').split('\n').filter(Boolean);
    let lastStatus = '';
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.error) throw upstream(`拉取镜像失败：${obj.error}`);
        if (obj.status) lastStatus = obj.status;
      } catch (err) {
        if (err.expected) throw err;
        /* 忽略无法解析的行 */
      }
    }
    onProgress?.(`镜像 ${image} 拉取完成（${lastStatus || 'done'}）`);
    return { image, skipped: false };
  }

  // ==================== 网络 ====================

  /**
   * 清理无用镜像（dangling，即 <none>:<none>）
   * 自愈用：磁盘水位告急时先清这些——它们不承载任何容器，删掉零风险。
   * @param {{danglingOnly?: boolean}} opts danglingOnly=false 时会连未被引用的镜像一起清
   */
  async pruneImages({ danglingOnly = true } = {}) {
    await this._ready();
    const filters = danglingOnly ? '{"dangling":["true"]}' : '{}';
    const raw = await this._request(`/images/prune?filters=${encodeURIComponent(filters)}`, {
      method: 'POST',
      timeout: 120000,
    });

    const deleted = raw?.ImagesDeleted || [];
    const reclaimed = Number(raw?.SpaceReclaimed) || 0;
    return {
      deletedCount: deleted.length,
      reclaimed,
      reclaimedText: DockerClient.formatSize(reclaimed),
      danglingOnly,
    };
  }

  /** 网络列表 */
  async listNetworks() {
    await this._ready();
    const raw = await this._request('/networks');
    return (Array.isArray(raw) ? raw : []).map((n) => ({
      id: n.Id,
      name: n.Name,
      driver: n.Driver,
      scope: n.Scope,
    }));
  }

  /** 确保网络存在（不存在则创建），返回网络名 */
  async ensureNetwork(name) {
    await this._ready();
    const networks = await this.listNetworks();
    if (networks.some((n) => n.name === name)) return name;
    await this._request('/networks/create', {
      method: 'POST',
      body: { Name: name, Driver: 'bridge', CheckDuplicate: true },
    });
    return name;
  }

  // ==================== 创建容器（部署应用用） ====================

  /**
   * 创建容器
   * @param {object} spec
   * @param {string} spec.name          容器名
   * @param {string} spec.image         镜像
   * @param {number} spec.hostPort      宿主机端口
   * @param {number} spec.containerPort 容器内端口
   * @param {object} [spec.env]         环境变量键值对
   * @param {string[]} [spec.binds]     卷挂载 ["/host:/container"]
   * @param {string} [spec.network]     网络名
   * @param {object} [spec.labels]      标签
   * @param {string} [spec.restartPolicy='unless-stopped']
   */
  async createContainer(spec) {
    await this._ready();
    const {
      name,
      image,
      hostPort,
      containerPort,
      env = {},
      binds = [],
      network,
      labels = {},
      restartPolicy = 'unless-stopped',
      cmd,
    } = spec;

    if (!name || !image) throw badRequest('容器名与镜像不能为空');

    const exposed = containerPort ? { [`${containerPort}/tcp`]: {} } : {};
    const portBindings = containerPort
      ? { [`${containerPort}/tcp`]: [{ HostPort: String(hostPort) }] }
      : {};

    // Docker 接口返回 409 表示名字冲突，这里给出可读提示
    try {
      const result = await this._request(`/containers/create?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        body: {
          Image: image,
          ...(cmd ? { Cmd: cmd } : {}),
          Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
          Labels: { 'aige.managed': 'true', ...labels },
          ExposedPorts: exposed,
          HostConfig: {
            PortBindings: portBindings,
            Binds: binds,
            RestartPolicy: { Name: restartPolicy },
            ...(network ? { NetworkMode: network } : {}),
          },
        },
        timeout: 60000,
      });
      return { id: result.Id, name, warnings: result.Warnings || [] };
    } catch (err) {
      if (String(err.detail?.response || '').includes('already in use')) {
        throw badRequest(`容器名 ${name} 已被占用，请先删除同名容器或换一个应用名`);
      }
      throw err;
    }
  }

  /** 等待容器进入运行状态 */
  async waitRunning(id, { timeoutMs = 30000, intervalMs = 1500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    /* eslint-disable no-await-in-loop */
    while (Date.now() < deadline) {
      const info = await this.inspectContainer(id);
      const state = info?.State;
      if (state?.Running) return true;
      if (state?.Status === 'exited' && state.ExitCode !== 0) {
        const logs = await this.getContainerLogs(id, { tail: 30 }).catch(() => '');
        throw upstream(
          `容器启动后立即退出（exit code ${state.ExitCode}）。最近日志：\n${logs.slice(-600)}`
        );
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw upstream('容器启动超时（30 秒内未进入运行状态），请查看容器日志');
    /* eslint-enable no-await-in-loop */
  }

  // ==================== 工具方法 ====================

  /** 字节数转可读体积 */
  static formatSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  /**
   * 找一个空闲的宿主机端口
   * 同时兼顾「Docker 已占用」和「宿主机本机被占用」两种情况
   * @param {number} start 起始端口
   * @param {number} end   结束端口
   */
  async findFreePort(start = 31000, end = 31999) {
    const containers = await this.listContainers(true);
    const used = new Set();
    containers.forEach((c) => c.ports.forEach((p) => p.publicPort && used.add(p.publicPort)));

    /* eslint-disable no-await-in-loop */
    for (let port = start; port <= end; port += 1) {
      if (used.has(port)) continue;
      const free = await new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => server.close(() => resolve(true)));
        server.listen(port, '0.0.0.0');
      });
      if (free) return port;
    }
    /* eslint-enable no-await-in-loop */
    throw new AppError(
      `端口区间 ${start}-${end} 已无可用端口，请清理闲置容器或调整端口范围`,
      500,
      'NO_FREE_PORT'
    );
  }

  /** 连通性自检 */
  async testConnection() {
    await this._ready();
    const version = await this._request('/version', { timeout: 8000 });
    const info = await this._request('/info', { timeout: 8000 }).catch(() => null);
    return {
      ok: true,
      message: `连接成功：Docker ${version.Version}（API ${version.ApiVersion}）· ${info?.Containers ?? '?'} 个容器`,
      version: version.Version,
      apiVersion: version.ApiVersion,
      os: version.Os,
      arch: version.Arch,
      containers: info?.Containers,
      images: info?.Images,
    };
  }
}

/** 工厂：从系统配置读取 Docker 地址 */
function createClient() {
  const cfg = settings.getDockerConfig();
  return new DockerClient(cfg);
}

module.exports = { DockerClient, createClient };
