/**
 * 一次性「上传票据」—— 让 AI 客户端能**全自动**上传本机安装包
 * ==================================================================
 * 【为什么需要它】
 *   MCP 是给 **AI 客户端**用的，但「本机磁盘上的安装包」必须由**本机终端**把字节送出去
 *   （MCP 协议本身是 JSON-RPC 文本，没有二进制通道）。于是 `get_upload_help` 会返回
 *   一条 curl 命令让本机执行；而 curl 需要鉴权 ——
 *   之前的做法是命令里写 `<你的全权 MCP 令牌>` **占位符**，结果：
 *     客户端拿不到真令牌（它只在主人的 MCP 配置里）→ AI 无法执行 → 必须人工贴令牌。
 *
 *   ⇢ 换发**一次性票据**后就通了：命令里直接带上票据，AI 复制执行即可，全程不问人要令牌。
 *
 * 【安全边界：票据 ≠ 令牌】
 *   ① **短命**：默认 5 分钟过期；
 *   ② **单用途**：只能打 `/upload` 这一个端点（不是 MCP 的鉴权路径，调不了任何工具）；
 *   ③ **绑文件名**：只能传签发时指定的那一个文件，换个名字就拒；
 *   ④ **一次性**：用过即废（重放直接报错，不复用）；
 *   ⑤ **不可逆**：票据 = HMAC 签名，反推不出主人令牌；
 *   ⑥ **只由全权令牌签发**：只读令牌调 `get_upload_help` 拿不到票据。
 *
 *   ⇒ 票据泄漏的最大后果是「有人替你多发一个同名安装包」（还只在那 5 分钟内），
 *     而**不是**「拿到主人令牌、为所欲为」。
 */
const crypto = require('node:crypto');

/**
 * 票据有效期（分钟）。默认 **15 分钟**，可用环境变量 `UPLOAD_TICKET_TTL_MINUTES` 调整。
 *
 * 为什么给到 15 分钟（而不是更短的 5 分钟）：这个工作台是**自己用**的、令牌不外发，
 * 而典型流程是「拿到命令 → 复制 → 本机终端跑」，大包在慢上行下要传几分钟，
 * 也常出现「拿到命令后先干了点别的、回头再跑」。15 分钟能覆盖这些正常情况。
 *
 * ⚠️ 放宽时限**不削弱**这层保护：票据仍是一次性 + 绑定文件名 + 只能打 /upload +
 *    只由全权令牌签发 —— 最坏情况依然只是「那一个文件、那一次被重放」，
 *    而不是「拿到长期凭据」。所以「够用」比「够短」更重要。
 */
const TTL_MINUTES = Math.max(
  1,
  Math.min(24 * 60, Number(process.env.UPLOAD_TICKET_TTL_MINUTES) || 15)
);
const TICKET_TTL_MS = TTL_MINUTES * 60 * 1000;
/** 已用票据（nonce → 过期时间），用后即废。内存即可：单实例；超 500 条时清掉已过期的 */
const used = new Map();

function secret() {
  // 从主令牌派生（HMAC 不可逆，票据里不含令牌本身）；换令牌即旧票据失效，符合预期
  const base = String(process.env.MCP_AUTH_TOKEN || 'aige-workbench-upload-fallback');
  return crypto.createHash('sha256').update(`upload-ticket-v1:${base}`).digest();
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** 签发一张票据（绑定 fileName） */
function issue(fileName) {
  const payload = {
    f: String(fileName || '').trim(),
    e: Date.now() + TICKET_TTL_MS,
    n: crypto.randomBytes(8).toString('hex'),
  };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', secret()).update(body).digest());
  return {
    ticket: `${body}.${sig}`,
    expiresAt: new Date(payload.e).toISOString(),
    ttlSeconds: Math.round(TICKET_TTL_MS / 1000),
  };
}

/**
 * 校验票据。不通过就抛**能直接告诉调用方怎么办**的错误。
 * @param {string} ticket
 * @param {string} fileName 本次实际要传的文件名（必须与签发时一致）
 * @returns {{f:string,e:number,n:string}} payload（消费时要用 n）
 */
function verify(ticket, fileName) {
  const parts = String(ticket || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw badTicket('上传票据格式不对：请重新调用 get_upload_help 拿一条新命令。');
  }
  const [body, sig] = parts;
  const expect = b64url(crypto.createHmac('sha256', secret()).update(body).digest());

  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw badTicket('上传票据签名无效：请重新调用 get_upload_help 拿一条新命令。');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw badTicket('上传票据无法解析：请重新调用 get_upload_help 拿一条新命令。');
  }

  if (!payload || typeof payload.e !== 'number') {
    throw badTicket('上传票据缺少必要字段：请重新调用 get_upload_help 拿一条新命令。');
  }
  if (Date.now() > payload.e) {
    throw badTicket(
      `上传票据已过期（有效期 ${TICKET_TTL_MS / 1000} 秒）。请重新调用 get_upload_help 拿一条新命令 —— 票据是短期一次性的，这是设计如此。`
    );
  }
  if (used.has(payload.n)) {
    throw badTicket(
      '这张上传票据已经用过了（一次性，用后即废）。请重新调用 get_upload_help 拿一条新命令。'
    );
  }

  const want = String(fileName || '').trim();
  if (String(payload.f) !== want) {
    throw badTicket(
      `这张票据绑定的是文件名「${payload.f}」，本次要传的是「${want}」—— 对不上。请用**同一个文件名**，或重新调用 get_upload_help。`
    );
  }

  return payload;
}

/** 标记票据已使用（用后即废）。上传**成功后**才调用，失败可重试 */
function consume(payload) {
  if (!payload || !payload.n) return;
  used.set(payload.n, payload.e);
  // 顺手清掉已过期的记录，别让 Map 无限长
  if (used.size > 500) {
    const now = Date.now();
    for (const [k, e] of used) if (e < now) used.delete(k);
  }
}

function badTicket(message) {
  const err = new Error(message);
  err.status = 401;
  err.code = 'BAD_UPLOAD_TICKET';
  return err;
}

module.exports = { issue, verify, consume, TICKET_TTL_MS };
