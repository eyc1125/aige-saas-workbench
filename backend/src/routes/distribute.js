/**
 * 应用分发路由（B7 · 只读）
 * ------------------------------------------------------------------
 * GET /api/distribute/config          配置状态（有没有填蒲公英 API Key）
 * GET /api/distribute/apps            账号下的应用与当前版本（含下载页、二维码）
 * GET /api/distribute/apps/:appKey    单个应用的详情与历史版本
 *
 * ⛔ 这个模块**只有读接口**。上传 APK 请用蒲公英官方工具链：
 *    · 官方 MCP：`npx -y pgyer-mcp-server` + 环境变量 PGYER_API_KEY（跑在本机，能读本地文件）
 *    · 官方 CLI：`npm i -g @pgyer/cli` → `pgyer upload ./app-release.apk`
 *    为什么不在这里做：官方已经解决得更好，且大文件过这台 2GB 的服务器不划算。
 *
 * 权限：/distribute 在 middleware/permissions.js 的 MODULE_RULES 里声明为 viewer 可读。
 */
'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const pgyerService = require('../services/pgyer');

const router = express.Router();

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

module.exports = router;
