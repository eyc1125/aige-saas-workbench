/**
 * 健康巡检与自愈路由
 * ------------------------------------------------------------------
 * GET  /api/inspect            跑一遍巡检，返回各项结论 + 自动自愈状态
 * POST /api/inspect/fix        执行指定检查项的修复（受熔断约束）  body: { checkId }
 * PUT  /api/inspect/auto       开关自动自愈 / 调巡检间隔         body: { enabled, intervalMin }
 * POST /api/inspect/auto/run   立刻跑一轮自动自愈（手动触发）
 *
 * 说明：巡检是「只读 + 可能较慢」（要读证书、查云端、列容器），
 *      所以前端按需触发，不做轮询。
 */
'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const { writeLog, clientIp } = require('../utils/logger');
const healthService = require('../services/health');

const router = express.Router();

/** 巡检：各项检查 + 自动自愈配置与最近一次自动执行结果 */
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const report = await healthService.runChecks();
    // ⚠️ 顺序不能反：getStatus() 里的 checkCatalog 是静态元数据，
    //    展开时要确保它不会盖掉 report.checks（详见 health.js 的注释）
    return success(res, { ...report, ...healthService.getStatus() });
  })
);

/** 执行一次修复 */
router.post(
  '/fix',
  asyncHandler(async (req, res) => {
    const checkId = String(req.body?.checkId || '').trim();
    const result = await healthService.applyFix(checkId, {
      userId: req.user.id,
      username: req.user.username,
      source: 'web',
      ip: clientIp(req),
    });
    return success(res, result, result.message || '修复已完成');
  })
);

/** 开关自动自愈 */
router.put(
  '/auto',
  asyncHandler(async (req, res) => {
    const { enabled, intervalMin } = req.body || {};
    const cfg = healthService.setAutoHeal({ enabled, intervalMin });
    const runtime = healthService.syncAutoHealTimer();

    writeLog({
      userId: req.user.id,
      username: req.user.username,
      module: 'health',
      action: 'update_auto_heal',
      target: runtime.running ? `开启（每 ${runtime.intervalMin} 分钟）` : '关闭',
      source: 'web',
      status: 'success',
      ip: clientIp(req),
    });

    return success(
      res,
      { ...cfg, running: runtime.running },
      runtime.running ? '自动自愈已开启' : '自动自愈已关闭'
    );
  })
);

/** 立刻跑一轮自动自愈（只执行标记为可自动的项） */
router.post(
  '/auto/run',
  asyncHandler(async (req, res) => {
    const result = await healthService.runAutoHeal();
    writeLog({
      userId: req.user.id,
      username: req.user.username,
      module: 'health',
      action: 'run_auto_heal',
      target: `${result.applied.length} 项执行 / ${result.skipped.length} 项跳过`,
      source: 'web',
      status: 'success',
      ip: clientIp(req),
    });
    return success(res, result, `自动自愈执行完成：处理 ${result.applied.length} 项`);
  })
);

module.exports = router;
