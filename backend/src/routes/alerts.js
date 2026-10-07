/**
 * 告警中心路由
 * ------------------------------------------------------------------
 * GET  /api/alerts            告警列表（默认未解决）+ 汇总 + 通道状态
 * GET  /api/alerts/summary    只要汇总（顶栏红点轮询用，很轻）
 * POST /api/alerts/read       全部标记已读
 * POST /api/alerts/test       发一条测试告警，验证通道是否通
 * POST /api/alerts/:id/resolve 手动解决某条
 *
 * 说明：告警的产生由业务侧调用 services/notify.raise()，不通过本路由写入 ——
 *      这样「谁能产生告警」在代码里是明确的，外部无法伪造告警。
 */
'use strict';

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const { badRequest } = require('../utils/errors');
const { writeLog } = require('../utils/logger');
const notifyService = require('../services/notify');

const router = express.Router();

/** 汇总（顶栏轮询，放最前避免被 /:id 匹配） */
router.get(
  '/summary',
  asyncHandler(async (_req, res) => {
    return success(res, notifyService.summary());
  })
);

/** 测试通道 */
router.post(
  '/test',
  asyncHandler(async (req, res) => {
    const result = await notifyService.sendTest();
    return success(res, result, result.message);
  })
);

/** 全部已读 */
router.post(
  '/read',
  asyncHandler(async (req, res) => {
    const changed = notifyService.markAllRead();
    return success(res, { changed }, changed ? `已标记 ${changed} 条为已读` : '没有未读告警');
  })
);

/** 列表 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const status =
      req.query.status === 'resolved' ? 'resolved' : req.query.status === 'all' ? '' : 'open';
    const items = notifyService.list({
      status,
      level: String(req.query.level || ''),
      limit: req.query.limit,
    });
    return success(res, {
      items,
      summary: notifyService.summary(),
      channels: notifyService.getChannels(),
    });
  })
);

/** 手动解决某条告警 */
router.post(
  '/:id/resolve',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) throw badRequest('告警 id 不合法');
    const changed = notifyService.resolveById(id);
    if (!changed) throw badRequest('该告警不存在或已解决');

    writeLog({
      userId: req.user.id,
      username: req.user.username,
      module: 'alert',
      action: 'resolve_alert',
      target: String(id),
      source: 'web',
      status: 'success',
    });
    return success(res, { id }, '已标记为已解决');
  })
);

module.exports = router;
