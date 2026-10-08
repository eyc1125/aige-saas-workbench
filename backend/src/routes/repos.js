/**
 * 代码仓库路由（B4 · 只读）
 * ------------------------------------------------------------------
 * GET /api/repos                    关注的仓库概览（含配额信息）
 * GET /api/repos/config             当前配置状态（有没有令牌、关注了哪些仓库）
 * GET /api/repos/:owner/:repo       单个仓库的完整数据（提交 / Actions / Issue / PR）
 *
 * ⛔ 这个模块**只有读接口**。想加写操作（建 Issue / 重跑 CI）之前先想清楚：
 *    那会让 GitHub 令牌从「只读」变成「可写」，泄露后果完全不同。
 *
 * 权限：/repos 在 middleware/permissions.js 的 MODULE_RULES 里声明为 viewer 可读。
 */
'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const githubService = require('../services/github');

const router = express.Router();

/** 当前配置状态 —— 页面用它决定「是提示去配置」还是「直接展示数据」 */
router.get(
  '/config',
  asyncHandler(async (_req, res) => {
    return success(res, {
      authenticated: githubService.isConfigured(),
      repos: githubService.configuredRepos(),
      rateLimit: githubService.rateLimit(),
      // ⚠️ CACHE_TTL 是毫秒，这个字段名是 Seconds —— 必须换算，
      // 否则界面会显示成「数据缓存 60000 秒」
      cacheTtlSeconds: githubService.CACHE_TTL / 1000,
    });
  })
);

/** 关注的仓库概览 */
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const { items, rateLimit, authenticated } = await githubService.listRepos();
    return success(res, {
      list: items,
      total: items.length,
      authenticated,
      rateLimit,
    });
  })
);

/** 单个仓库的完整数据 */
router.get(
  '/:owner/:repo',
  asyncHandler(async (req, res) => {
    const data = await githubService.repoDetail(`${req.params.owner}/${req.params.repo}`);
    return success(res, data);
  })
);

module.exports = router;
