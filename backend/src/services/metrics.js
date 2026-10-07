/**
 * 系统指标采集
 * ------------------------------------------------------------------
 * 为什么不用宝塔接口的 CPU 与负载值：**它们本身就是错的**（实测）
 *   · 宝塔 /system 返回的 `load` 在不同版本里是**空格分隔的字符串**
 *     （"2.24 1.66 1.55"），而 baota.js 按 `data.load.one` 取值 →
 *     永远取到 undefined → 界面长期显示「系统负载 0」。
 *   · `cpuRealUsed` 实测飘到 97.5%~100%，而 /proc/stat 两秒采样的真实值是 58%。
 *   · `setup_time` 取不到 → 运行时长一直是 null。
 * 所以 CPU / 负载 / 运行时长 / 内存一律自己从 /proc 读，宝塔只保留磁盘等它擅长的部分。
 *
 * 容器里读 /proc 得到的是**宿主机**的值（loadavg / uptime / cpu 都不是 namespaced 的），
 * 这点已实测确认：容器内 /proc/loadavg 与宿主机完全一致。
 *
 * CPU 使用率必须用「两次采样的差值」算，不能取瞬时值 —— 所以这里常驻一个
 * 定时采样器（默认 5 秒），把最近一次结果缓存起来给接口直接取。
 */
'use strict';

const fs = require('fs');
const os = require('os');

const PROC_STAT = '/proc/stat';
const PROC_LOADAVG = '/proc/loadavg';
const PROC_UPTIME = '/proc/uptime';
const PROC_MEMINFO = '/proc/meminfo';

/** 内存信息缓存（每次读取都要解析整个文件，缓存 2 秒足够） */
let memCache = { at: 0, value: null };

/** CPU 采样的上一次快照 */
let prevCpu = null;
/** 最近一次算出的 CPU 使用率（0~100，保留一位小数） */
let latestCpu = null;
let latestCpuAt = 0;

let timer = null;

// ============================================================
// 基础读取
// ============================================================

/** 读 /proc/stat 首行，返回累计的 idle 与 total jiffies */
function readCpuCounters() {
  const line = fs.readFileSync(PROC_STAT, 'utf8').split('\n')[0];
  // 格式：cpu user nice system idle iowait irq softirq steal guest guest_nice
  const v = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (v[3] || 0) + (v[4] || 0); // idle + iowait 都算空闲
  const total = v.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  return { idle, total, at: Date.now() };
}

/**
 * 用两次采样算 CPU 使用率
 * 差值太小的间隔（<200ms）不算，否则抖到没意义
 */
function computeCpuUsage() {
  const cur = readCpuCounters();
  if (!prevCpu) {
    prevCpu = cur;
    return null;
  }
  const dTotal = cur.total - prevCpu.total;
  const dIdle = cur.idle - prevCpu.idle;
  const elapsed = cur.at - prevCpu.at;
  prevCpu = cur;

  if (dTotal <= 0 || elapsed < 200) return null;
  const usage = ((dTotal - dIdle) / dTotal) * 100;
  return Number(Math.min(100, Math.max(0, usage)).toFixed(1));
}

/** 负载（1 / 5 / 15 分钟） */
function readLoad() {
  try {
    const [one, five, fifteen] = fs
      .readFileSync(PROC_LOADAVG, 'utf8')
      .trim()
      .split(/\s+/)
      .map(Number);
    return { one, five, fifteen };
  } catch {
    return { one: 0, five: 0, fifteen: 0 };
  }
}

/** 运行时长（秒） */
function readUptimeSeconds() {
  try {
    return Math.floor(Number(fs.readFileSync(PROC_UPTIME, 'utf8').split(/\s+/)[0]));
  } catch {
    return null;
  }
}

/**
 * 内存（MB）
 * 用 MemAvailable 而不是 MemFree：MemAvailable 已经把可回收的缓存算进去了，
 * 拿 MemFree 当"已用"会得出一个吓人的假数字。
 */
