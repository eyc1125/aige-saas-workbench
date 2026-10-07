/**
 * SQLite 驱动适配层
 * ------------------------------------------------------------------
 * 主驱动：better-sqlite3（需求指定，生产 Docker 镜像里会正常编译安装）
 * 回退驱动：Node 内置 node:sqlite（Node ≥ 22.5 自带，无需编译）
 *
 * 为什么需要回退：
 *   在 Windows 开发机上若没有 C++ 编译工具链（python/make/g++），
 *   better-sqlite3 装不上，整个后端就跑不起来、无法自查。
 *   生产环境（node:20-alpine + 构建工具链）始终使用 better-sqlite3，
 *   本回退只在「主驱动加载失败」时生效，并对上层完全透明。
 *
 * 两个驱动的 API 高度接近（prepare/exec/close、run/get/all 返回值一致），
 * 需要补齐的只有 pragma() 与 transaction()，在适配器里实现。
 */
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 把 node:sqlite 补齐成 better-sqlite3 的接口形状
 */
class NodeSqliteAdapter {
  constructor(nativeDb) {
    this._db = nativeDb;
  }

  prepare(sql) {
    return this._db.prepare(sql);
  }

  exec(sql) {
    return this._db.exec(sql);
  }

  /** better-sqlite3 的 pragma() 形式在这里用 exec 实现 */
  pragma(statement) {
    return this._db.exec(`PRAGMA ${statement}`);
  }

  /**
   * 事务包装：返回一个可调用函数，内部自动 BEGIN / COMMIT / ROLLBACK
   * 用法与 better-sqlite3 的 db.transaction(fn) 一致
   */
  transaction(fn) {
    return (...args) => {
      this._db.exec('BEGIN');
      try {
        const result = fn(...args);
        this._db.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          this._db.exec('ROLLBACK');
        } catch {
          /* 回滚失败时保留原始错误 */
        }
        throw err;
      }
    };
  }

  close() {
    return this._db.close();
  }
}

/**
 * 打开数据库
 * @param {string} file 数据库文件路径
 * @returns {{ db: object, driver: string }}
 */
function open(file) {
  // 先确保目录存在（容器首次启动时 data 目录可能为空）
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let betterError;
  try {
    // 懒加载：装不上时不让整个模块在 require 阶段就崩掉，交给下面的回退分支处理
    const Database = require('better-sqlite3');
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return { db, driver: 'better-sqlite3' };
  } catch (err) {
    betterError = err;
  }

  try {
    // 同上：Node 22.5+ 才有 node:sqlite，老版本走到这里会抛，由外层报错
    const { DatabaseSync } = require('node:sqlite');
    const native = new DatabaseSync(file);
    native.exec('PRAGMA journal_mode = WAL');
    native.exec('PRAGMA foreign_keys = ON');
    return { db: new NodeSqliteAdapter(native), driver: 'node:sqlite（内置回退驱动）' };
  } catch (err) {
    // 带上 cause：上面那条 better-sqlite3 的原始错误在 message 里只说了一句话，
    // 排查时要看完整堆栈（是缺编译工具链、还是版本不兼容）
    throw new Error(
      'SQLite 初始化失败：better-sqlite3 与 Node 内置 node:sqlite 均不可用。\n' +
        `  better-sqlite3 错误：${betterError.message}\n` +
        `  node:sqlite 错误：${err.message}\n` +
        '  建议：Linux/macOS 上安装编译工具（apt install -y python3 make g++ / yum install -y python3 make gcc-c++）；' +
        '也使用 Node 22.5+ 发挥内置驱动回退。',
      { cause: err }
    );
  }
}

module.exports = { open };
