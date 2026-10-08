/**
 * 告警中心与通知外发
 * ------------------------------------------------------------------
 * 解决的问题：巡检、部署、登录失败这些结论以前只躺在页面里 ——
 *            没人打开页面就等于没有告警。这里把「事件 → 去重 → 落库 → 外发」串起来。
 *
 * 三条设计原则（决定告警会不会把人淹掉，改代码前先读）：
 *   1. **按 fingerprint 去重**：同一个问题未解决时不新建行，只累加次数。
 *      巡检每 60 分钟跑一次，不去重的话一天能刷出上百条同样的告警。
 *   2. **外发有静默窗口**：同一 fingerprint 30 分钟内只推一次。
 *      webhook / 飞书被刷屏比没有告警更糟 —— 会被直接静音。
 *   3. **外发失败不影响主流程**：推送是尽力而为，任何网络错误只记日志。
 *
 * 通道：
 *   · 站内（必开）—— 落 SQLite，顶栏铃铛 + 抽屉列表，未读红点
 *   · Webhook（可选）—— POST 一段 JSON 到任意地址，方便接自己的系统
 *   · 飞书机器人（可选）—— 走飞书自定义机器人协议
 *   · 企业微信群机器人（可选）—— 走企业微信「群机器人」协议
 *
 * ⚠️ 飞书与企业微信**格式不一样，不能混用同一个地址**（这是最容易踩的坑）：
 *   飞书：{"msg_type":"text","content":{"text":"..."}}   成功返回 {"code":0}
 *   企微：{"msgtype":"markdown","markdown":{"content":"..."}}  成功返回 {"errcode":0}
 *   字段名大小写、外层结构、成功判定全都不同，所以拆成两个独立通道。
 *   两个都填 = 两边都推（对应 getChannels/dispatch 里的并行 tasks）。
 */
'use strict';

const db = require('../db');
const settings = require('./settings');
const { request } = require('../utils/http');
// 签名算法在零依赖的 utils/sign.js 里单独实现，便于独立交叉验证
const { feishuSign } = require('../utils/sign');

/** 同一告警的外发静默窗口 */
const QUIET_WINDOW_MS = 30 * 60 * 1000;

/** 设置表里的键名 */
const KEY_WEBHOOK = 'alert_webhook_url';
const KEY_FEISHU = 'alert_feishu_webhook';
const KEY_FEISHU_SECRET = 'alert_feishu_secret';
const KEY_WECOM = 'alert_wecom_webhook';

const LEVEL_ORDER = { critical: 0, warning: 1, info: 2 };

// ============================================================
// 落库（去重）
// ============================================================

const stmtFindOpen = db.prepare("SELECT * FROM alerts WHERE fingerprint = ? AND status = 'open'");
const stmtInsert = db.prepare(`
  INSERT INTO alerts (fingerprint, level, source, title, detail, occurrences)
  VALUES (?, ?, ?, ?, ?, 1)
`);
const stmtTouch = db.prepare(`
  UPDATE alerts
     SET occurrences = occurrences + 1,
         level = ?,
         title = ?,
         detail = ?,
         -- 关键：问题重新出现时必须把已读清掉，否则"看过一次"之后
         -- 后续再发生就不再亮红点，等于把告警静音了（这是实测踩到的坑）
         read_at = NULL,
         updated_at = datetime('now', 'localtime')
   WHERE id = ?
`);
const stmtMarkNotified = db.prepare(
  "UPDATE alerts SET notified_at = datetime('now','localtime') WHERE id = ?"
);
const stmtResolveByFp = db.prepare(`
  UPDATE alerts
     SET status = 'resolved', resolved_at = datetime('now','localtime'),
         updated_at = datetime('now','localtime')
   WHERE fingerprint = ? AND status = 'open'
`);
const stmtResolveById = db.prepare(`
  UPDATE alerts
     SET status = 'resolved', resolved_at = datetime('now','localtime'),
         updated_at = datetime('now','localtime')
   WHERE id = ? AND status = 'open'
`);

/**
 * 产生（或更新）一条告警
 * @param {object} a
 * @param {string} a.fingerprint 同一问题的唯一身份，如 health:ssl_expiring
 * @param {'critical'|'warning'|'info'} [a.level]
 * @param {string} [a.source] health / deploy / auth / system
 * @param {string} a.title 一句话说清问题
 * @param {string} [a.detail] 补充说明（可读文本或 JSON 串）
 * @returns {Promise<{id:number, created:boolean, notified:boolean}>}
 */
