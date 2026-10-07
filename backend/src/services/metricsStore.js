/**
 * 资源趋势落库与查询
 * ------------------------------------------------------------------
 * 解决两个问题：
 *   1. 曲线一刷新就空 —— 以前样本只存在前端内存里，页面重载即丢。
 *   2. 想看「过去 7 天磁盘是不是在涨」—— 只留 10 分钟窗口看不出来。
 *
 * 采样周期 2 分钟（默认）：1440 分钟/天 ÷ 2 = 720 条/天，
 * 30 天约 2.2 万行、约 2MB —— 对这台只剩 15G 的盘可以忽略。
 * 保留期 30 天，启动时清一次 + 每天清一次，绝不无限增长。
 *
 * 查询按「时间桶」聚合：范围越长桶越大，保证任何范围下最多返回 ~180 个点，
 * 否则 30 天视图一次要吐 2 万个点到浏览器，图表直接卡死。
 */
'use strict';

const db = require('../db');
const metrics = require('./metrics');

/** 采样间隔：2 分钟 */
const SAMPLE_INTERVAL_MS = 2 * 60 * 1000;
/** 保留天数 */
const KEEP_DAYS = 30;

let timer = null;

const insertStmt = db.prepare(`
  INSERT INTO metrics_samples
    (ts, at, cpu, load1, load5, load15,
     mem_used_mb, mem_total_mb, mem_percent,
     disk_used_gb, disk_total_gb, disk_percent)
  VALUES
    (@ts, @at, @cpu, @load1, @load5, @load15,
     @memUsedMb, @memTotalMb, @memPercent,
     @diskUsedGb, @diskTotalGb, @diskPercent)
`);

/** 采一条并写库 */
function record() {
  const s = metrics.snapshot();
  const diskOk = s.disk && s.disk.available;
  const now = new Date();

  insertStmt.run({
    ts: Math.floor(now.getTime() / 1000),
    at: now.toLocaleString('sv-SE').replace('T', ' '), // 'YYYY-MM-DD HH:MM:SS'
    cpu: s.cpuUsage,
    load1: s.load?.one ?? null,
    load5: s.load?.five ?? null,
    load15: s.load?.fifteen ?? null,
    memUsedMb: s.memUsedMb ?? null,
    memTotalMb: s.memTotalMb ?? null,
    memPercent: s.memUsage ?? null,
    diskUsedGb: diskOk ? s.disk.usedGb : null,
    diskTotalGb: diskOk ? s.disk.totalGb : null,
    diskPercent: diskOk ? s.disk.usage : null,
  });

  return true;
}

/** 删掉超过保留期的样本 */
function prune() {
  const cutoff = Math.floor(Date.now() / 1000) - KEEP_DAYS * 86400;
  return db.prepare('DELETE FROM metrics_samples WHERE ts < ?').run(cutoff).changes || 0;
}

/**
 * 各范围的时间桶大小（秒）
 * 目标是任何范围都只返回约 100~180 个点。
 */
const RANGES = {
  '1h': { seconds: 3600, bucket: 120 },
  '6h': { seconds: 6 * 3600, bucket: 300 },
  '24h': { seconds: 24 * 3600, bucket: 900 },
  '7d': { seconds: 7 * 86400, bucket: 3600 },
  '30d': { seconds: 30 * 86400, bucket: 6 * 3600 },
};

/**
 * 取趋势数据
 * @param {string} range 1h / 6h / 24h / 7d / 30d
 * @returns {{ range:string, bucketSeconds:number, points:Array }}
 */
function getSeries(range = '1h') {
  const cfg = RANGES[range] || RANGES['1h'];
  const since = Math.floor(Date.now() / 1000) - cfg.seconds;
  const bucket = cfg.bucket;

  // 按桶聚合取平均：时间桶让点数可控，平均比取某个瞬时点更能代表一段区间
  const rows = db
    .prepare(
      `SELECT
         (ts / @bucket) * @bucket                    AS bucketTs,
         MIN(at)                                     AS at,
         ROUND(AVG(cpu), 1)                          AS cpu,
         ROUND(AVG(load1), 2)                        AS load1,
         ROUND(AVG(mem_percent), 1)                  AS memPercent,
         ROUND(AVG(mem_used_mb))                     AS memUsedMb,
         ROUND(AVG(disk_percent), 1)                 AS diskPercent,
         ROUND(AVG(disk_used_gb), 1)                 AS diskUsedGb,
         COUNT(*)                                    AS samples
       FROM metrics_samples
       WHERE ts >= @since
       GROUP BY bucketTs
       ORDER BY bucketTs ASC`
    )
    .all({ bucket, since });

  return {
    range,
    bucketSeconds: bucket,
    from: since,
    points: rows.map((r) => ({
      ts: r.bucketTs,
      at: r.at,
      cpu: r.cpu,
      load1: r.load1,
      memPercent: r.memPercent,
      memUsedMb: r.memUsedMb,
      diskPercent: r.diskPercent,
      diskUsedGb: r.diskUsedGb,
      samples: r.samples,
    })),
  };
}

/** 库里现有多少条、最早最晚是什么时候（用于界面上显示"数据从什么时候开始"） */
function stats() {
  const row = db
    .prepare('SELECT COUNT(*) AS total, MIN(ts) AS first, MAX(ts) AS last FROM metrics_samples')
    .get();
  return {
    total: row.total || 0,
    firstAt: row.first ? new Date(row.first * 1000).toLocaleString('zh-CN') : null,
    lastAt: row.last ? new Date(row.last * 1000).toLocaleString('zh-CN') : null,
    keepDays: KEEP_DAYS,
    intervalMinutes: SAMPLE_INTERVAL_MS / 60000,
  };
}

/** 启动采样：先立刻采一条（让曲线不至于一开始就是空的），再按周期走 */
function startRecorder(intervalMs = SAMPLE_INTERVAL_MS) {
  if (timer) return;
  try {
    record();
  } catch (err) {
    console.warn('[metrics] 首次采样失败：', err.message);
  }
  timer = setInterval(() => {
    try {
      record();
    } catch (err) {
      console.warn('[metrics] 采样失败：', err.message);
    }
  }, intervalMs);
  timer.unref?.();
}

function stopRecorder() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  record,
  prune,
  getSeries,
  stats,
  startRecorder,
  stopRecorder,
  RANGES,
  SAMPLE_INTERVAL_MS,
  KEEP_DAYS,
};
