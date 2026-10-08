/**
 * 计划任务路由（C3 · 只读）
 * ------------------------------------------------------------------
 * GET /api/crontab   服务器上的全部计划任务（宝塔口径）
 *
 * ⛔ 三条边界，写在这里是因为**以后最容易在这里越界**：
 *
 * 1. **只有读接口**。启停 / 删除 / 新增一律不做 —— 实测这台机器上的 36 个任务
 *    **全部属于其他项目**（tito-* / NovaAI / twccai-* / bulut-* 等），
 *    动任何一个都是动别人的东西，违反本项目的最高优先级铁律。
 *
 * 2. **不返回脚本正文**。宝塔的返回里带 `sBody`，而其他项目的脚本正文里有**明文密钥**
 *    （实测：某项目部署脚本里同时有数据库口令、微信商户 API v3 密钥、GitHub client secret）。
 *    脱敏是在 services/baota.js 的**字段白名单**里做的 —— 那里只挑要用的字段，
 *    以后宝塔新增字段也不会顺势漏出去。不要在这里加「顺便把 body 也带上」。
 *
 * 3. 归属判定与说明（owner / scopeNote）由 service 给出，前端与 MCP 都照它展示。
 *
 * 权限：/crontab 在 middleware/permissions.js 的 MODULE_RULES 里声明为 viewer 可读。
 */
'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const baotaService = require('../services/baota');

const router = express.Router();

/** 计划任务列表（只读） */
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const data = await baotaService.createClient().listCrontabs();
    return success(res, data);
  })
);

module.exports = router;