async function raise({ fingerprint, level = 'warning', source = 'system', title, detail = '' }) {
  if (!fingerprint || !title) throw new Error('raise() 需要 fingerprint 与 title');

  const open = stmtFindOpen.get(fingerprint);
  let id;
  let created = false;

  if (open) {
    stmtTouch.run(level, title, detail, open.id);
    id = open.id;
  } else {
    const info = stmtInsert.run(fingerprint, level, source, title, detail);
    id = Number(info.lastInsertRowid);
    created = true;
  }

  // 外发：新建的立刻推；已存在的看静默窗口
  const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
  const lastNotified = row?.notified_at
    ? new Date(String(row.notified_at).replace(' ', 'T')).getTime()
    : 0;
  const quiet = lastNotified && Date.now() - lastNotified < QUIET_WINDOW_MS;
  let notified = false;

  if (!quiet) {
    notified = await dispatch({ level, source, title, detail, fingerprint });
    if (notified) stmtMarkNotified.run(id);
  }

  return { id, created, notified };
}

/** 问题已消失：把该 fingerprint 的未解决告警置为已解决 */
function resolve(fingerprint) {
  if (!fingerprint) return 0;
  return stmtResolveByFp.run(fingerprint).changes || 0;
}

/**
 * 不阻塞调用方地产生告警
 * 用于巡检这类主流程：推送 webhook 最长要等 10 秒超时，
 * 若在这里 await，接口就会被外发通道的网速拖住（这是典型的「监控拖垮主流程」）。
 */
function raiseDetached(payload) {
  raise(payload).catch((err) => console.warn('[notify] 告警写入失败：', err.message));
}

/** 手动解决某条告警 */
function resolveById(id) {
  return stmtResolveById.run(Number(id)).changes || 0;
}

// ============================================================
// 查询
// ============================================================

