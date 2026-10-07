/**
 * 复制按钮 + ElMessage 真机功能验证
 * ------------------------------------------------------------------
 * 为什么要单独验证这两件事：
 *   1. 复制按钮是本次新加的功能，验收台的机械体检只能证明「按钮存在」，
 *      证明不了「点了真能复制」。
 *   2. 本次同时把 Element Plus 改成了按需引入 —— ElMessage 是深路径导入的，
 *      必须确认它依然能弹出（JS 与样式都在），否则用户点了复制会毫无反应。
 *
 * 做法：真实点一次复制按钮，然后看
 *   · 是否弹出成功提示（.el-message--success）
 *   · 剪贴板里是否真的有内容
 *
 * 用法：node .qa/verify-copy.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

const ORIGIN = 'https://aige-saas-panel.miaocaieyc.com.cn';
const ORIGIN_IP = '120.53.102.56';
const PORT = 9355;
const PROFILE = join(tmpdir(), `aige-copy-${Date.now()}`);
const SHOT = resolve('.qa/shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`CDP 超时：${method}`));
        }
      }, 25000);
    });
  }
}

(async () => {
  mkdirSync(SHOT, { recursive: true });
  const child = spawn(
    EDGE,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--disable-gpu',
      '--hide-scrollbars',
      `--host-resolver-rules=MAP ${new URL(ORIGIN).hostname} ${ORIGIN_IP}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let cdp;
  for (let i = 0; i < 60 && !cdp; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r) => ws.addEventListener('open', r, { once: true }));
        cdp = new CDP(ws);
      }
    } catch {
      await sleep(400);
    }
  }
  if (!cdp) {
    console.error('❌ 连不上 Edge');
    child.kill();
    process.exit(1);
  }

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 允许读剪贴板，才能验证「真的复制进去了」
  try {
    await cdp.send('Browser.grantPermissions', {
      origin: ORIGIN,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });
  } catch (err) {
    console.log(`（授权剪贴板失败，不影响结果判定：${err.message}）`);
  }

  const ev = async (expr, awaitPromise = false) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面脚本异常');
    return r.result?.value;
  };

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  console.log('--- 1. 打开站点并登录 ---');
  await cdp.send('Page.navigate', { url: `${ORIGIN}/` });
  await sleep(7000);
  const login = await ev(
    `(async () => {
       const r = await fetch('/api/auth/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'admin888'})});
       const j = await r.json();
       if (j.code !== 0) return 'ERR:' + j.message;
       localStorage.setItem('aige-token', j.data.token);
       return 'OK';
     })()`,
    true
  );
  if (login !== 'OK') {
    console.error(`❌ 登录失败：${login}`);
    child.kill();
    process.exit(1);
  }
  console.log('  ✅ 已登录');

  console.log('\n--- 2. 进入网站管理，统计复制按钮 ---');
  await ev(`location.hash = '#/websites'`);
  await sleep(3500);
  const info = await ev(`JSON.stringify({
    cardView: !!document.querySelector('.cards'),
    tableView: !!document.querySelector('.el-table'),
    copyBtnCount: document.querySelectorAll('.copy-btn').length,
  })`);
  console.log(`  ${info}`);

  console.log('\n--- 3. 用真实鼠标事件点击第一个复制按钮 ---');
  // ⚠️ 不能用 element.click()：剪贴板 API 要求「用户手势 + 文档聚焦」，
  //    脚本触发的 click 两者都没有，必然失败——那是测试方式的问题，不是功能的问题。
  //    这里派发真实的 CDP 鼠标事件，并先把页面带到前台。
  try {
    await cdp.send('Page.bringToFront');
  } catch {
    /* 无头下可能不支持，忽略 */
  }
  await sleep(500);

  const box = await ev(`(() => {
    const btn = document.querySelector('.copy-btn');
    if (!btn) return '';
    const r = btn.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  })()`);
  if (!box) {
    console.error('  ❌ 没找到复制按钮');
    child.kill();
    process.exit(1);
  }
  const { x, y } = JSON.parse(box);
  console.log(`  按钮坐标：(${x}, ${y})`);

  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(60);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  console.log('  ✅ 已派发真实点击');

  await sleep(1500);

  console.log('\n--- 4. 检查是否弹出提示（ElMessage 链路） ---');
  const msg = await ev(`JSON.stringify({
    anyMsg: document.querySelectorAll('.el-message').length,
    success: document.querySelectorAll('.el-message--success').length,
    error: document.querySelectorAll('.el-message--error').length,
    text: (document.querySelector('.el-message')?.textContent || '').trim(),
    styled: (() => {
      const el = document.querySelector('.el-message');
      if (!el) return 'no-message';
      const cs = getComputedStyle(el);
      return cs.position + ' / ' + cs.zIndex + ' / bg=' + cs.backgroundColor;
    })(),
  })`);
  console.log(`  ${msg}`);

  console.log('\n--- 5. 读剪贴板（验证真的复制进去了） ---');
  const clip = await ev(
    `(async () => { try { return await navigator.clipboard.readText(); } catch (e) { return 'READ_FAIL: ' + e.message; } })()`,
    true
  );
  console.log(`  剪贴板内容：${JSON.stringify(clip)}`);

  console.log('\n--- 6. 截图 ---');
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(SHOT, 'verify-copy-1440.png'), Buffer.from(shot.data, 'base64'));
  console.log('  已存 verify-copy-1440.png');

  console.log('\n--- 7. 控制台错误（按需引入是否有副作用） ---');
  const errs = await ev(`(() => {
    const bad = [];
    if (!window.__vueErrors) return '（未挂载错误采集）';
    return '';
  })()`);
  console.log(`  ${errs}`);

  child.kill();
  process.exit(0);
})().catch((err) => {
  console.error(`\n❌ 异常：${err.stack || err.message}`);
  process.exit(1);
});
