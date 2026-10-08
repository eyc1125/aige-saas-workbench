/**
 * 应用分发路由（B7 · 看版本 + 上传安装包）
 * ------------------------------------------------------------------
 * GET  /api/distribute/config          配置状态（有没有填蒲公英 API Key）
 * GET  /api/distribute/apps            账号下的应用与当前版本（含下载页、二维码）
 * GET  /api/distribute/apps/:appKey    单个应用的详情与历史版本
 * POST /api/distribute/upload          上传安装包到蒲公英（**请求体是文件原始字节**）
 *
 * 上传设计（为什么不是 multipart）：
 *   浏览器直接把 File 当请求体发（`Content-Type: application/octet-stream`），
 *   后端用 `express.raw()` 收成 Buffer —— 这样**不需要任何 multipart 解析依赖**，
 *   也不用把文件写进磁盘。收完立刻转交给蒲公英（它自己存在腾讯云 COS），
 *   **我们服务器只过一遍内存，不留任何副本**。
 *
 * 权限：/distribute 在 MODULE_RULES 里 read=viewer / write=operator，
 *       所以上传（POST）需要 operator 及以上。
 */
'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const { badRequest } = require('../utils/errors');
const pgyerService = require('../services/pgyer');
const { writeLog, clientIp } = require('../utils/logger');

const router = express.Router();

const MAX_MB = pgyerService.MAX_UPLOAD_BYTES / 1024 / 1024;

/** 配置状态 —— 页面用它决定「提示去配置」还是「直接展示数据」 */
router.get(
  '/config',
  asyncHandler(async (_req, res) => {
    return success(res, {
      configured: pgyerService.isConfigured(),
      cacheTtlSeconds: pgyerService.CACHE_TTL / 1000,
    });
  })
);

/** 应用与当前版本 */
router.get(
  '/apps',
  asyncHandler(async (_req, res) => {
    const data = await pgyerService.listApps();
    return success(res, data);
  })
);

/** 单个应用详情（含历史版本） */
router.get(
  '/apps/:appKey',
  asyncHandler(async (req, res) => {
    const data = await pgyerService.appDetail(req.params.appKey);
    return success(res, data);
  })
);

/**
 * 上传安装包
 * ------------------------------------------------------------------
 * 请求体 = 安装包的**原始字节**（不是 multipart），文件名走查询串。
 * 这样后端不需要任何 multipart 解析依赖，也不落盘。
 *
 * curl 示例（AI 或 CI 都可用这个，比装 CLI 轻）：
 *   curl -X POST --data-binary @app-release.apk \
 *     -H "Authorization: Bearer <工作台令牌>" \
 *     "https://<面板域名>/api/distribute/upload?fileName=app-release.apk"
 */
router.post(
  '/upload',
  // 只吃 octet-stream；limit 与 MAX_MB 一致，超了由全局错误处理换成中文提示
  express.raw({ type: 'application/octet-stream', limit: `${MAX_MB}mb` }),
  asyncHandler(async (req, res) => {
    const fileName = String(req.query.fileName || req.headers['x-file-name'] || '').trim();
    const updateDescription = String(req.query.updateDescription || '').trim();

    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
      throw badRequest(
        '没有收到文件内容。请以 application/octet-stream 直接把文件作为请求体发送（不要用 multipart）'
      );
    }

    const started = Date.now();
    const logBase = {
      userId: req.user?.id,
      username: req.user?.username,
      module: 'distribute',
      action: 'upload',
      target: fileName || '(未命名)',
      source: 'web',
      ip: clientIp(req),
    };

    try {
      const result = await pgyerService.uploadApp(buffer, fileName, { updateDescription });
      writeLog({
        ...logBase,
        detail: { size: buffer.length, buildKey: result.buildKey, pending: !!result.pending },
        status: 'success',
        message: result.pending
          ? '已上传，蒲公英仍在解析'
          : `已发布 ${result.name} v${result.version}`,
        durationMs: Date.now() - started,
      });
      return success(
        res,
        result,
        result.pending
          ? '安装包已上传，蒲公英还在解析，稍后刷新即可看到新版本'
          : `上传成功：${result.name} v${result.version}`
      );
    } catch (err) {
      // 上传失败也要留痕：谁在什么时候试图传了多大的包、为什么没成
      writeLog({
        ...logBase,
        detail: { size: buffer.length },
        status: 'failed',
        message: err.message,
        durationMs: Date.now() - started,
      });
      throw err;
    }
  })
);

module.exports = router;