/** 列表（默认只看未解决，按严重度 + 时间排） */
function list({ status = 'open', level = '', limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (level) {
    where.push('level = ?');
    params.push(level);
  }

  const rows = db
    .prepare(
      `SELECT id, fingerprint, level, source, title, detail, status, occurrences,
              notified_at, read_at, created_at, updated_at, resolved_at
         FROM alerts
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY updated_at DESC
        LIMIT ?`
    )
    .all(...params, Math.min(Math.max(Number(limit) || 100, 1), 500));

  rows.sort((a, b) => {
    const la = LEVEL_ORDER[a.level] ?? 9;
    const lb = LEVEL_ORDER[b.level] ?? 9;
    if (la !== lb) return la - lb;
    return String(b.updated_at).localeCompare(String(a.updated_at));
  });

  return rows.map((r) => ({ ...r, unread: !r.read_at }));
}

/** 汇总（顶栏红点用） */
function summary() {
  const open = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN level = 'critical' THEN 1 ELSE 0 END) AS critical,
         SUM(CASE WHEN level = 'warning'  THEN 1 ELSE 0 END) AS warning,
         SUM(CASE WHEN level = 'info'     THEN 1 ELSE 0 END) AS info,
         SUM(CASE WHEN read_at IS NULL    THEN 1 ELSE 0 END) AS unread
       FROM alerts WHERE status = 'open'`
    )
    .get();

  const latest = db.prepare("SELECT MAX(updated_at) AS t FROM alerts WHERE status = 'open'").get();

  return {
    total: open.total || 0,
    critical: open.critical || 0,
    warning: open.warning || 0,
    info: open.info || 0,
    unread: open.unread || 0,
    level:
      (open.critical || 0) > 0
        ? 'critical'
        : (open.warning || 0) > 0
          ? 'warning'
          : open.total
            ? 'info'
            : 'ok',
    latestAt: latest?.t || null,
  };
}

/** 全部标记已读 */
function markAllRead() {
  return (
    db
      .prepare(
        "UPDATE alerts SET read_at = datetime('now','localtime') WHERE status = 'open' AND read_at IS NULL"
      )
      .run().changes || 0
  );
}

/** 清理：已解决的只留最近 200 条（避免表无限增长） */
function prune() {
  return (
    db
      .prepare(
        `DELETE FROM alerts
        WHERE status = 'resolved'
          AND id NOT IN (SELECT id FROM alerts WHERE status = 'resolved' ORDER BY id DESC LIMIT 200)`
      )
      .run().changes || 0
  );
}

// ============================================================
// 外发通道
// ============================================================

/** 读取通知配置（webhook / 飞书 / 企微 是否已填） */
function getChannels() {
  const webhook = settings.get(KEY_WEBHOOK) || '';
  const feishu = settings.get(KEY_FEISHU) || '';
  const feishuSecret = settings.get(KEY_FEISHU_SECRET) || '';
  const wecom = settings.get(KEY_WECOM) || '';
  return {
    webhook: { enabled: !!webhook, urlHint: webhook ? maskUrl(webhook) : '' },
    feishu: {
      enabled: !!feishu,
      urlHint: feishu ? maskUrl(feishu) : '',
      // 填了签名密钥才算开启签名校验（飞书机器人自己也有这个开关，两边要一致）
      signed: !!feishuSecret,
    },
    wecom: { enabled: !!wecom, urlHint: wecom ? maskUrl(wecom) : '' },
    // 只要有任意一个通道启用，外部通知就算「已开启」
    anyEnabled: !!(webhook || feishu || wecom),
    quietWindowMinutes: QUIET_WINDOW_MS / 60000,
  };
}

/** 只留域名与尾部几位，界面上不显示完整地址里的密钥部分 */
function maskUrl(url) {
  try {
    const u = new URL(url);
    const tail = u.pathname.replace(/\/+$/, '').slice(-4);
    return `${u.origin}/…${tail}`;
  } catch {
    return '（地址格式异常）';
  }
}

const LEVEL_TEXT = { critical: '🔴 紧急', warning: '🟠 警告', info: '🔵 提示' };

/** 飞书自定义机器人的文本消息体 */
function feishuBody({ level, source, title, detail }) {
  const lines = [`${LEVEL_TEXT[level] || '提示'}｜艾哥 SaaS 工作台`, '', `【${source}】${title}`];
  if (detail) lines.push('', String(detail).slice(0, 800));
  lines.push('', `时间：${new Date().toLocaleString('zh-CN')}`);
  return { msg_type: 'text', content: { text: lines.join('\n') } };
}

/**
 * 企业微信群机器人的 markdown 消息体
 * ------------------------------------------------------------------
 * 用的是 markdown 而不是 text：企微的 text 消息全是一个色，看不出严重度；
 * markdown 支持 `font color`，紧急/警告能标成橙色，一眼分得出来。
 *
 * 注意企微 markdown 的能力边界（别写它不支持的东西，会原样显示成乱码）：
 *   · 支持：`#` 标题、`**加粗**`、`>` 引用、`[]()` 链接、`<font color="info|comment|warning">`
 *   · **不支持**：表格、代码块高亮、图片混排
 *   · 单条 content 上限 4096 字节，超了整条会被拒（所以 detail 必须截断）
 */
const WECOM_COLOR = { critical: 'warning', warning: 'warning', info: 'info' };

function wecomBody({ level, source, title, detail }) {
  const color = WECOM_COLOR[level] || 'comment';
  const lines = [
    `<font color="${color}">${LEVEL_TEXT[level] || '提示'}</font>｜艾哥 SaaS 工作台`,
    '',
    `> **来源**：${source}`,
    `> **事件**：${title}`,
  ];
  if (detail) lines.push('', String(detail).slice(0, 800));
  lines.push('', `<font color="comment">${new Date().toLocaleString('zh-CN')}</font>`);

  const content = lines.join('\n');
  // 兜底再按字节截一次：中文 3 字节/字，800 字符的 detail 加上模板仍在限内，
  // 但 detail 里若混了大量 emoji/组合字符，字符数会低估字节数，所以再卡一道
  return {
    msgtype: 'markdown',
    markdown: { content: Buffer.byteLength(content) > 4000 ? content.slice(0, 1200) : content },
  };
}

/** 通用 webhook 的 JSON 体 */
function webhookBody(payload) {
  return {
    event: 'alert',
    level: payload.level,
    source: payload.source,
    title: payload.title,
    detail: payload.detail,
    fingerprint: payload.fingerprint,
    at: new Date().toISOString(),
  };
}

/**
 * 把一条告警发到所有已启用的通道
 * 返回是否至少有一个通道成功
 *
 * 三个通道**并行发**而不是串行：串行的话「webhook 超时 10s + 飞书超时 10s + 企微 10s」
 * 最坏要等 30 秒，而 raise() 是会被巡检主流程等待的。
 * 并行之后最坏仍是各自的超时时间，不会叠加。
 */
async function dispatch(payload) {
  const webhook = settings.get(KEY_WEBHOOK) || '';
  const feishu = settings.get(KEY_FEISHU) || '';
  const feishuSecret = settings.get(KEY_FEISHU_SECRET) || '';
  const wecom = settings.get(KEY_WECOM) || '';
  if (!webhook && !feishu && !wecom) return false;

  const tasks = [];

  if (webhook) {
    tasks.push(
      request(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: webhookBody(payload),
        timeout: 10000,
        serviceName: '告警 Webhook',
      })
        .then(() => ({ channel: 'webhook', ok: true }))
        .catch((err) => ({ channel: 'webhook', ok: false, message: err.message }))
    );
  }

  if (feishu) {
    // 填了签名密钥就带上 timestamp + sign；没填就裸发（机器人那边关着签名校验时才对）
    let body = feishuBody(payload);
    if (feishuSecret) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      body = { timestamp, sign: feishuSign(timestamp, feishuSecret), ...body };
    }

    tasks.push(
      request(feishu, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        timeout: 10000,
        serviceName: '飞书机器人',
      })
        .then((res) => {
          // 飞书成功返回 {code:0}；开了签名校验时会返回非 0
          const code = res && typeof res === 'object' ? res.code : undefined;
          if (code !== undefined && code !== 0) {
            return { channel: 'feishu', ok: false, message: feishuErrorHint(code, feishuSecret) };
          }
          return { channel: 'feishu', ok: true };
        })
        .catch((err) => ({ channel: 'feishu', ok: false, message: err.message }))
    );
  }

  if (wecom) {
    tasks.push(
      request(wecom, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: wecomBody(payload),
        timeout: 10000,
        serviceName: '企业微信机器人',
      })
        .then((res) => {
          // 企微成功返回 {errcode:0, errmsg:'ok'}；HTTP 一直是 200，必须在响应体里判
          const code = res && typeof res === 'object' ? res.errcode : undefined;
          if (code !== undefined && code !== 0) {
            return { channel: 'wecom', ok: false, message: wecomErrorHint(code, res.errmsg) };
          }
          return { channel: 'wecom', ok: true };
        })
        .catch((err) => ({ channel: 'wecom', ok: false, message: err.message }))
    );
  }

  const results = await Promise.all(tasks);
  for (const r of results) {
    if (!r.ok) console.warn(`[notify] ${r.channel} 推送失败：${r.message}`);
  }
  return results.some((r) => r.ok);
}

