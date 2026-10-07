/**
 * 仪表盘路由
 * ------------------------------------------------------------------
 * GET /api/dashboard/overview  一次拉齐：服务器状态 + 统计卡片 + 最近操作日志
 * GET /api/dashboard/server    只拉服务器状态（前端定时轮询画 CPU/内存曲线）
 *
 * 设计说明：CPU / 内存的时间曲线由前端轮询本接口并自行累积（不落库、不占存储），
 *          因此这里返回的是「当前瞬时值」。
 * 容错：宝塔或 Docker 未配置/不可用时，对应区块返回 unavailable + 原因，
 *      让仪表盘仍然可用（而不是整页报错），并给出「去配置」的指引。
 */
'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const db = require('../db');
const settings = require('../services/settings');
const baotaService = require('../services/baota');
const cloudflareService = require('../services/cloudflare');
const dockerService = require('../services/docker');

const router = express.Router();

const recentLogsStmt = db.prepare(`
  SELECT id, username, module, action, target, status, message, source, created_at
  FROM operation_logs ORDER BY id DESC LIMIT ?
`);

/**
 * 抓取服务器状态（宝塔）
 * 失败不抛错，返回 { available: false, reason }
 */
async function fetchServerStatus() {
  try {
    const baota = baotaService.createClient();
    const [system, disk] = await Promise.all([baota.getSystemTotal(), baota.getDiskInfo()]);
    return {
      available: true,
      ...system,
      disk,
      // 内存总量按 MB 换算成 GB 方便前端展示
      memTotalGb: Number((system.memTotalMb / 1024).toFixed(2)),
      memUsedGb: Number((system.memUsedMb / 1024).toFixed(2)),
    };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}

/** 统计卡片：网站数 / 域名数 / 容器数 */
async function fetchCounts() {
  const counts = {
    websites: { available: false, total: 0, running: 0, stopped: 0, reason: '' },
    domains: { available: false, total: 0, reason: '' },
    containers: { available: false, total: 0, running: 0, stopped: 0, images: 0, reason: '' },
    apps: { total: 0, success: 0, running: 0 },
  };

  // 网站（宝塔）
  try {
    const baota = baotaService.createClient();
    const { list, total } = await baota.getSiteList({ page: 1, limit: 200 });
    counts.websites = {
      available: true,
      total: total || list.length,
      running: list.filter((s) => s.status === 'running').length,
      stopped: list.filter((s) => s.status !== 'running').length,
      reason: '',
    };
  } catch (err) {
    counts.websites.reason = err.message;
  }

  // 域名（Cloudflare）
  try {
    const cf = cloudflareService.createClient();
    const zones = await cf.listZones();
    counts.domains = { available: true, total: zones.length, reason: '' };
  } catch (err) {
    counts.domains.reason = err.message;
  }

  // 容器与镜像（Docker）
  try {
    const docker = dockerService.createClient();
    const [containers, images] = await Promise.all([docker.listContainers(true), docker.listImages()]);
    counts.containers = {
      available: true,
      total: containers.length,
      running: containers.filter((c) => c.running).length,
      stopped: containers.filter((c) => !c.running).length,
      images: images.length,
      reason: '',
    };
  } catch (err) {
    counts.containers.reason = err.message;
  }

  // 本系统部署的应用（读本地库，不受外部服务影响）
  const appStat = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
    FROM deploy_tasks
  `).get();
  counts.apps = {
    total: appStat.total || 0,
    success: appStat.success || 0,
    running: appStat.running || 0,
  };

  return counts;
}

/** 仪表盘总览 */
router.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const [server, counts, net] = await Promise.all([
      fetchServerStatus(),
      fetchCounts(),
      (async () => {
        try {
          return await baotaService.createClient().getNetWork();
        } catch {
          return { unavailable: true };
        }
      })(),
    ]);

    const logs = recentLogsStmt.all(12);

    return success(res, {
      server,
      network: net,
      counts,
      recentLogs: logs,
      updatedAt: new Date().toLocaleString('zh-CN'),
      configStatus: {
        baota: !!settings.get('bt_api_key'),
        cloudflare: !!settings.get('cf_api_token'),
        docker: !!settings.get('docker_host'),
      },
    });
  })
);

/** 只取服务器状态（前端 10 秒轮询一次，用于实时曲线） */
router.get(
  '/server',
  asyncHandler(async (_req, res) => {
    const server = await fetchServerStatus();
    const containers = await (async () => {
      try {
        const list = await dockerService.createClient().listContainers(true);
        return {
          available: true,
          total: list.length,
          running: list.filter((c) => c.running).length,
        };
      } catch (err) {
        return { available: false, total: 0, running: 0, reason: err.message };
      }
    })();

    return success(res, {
      server,
      containers,
      timestamp: Date.now(),
      time: new Date().toLocaleTimeString('zh-CN'),
    });
  })
);

module.exports = router;
