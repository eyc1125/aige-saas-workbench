/**
 * Docker 管理路由
 * ------------------------------------------------------------------
 * GET    /api/docker/containers                 容器列表
 * GET    /api/docker/containers/:id/logs        容器日志（默认最近 100 行）
 * POST   /api/docker/containers/:id/start       启动
 * POST   /api/docker/containers/:id/stop        停止
 * POST   /api/docker/containers/:id/restart     重启
 * DELETE /api/docker/containers/:id             删除
 * GET    /api/docker/images                     镜像列表
 * GET    /api/docker/networks                   网络列表
 *
 * 日志接口额外提供 /api/docker/containers/:id/logs/stream（SSE 轮询推送），
 * 供前端「实时日志」抽屉使用，避免前端反复请求。
 */
'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const { badRequest } = require('../utils/errors');
const { writeLog, clientIp } = require('../utils/logger');
const dockerService = require('../services/docker');

const router = express.Router();

/** 容器列表（带筛选：全部 / 仅运行中 / 仅本系统部署的） */
router.get(
  '/containers',
  asyncHandler(async (req, res) => {
    const all = String(req.query.all ?? 'true') !== 'false';
    const onlyManaged = String(req.query.managed || '') === 'true';
    const state = String(req.query.state || '').trim(); // running / stopped
    const search = String(req.query.search || '')
      .trim()
      .toLowerCase();

    const docker = dockerService.createClient();
    let list = await docker.listContainers(all);

    if (onlyManaged) list = list.filter((c) => c.managedByWorkbench);
    if (state === 'running') list = list.filter((c) => c.running);
    if (state === 'stopped') list = list.filter((c) => !c.running);
    if (search)
      list = list.filter(
        (c) => c.name.toLowerCase().includes(search) || c.image.toLowerCase().includes(search)
      );

    // 运行中的排前面，其次按创建时间倒序
    list.sort((a, b) => (a.running === b.running ? b.created - a.created : a.running ? -1 : 1));

    return success(res, {
      list,
      total: list.length,
      running: list.filter((c) => c.running).length,
      stopped: list.filter((c) => !c.running).length,
    });
  })
);

/** 容器日志 */
router.get(
  '/containers/:id/logs',
  asyncHandler(async (req, res) => {
    const tail = Math.min(Math.max(Number(req.query.tail) || 100, 10), 2000);
    const docker = dockerService.createClient();
    const logs = await docker.getContainerLogs(req.params.id, { tail });
    return success(res, {
      containerId: req.params.id,
      tail,
      logs,
      lines: logs ? logs.split('\n').length : 0,
    });
  })
);

/**
 * 日志实时推送（SSE）
 * 实现方式：服务端按固定间隔拉取最新日志并推送，前端只需监听。
 * 说明：Docker 原生 follow 流与 SSE 结合需要处理连接复用，MVP 用轮询式推送更稳。
 */
router.get('/containers/:id/logs/stream', (req, res) => {
  const containerId = req.params.id;
  const tail = Math.min(Math.max(Number(req.query.tail) || 100, 10), 500);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // 让宝塔 Nginx 不缓冲 SSE
  });

  let closed = false;
  let timer = null;

  const push = async () => {
    if (closed) return;
    try {
      const logs = await dockerService.createClient().getContainerLogs(containerId, { tail });
      res.write(`data: ${JSON.stringify({ ok: true, logs, time: Date.now() })}\n\n`);
    } catch (err) {
      res.write(`data: ${JSON.stringify({ ok: false, message: err.message })}\n\n`);
    }
  };

  push();
  timer = setInterval(push, 3000);

  req.on('close', () => {
    closed = true;
    if (timer) clearInterval(timer);
    res.end();
  });
});

/** 容器操作（启动 / 停止 / 重启）——抽成同一个实现，减少重复 */
const containerAction = (action, label) =>
  asyncHandler(async (req, res) => {
    const docker = dockerService.createClient();
    await docker[action](req.params.id);

    writeLog({
      userId: req.user.id,
      username: req.user.username,
      module: 'docker',
      action: `${action.replace('Container', '').toLowerCase()}_container`,
      target: req.params.id,
      source: 'web',
      status: 'success',
      message: `容器已${label}`,
      ip: clientIp(req),
    });

    return success(res, { id: req.params.id, action }, `容器已${label}`);
  });

router.post('/containers/:id/start', containerAction('startContainer', '启动'));
router.post('/containers/:id/stop', containerAction('stopContainer', '停止'));
router.post('/containers/:id/restart', containerAction('restartContainer', '重启'));

/** 删除容器 */
router.delete(
  '/containers/:id',
  asyncHandler(async (req, res) => {
    const force = String(req.query.force ?? 'true') !== 'false';
    const volumes = String(req.query.volumes ?? 'false') === 'true';
    if (!req.params.id) throw badRequest('容器 ID 不能为空');

    const docker = dockerService.createClient();
    await docker.removeContainer(req.params.id, { force, volumes });

    writeLog({
      userId: req.user.id,
      username: req.user.username,
      module: 'docker',
      action: 'remove_container',
      target: req.params.id,
      source: 'web',
      status: 'success',
      detail: { force, volumes },
      ip: clientIp(req),
    });

    return success(res, { id: req.params.id, removed: true }, '容器已删除');
  })
);

/** 镜像列表 */
router.get(
  '/images',
  asyncHandler(async (_req, res) => {
    const docker = dockerService.createClient();
    const list = await docker.listImages();
    return success(res, { list, total: list.length });
  })
);

/** 网络列表 */
router.get(
  '/networks',
  asyncHandler(async (_req, res) => {
    const docker = dockerService.createClient();
    const list = await docker.listNetworks();
    return success(res, { list, total: list.length });
  })
);

module.exports = router;