/**
 * 飞书机器人常见错误码 → 人话
 * ------------------------------------------------------------------
 * 只列**有把握**的那一个（19021），其余给通用排查方向。
 * 飞书没有公开完整的机器人错误码表，硬凑一条错误的"解释"比不给解释更误导 ——
 * 用户会照着一个假的结论去改配置。
 */
function feishuErrorHint(code, signed) {
  if (code === 19021) {
    return signed
      ? '飞书 errcode=19021：签名校验失败（签名密钥填错了，或服务器时间与飞书相差超过 1 小时）'
      : '飞书 errcode=19021：机器人开启了「签名校验」，但这里没填签名密钥 —— 要么把密钥填上，要么回机器人设置里关掉签名校验';
  }
  return `飞书 errcode=${code}（常见原因：webhook 地址复制不完整、机器人已被移出群、或签名校验配置两边不一致）`;
}

/**
 * 企业微信常见错误码 → 人话
 * 企微的 errcode 只看数字根本猜不到问题，而设置页又不能显示完整地址，
 * 所以把最容易撞的几个直接翻译好，省掉「去翻文档」这一步。
 */
function wecomErrorHint(code, msg) {
  const hints = {
    93000: 'Webhook 地址无效 —— 群机器人的 key 复制少了或已重置，请回群里重新复制',
    40001: 'Webhook 地址无效或机器人已被移出群',
    45009: '接口调用超过限制（企微限 20 条/分钟），稍后会自动恢复',
    40058: '机器人被停用或群已解散',
  };
  const hint = hints[code];
  return hint
    ? `企业微信 errcode=${code}：${hint}`
    : `企业微信 errcode=${code}（${msg || '未知错误'}）`;
}

/** 发一条测试告警（设置页的「发送测试」用） */
async function sendTest() {
  const channels = getChannels();
  if (!channels.anyEnabled) {
    return {
      ok: false,
      message: '还没有配置任何外部通道（Webhook / 飞书 / 企业微信），只写入了站内告警',
    };
  }
  const ok = await dispatch({
    level: 'info',
    source: 'system',
    title: '这是一条测试告警（收到即代表通道可用）',
    detail: '来自「系统设置 → 告警通知」的手动测试，可以忽略。',
    fingerprint: 'system:test',
  });
  return {
    ok,
    message: ok
      ? '测试告警已发出，请检查接收端（若同时配了多个通道，都发成功了才算成功）'
      : '发送失败，请检查地址是否正确（常见原因：把飞书地址填到了企业微信栏，或反过来）',
  };
}

module.exports = {
  raise,
  raiseDetached,
  resolve,
  resolveById,
  list,
  summary,
  markAllRead,
  prune,
  getChannels,
  sendTest,
  // 导出给自检脚本做交叉比对（见 backend/scripts/selfcheck-feishu-sign.js）
  feishuSign,
  KEY_WEBHOOK,
  KEY_FEISHU,
  KEY_FEISHU_SECRET,
  KEY_WECOM,
};
