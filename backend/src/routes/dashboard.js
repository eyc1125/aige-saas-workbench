/**
 * 仪表盘路由
 * ------------------------------------------------------------------
 * GET /api/dashboard/overview  一次拉齐：服务器状态 + 统计卡片 + 最近操作日志
 * GET /api/dashboard/server    只拉服务器状态（KPI 卡定时轮询）
 * GET /api/dashboard/metrics   历史趋势（1h / 6h / 24h / 7d / 30d）
 *
 * ⚠️ 指标来源（改这块之前先看 services/metrics.js 顶部的说明）：
 *   CPU / 负载 / 运行时长 / 内存 / 磁盘一律**自己读 /proc 与 fs.statfs**，
 *   因为宝塔 /system 的 cpuRealUsed、load、setup_time 实测是错的
 *   （load 被当成对象取 → 界面长期显示「系统负载 0」）。
 *   宝塔只用来补充系统版本与分区明细。
 *
 * 趋势曲线**落库**（services/metricsStore.js）：以前曲线数据只是前端内存里累积的，
 * 一刷新页面就空了。
 *
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
const metrics = require('../services/metrics');
const metricsStore = require('../services/metricsStore');

const router = express.Router();

const recentLogsStmt = db.prepare(`
  SELECT id, username, module, action, target, status, message, source, created_at
  FROM operation_logs ORDER BY id DESC LIMIT ?
`);

/**
 * 抓取服务器状态
 * 权威指标来自 /proc（见文件头说明），宝塔只补系统版本与分区明细。
 * 宝塔挂了也不影响：CPU/内存/磁盘照常显示，只把宝塔标成不可用。
 */
async function fetchServerStatus() {
  const m = metrics.snapshot();

  let bt = null;
  let btError = '';
  try {
    const baota = baotaService.createClient();
    const [system, disk] = await Promise.all([baota.getSystemTotal(), baota.getDiskInfo()]);
    bt = { system, disk };
  } catch (err) {
    btError = err.message;
  }

  // 磁盘优先用宝塔的（它会给出分区列表，信息更全）；拿不到就用 Node 直读的
  let disk = bt?.disk;
  if (!disk || !disk.available) {
    disk = m.disk?.available
      ? {
          available: true,
          source: 'statfs',
          disks: [
            {
              path: m.disk.path,
              filesystem: '-',
              type: '-',
              total: `${m.disk.totalGb} GB`,
              used: `${m.disk.usedGb} GB`,
              free: `${m.disk.freeGb} GB`,
              usage: m.disk.usage,
            },
          ],
          root: {
            path: m.disk.path,
            total: `${m.disk.totalGb} GB`,
            used: `${m.disk.usedGb} GB`,
            free: `${m.disk.freeGb} GB`,
            usage: m.disk.usage,
          },
        }
      : { available: false, reason: m.disk?.reason || '磁盘信息不可用' };
  }

  return {
    // 即使宝塔不可用，/proc 依然给得出数据，所以这里恒为 true
    available: true,
    system: bt?.system?.system || '-',
    version: bt?.system?.version || '-',
    cpuNum: m.cpuNum,
    cpuUsage: m.cpuUsage,          // 可能为 null：服务刚启动不到一个采样周期
    cpuUsageAt: m.cpuUsageAt,
    load: m.load,
    uptimeSeconds: m.uptimeSeconds,
    uptimeText: m.uptimeText,
    uptime: m.uptimeSeconds,
    disk,
    memTotalMb: m.memTotalMb,
    memUsedMb: m.memUsedMb,
    memFreeMb: m.memFreeMb,
    memUsage: m.memUsage,
    memTotalGb: m.memTotalGb,
    memUsedGb: m.memUsedGb,
    baota: btError ? { available: false, reason: btError } : { available: true },
    sampledAt: m.sampledAt,
  };
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

/** 历史趋势（曲线用，数据来自落库样本） */
router.get(
  '/metrics',
  asyncHandler(async (req, res) => {
    const range = String(req.query.range || '1h');
    const series = metricsStore.getSeries(range);
    return success(res, { ...series, stats: metricsStore.stats() });
  })
);

module.exports = router;