function readMemory() {
  if (memCache.value && Date.now() - memCache.at < 2000) return memCache.value;
  try {
    const txt = fs.readFileSync(PROC_MEMINFO, 'utf8');
    const pick = (key) => {
      const m = txt.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
      return m ? Number(m[1]) : 0;
    };
    const totalKb = pick('MemTotal');
    const availKb = pick('MemAvailable') || pick('MemFree');
    const totalMb = Math.round(totalKb / 1024);
    const usedMb = Math.round((totalKb - availKb) / 1024);
    const value = {
      memTotalMb: totalMb,
      memUsedMb: usedMb,
      memFreeMb: totalMb - usedMb,
      memUsage: totalMb > 0 ? Number(((usedMb / totalMb) * 100).toFixed(1)) : 0,
    };
    memCache = { at: Date.now(), value };
    return value;
  } catch {
    return { memTotalMb: 0, memUsedMb: 0, memFreeMb: 0, memUsage: 0 };
  }
}

/**
 * 磁盘（GB）
 * 用 Node 内置的 fs.statfs 直接问文件系统，不依赖宝塔；
 * 容器里的 overlay 会报告底层宿主磁盘的容量，这正是我们要的。
 */
function readDisk() {
  try {
    const s = fs.statfsSync('/');
    const total = (s.blocks * s.bsize) / 1024 ** 3;
    const free = (s.bavail * s.bsize) / 1024 ** 3;
    const used = total - free;
    return {
      available: true,
      path: '/',
      totalGb: Number(total.toFixed(1)),
      usedGb: Number(used.toFixed(1)),
      freeGb: Number(free.toFixed(1)),
      usage: total > 0 ? Number(((used / total) * 100).toFixed(1)) : 0,
    };
  } catch {
    return { available: false, reason: 'fs.statfs 不可用' };
  }
}

/** 人类可读的运行时长 */
function humanUptime(seconds) {
  if (seconds === null || seconds === undefined) return '-';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
}

// ============================================================
// 对外接口
// ============================================================

/**
 * 一次性读齐所有系统指标
 * CPU 取采样器的最新结果；若还没有（服务刚启动不到 5 秒），返回 null
 * 让前端的进度条显示"测量中"，而不是显示一个假数字。
 */
function snapshot() {
  const mem = readMemory();
  const uptimeSeconds = readUptimeSeconds();
  const cpuNum = os.cpus().length || 1;

  return {
    cpuNum,
    cpuUsage: latestCpu,
    cpuUsageAt: latestCpuAt || null,
    load: readLoad(),
    loadPercent: latestCpu, // 兼容旧字段名
    uptimeSeconds,
    uptimeText: humanUptime(uptimeSeconds),
    disk: readDisk(),
    ...mem,
    memTotalGb: Number((mem.memTotalMb / 1024).toFixed(2)),
    memUsedGb: Number((mem.memUsedMb / 1024).toFixed(2)),
    sampledAt: new Date().toISOString(),
  };
}

/** 采样一次并把 CPU 结果落到缓存（供定时器调用） */
function tick() {
  const usage = computeCpuUsage();
  if (usage !== null) {
    latestCpu = usage;
    latestCpuAt = Date.now();
  }
  return latestCpu;
}

/**
 * 启动常驻采样
 * 头一次要先把 prevCpu 填上，否则第一个 5 秒内 CPU 是 null。
 * 采样周期 5 秒：够实时，又不会给这台 2 核机器添负担。
 */
function startSampler(intervalMs = 5000) {
  if (timer) return;
  prevCpu = readCpuCounters();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  // 立刻跑一次，让接口在第一个周期内也能拿到近似值
  setTimeout(tick, 600).unref?.();
}

function stopSampler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  snapshot,
  tick,
  startSampler,
  stopSampler,
  humanUptime,
  readDisk,
  readMemory,
};
