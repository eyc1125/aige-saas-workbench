/**
 * 应用商店路由
 * ------------------------------------------------------------------
 * GET  /api/apps/templates                     可部署的应用模板列表
 * GET  /api/apps/templates/:key/compose        查看某个模板的 docker-compose 参考文件
 * POST /api/apps/deploy                        发起一键部署（立即返回 task_id）
 * GET  /api/apps/tasks                         部署任务列表
 * GET  /api/apps/tasks/:taskId                 任务详情（进度 / 结果）
 * GET  /api/apps/tasks/:taskId/logs            任务日志（支持 sinceId 增量拉取）
 * DELETE /api/apps/tasks/:taskId/logs          清空任务日志（仅清理记录，不动容器）
 */
'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const { badRequest, notFound } = require('../utils/errors');
const { listTemplates, getTemplate, toComposeYaml } = require('../services/apps');
const deployService = require('../services/deploy');

const router = express.Router();

/** 模板列表 */
router.get(
  '/templates',
  asyncHandler(async (_req, res) => {
    const list = listTemplates();
    return success(res, { list, total: list.length });
  })
);

/** 查看模板对应的 docker-compose（参考 / 手工部署兜底） */
router.get(
  '/templates/:key/compose',
  asyncHandler(async (req, res) => {
    const tpl = getTemplate(req.params.key);
    if (!tpl) throw notFound(`应用模板不存在：${req.params.key}`);
    return success(res, { key: tpl.key, name: tpl.name, compose: toComposeYaml(tpl.key) });
  })
);

/** 发起部署 */
router.post(
  '/deploy',
  asyncHandler(async (req, res) => {
    const { appKey, domain } = req.body || {};
    if (!appKey) throw badRequest('appKey 不能为空');

    const result = deployService.startDeploy({
      appKey,
      domain,
      actor: req.user?.username || 'admin',
      source: 'web',
    });

    return success(res, result, `部署任务已创建，正在后台执行：${result.taskId}`);
  })
);

/** 任务列表 */
router.get(
  '/tasks',
  asyncHandler(async (req, res) => {
    const limit = Number(req.query.limit) || 20;
    const list = deployService.listTasks(limit);
    return success(res, { list, total: list.length });
  })
);

/** 任务详情 */
router.get(
  '/tasks/:taskId',
  asyncHandler(async (req, res) => {
    const task = deployService.getTask(req.params.taskId);
    if (!task) throw notFound(`部署任务不存在：${req.params.taskId}`);
    return success(res, task);
  })
);

/** 任务日志（前端按 sinceId 增量轮询，避免重复传输） */
router.get(
  '/tasks/:taskId/logs',
  asyncHandler(async (req, res) => {
    const task = deployService.getTask(req.params.taskId);
    if (!task) throw notFound(`部署任务不存在：${req.params.taskId}`);

    const sinceId = Number(req.query.sinceId) || 0;
    const logs = deployService.getLogs(task.id, sinceId);
    return success(res, {
      taskId: task.id,
      status: task.status,
      progress: task.progress,
      currentStep: task.current_step,
      steps: task.steps,
      logs,
      lastId: logs.length ? logs[logs.length - 1].id : sinceId,
    });
  })
);

/** 清空某个任务的日志记录 */
router.delete(
  '/tasks/:taskId/logs',
  asyncHandler(async (req, res) => {
    const db = require('../db');
    const info = db.prepare('DELETE FROM deploy_logs WHERE task_id = ?').run(req.params.taskId);
    return success(res, { deleted: info.changes });
  })
);

module.exports = router;
