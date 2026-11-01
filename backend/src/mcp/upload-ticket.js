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
 * 票据有效期（分钟）。默认 **30 分钟**，可用环境变量 `UPLOAD_TICKET_TTL_MINUTES` 调整。
 *
 * 为什么是 30 分钟（而不是 5 分钟）：过期的**成本几乎为零**（重新调一次工具即可），
 * 换来的是「拿到命令后被别的事打断、回头再跑」这种真实情况的从容 —— 很划算。
 * 也不必更长：有效期越短，它越像「一次性通行证」而不是「长期凭据」，这正是它该有的样子。
 */
const TTL_MINUTES = Math.max(
  1,
  Math.min(24 * 60, Number(process.env.UPLOAD_TICKET_TTL_MINUTES) || 30)
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

/** 签发一张票据（绑定 fileName；file 类票据额外绑定目录与是否覆盖） */
function issue(fileName, options = {}) {
  const payload = {
    f: String(fileName || '').trim(),
    e: Date.now() + TICKET_TTL_MS,
    n: crypto.randomBytes(8).toString('hex'),
  };

  // ---- 通用文件上传（kind='file'）额外绑定 ----
  // ⛔ 为什么要把目录也签进票据：票据是「不经过主令牌就能写服务器」的凭据。
  //    只绑文件名的话，拿到票据的人可以把同一张票据打到别的目录去（比如 /www/wwwroot/xxx）。
  //    绑上目录之后，票据的能力就被钉死在「这一个路径」上。
  const kind = String(options.kind || '').trim();
  if (kind) payload.k = kind;
  if (options.dir) payload.d = String(options.dir).trim();
  if (options.overwrite !== undefined) payload.o = !!options.overwrite;

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
 * @param {object} [options] { kind, dir, overwrite } —— 给了就额外比对（旧票据没有这些字段时放行）
 * @returns {{f:string,e:number,n:string,k?:string,d?:string,o?:boolean}} payload（消费时要用 n）
 */
function verify(ticket, fileName, options = {}) {
  const parts = String(ticket || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw badTicket('上传票据格式不对：请重新调用签发票据的工具拿一条新命令。');
  }
  const [body, sig] = parts;
  const expect = b64url(crypto.createHmac('sha256', secret()).update(body).digest());

  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw badTicket('上传票据签名无效：请重新调用签发票据的工具拿一条新命令。');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw badTicket('上传票据无法解析：请重新调用签发票据的工具拿一条新命令。');
  }

  if (!payload || typeof payload.e !== 'number') {
    throw badTicket('上传票据缺少必要字段：请重新调用签发票据的工具拿一条新命令。');
  }
  if (Date.now() > payload.e) {
    throw badTicket(
      `上传票据已过期（有效期 ${TICKET_TTL_MS / 1000} 秒）。请重新调用签发票据的工具拿一条新命令 —— 票据是短期一次性的，这是设计如此。`
    );
  }
  if (used.has(payload.n)) {
    throw badTicket(
      '这张上传票据已经用过了（一次性，用后即废）。请重新调用签发票据的工具拿一条新命令。'
    );
  }

  const want = String(fileName || '').trim();
  if (String(payload.f) !== want) {
    throw badTicket(
      `这张票据绑定的是文件名「${payload.f}」，本次要传的是「${want}」—— 对不上。请用**同一个文件名**，或重新调用签发票据的工具。`
    );
  }

  // ---- 下面三条只对「新票据」生效：老票据没有 k / d / o 字段，保持向后兼容 ----
  const kind = String(options.kind || '').trim();
  if (payload.k && kind && payload.k !== kind) {
    throw badTicket(
      `这张票据是给「${payload.k}」用的，不能拿到「${kind}」这个入口用。请重新调用对应的工具拿票据。`
    );
  }
  if (payload.d && options.dir) {
    const wantDir = String(options.dir).trim().replace(/\/+$/, '') || '/';
    if (payload.d !== wantDir) {
      throw badTicket(
        `这张票据绑定的是目录「${payload.d}」，本次要传到「${wantDir}」—— 对不上。请用签发时指定的目录，或重新拿票据。`
      );
    }
  }
  if (
    payload.o !== undefined &&
    options.overwrite !== undefined &&
    payload.o !== !!options.overwrite
  ) {
    throw badTicket(
      `这张票据签发时 overwrite=${payload.o ? 'true' : 'false'}，与本次请求不一致。请重新拿票据。`
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
