/**
 * 站点名 / 快照文件名的白名单校验
 * ------------------------------------------------------------------
 * 为什么单独抽成模块（零依赖）：
 *   这是本项目**安全上最要命的一段逻辑** —— 宝塔的 nginx 配置目录
 *   （`/www/server/panel/vhost/nginx`）里躺着**全服务器所有站点**的配置，
 *   koyca / rpoiyc / tito-* 等等都不属于本项目。
 *   一个 `../` 就能读到、甚至写到别的项目的配置上 —— 这是绝对不能出的事。
 *
 *   抽出来之后它不依赖 db / settings / baota，所以 **CI 里可以直接 require 并断言**，
 *   不需要拉起数据库或容器（见 .github/workflows/ci.yml 的 `路径校验` 步骤）。
 *   安全逻辑最怕"没人测"，独立可测比写得多漂亮都重要。
 *
 * 两层校验都要过，缺一不可：
 *   1. 站点名：不含 `/` `\` NUL，不含 `..`，不以 `.` 开头
 *   2. 备份文件名：必须是 `<站点名>.conf.bak.<10~16 位数字>`
 * 即便攻击者控制了站点名参数，也拼不出这个目录之外的任何路径。
 */
'use strict';

const { badRequest } = require('./errors');

/**
 * 校验站点名
 * @param {string} name
 * @returns {string} 去掉首尾空格后的站点名
 */
function assertSiteName(name) {
  if (!name || typeof name !== 'string') throw badRequest('站点名不能为空');
  const clean = name.trim();
  if (!clean) throw badRequest('站点名不能为空');

  // NUL 会截断底层系统调用里的路径；/ 与 \ 是路径分隔符；.. 是目录穿越
  if (/[/\\\0]/.test(clean)) throw badRequest('站点名不合法（不允许包含路径分隔符）');
  if (clean.includes('..')) throw badRequest('站点名不合法（不允许包含 ..）');
  if (clean.startsWith('.')) throw badRequest('站点名不合法（不允许以点开头）');
  // 防御性上限：正常域名远短于 253
  if (clean.length > 253) throw badRequest('站点名过长');

  return clean;
}

/**
 * 校验快照文件确实是「该站点自己的备份」
 * 形式固定为 `<站点名>.conf.bak.<毫秒时间戳>`
 * @param {string} siteName 已经过 assertSiteName 的站点名
 * @param {string} file
 * @returns {string} 原样返回文件名
 */
function assertSnapshotFileName(siteName, file) {
  const prefix = `${siteName}.conf.bak.`;
  if (typeof file !== 'string' || !file.startsWith(prefix)) {
    throw badRequest('快照文件名不合法（不是该站点的备份）');
  }
  const tail = file.slice(prefix.length);
  if (!/^\d{10,16}$/.test(tail)) throw badRequest('快照文件名不合法（时间戳格式不对）');
  return file;
}

/** 从快照文件名里取出毫秒时间戳（取不到返回 null） */
function snapshotTimestamp(file) {
  const m = /\.conf\.bak\.(\d{10,16})$/.exec(String(file || ''));
  if (!m) return null;
  const ms = Number(m[1]);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

module.exports = { assertSiteName, assertSnapshotFileName, snapshotTimestamp };
