/**
 * 诊断探针：为什么截图是空白？
 * 只做一件事 —— 把页面真实状态 dump 出来（DOM 节点数、可见文字、控制台错误、尺寸）。
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
const PORT = 9344;
const PROFILE = join(tmpdir(), `aige-probe-${Date.now()}`);
const SHOT = resolve('.qa/shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) {
        this.events.push(m);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`超时 ${method}`));
        }
      }, 30000);
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
    console.error('连不上 Edge');
    child.kill();
    process.exit(1);
  }

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  const ev = async (expr, awaitPromise = false) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise,
      returnByValue: true,
    });
    if (r.exceptionDetails) return `EXC: ${r.exceptionDetails.text}`;
    return r.result?.value;
  };

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 375,
    height: 812,
    deviceScaleFactor: 1,
    mobile: true,
  });

  console.log('--- 1. 导航到站点根 ---');
  await cdp.send('Page.navigate', { url: `${ORIGIN}/` });
  await sleep(6000);

  const dump = await ev(`JSON.stringify({
    title: document.title,
    url: location.href,
    hash: location.hash,
    appExists: !!document.querySelector('#app'),
    appChildren: document.querySelector('#app')?.childElementCount ?? -1,
    appHTMLLen: document.querySelector('#app')?.innerHTML.length ?? -1,
    bodyTextLen: document.body.innerText.length,
    bodyTextHead: document.body.innerText.slice(0, 220),
    docScrollW: document.documentElement.scrollWidth,
    docClientW: document.documentElement.clientWidth,
    bodyScrollW: document.body.scrollWidth,
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    readyState: document.readyState,
  })`);
  console.log(dump);

  console.log('\n--- 2. 页面控制台错误 ---');
  for (const e of cdp.events.filter(
    (x) =>
      x.method === 'Runtime.exceptionThrown' ||
      x.method === 'Log.entryAdded' ||
      x.method === 'Runtime.consoleAPICalled'
  )) {
    if (e.method === 'Runtime.exceptionThrown')
      console.log(
        '  JS异常:',
        e.params.exceptionDetails?.text,
        e.params.exceptionDetails?.exception?.description?.slice(0, 300)
      );
    else if (e.method === 'Log.entryAdded')
      console.log(`  [${e.params.entry.level}]`, e.params.entry.text?.slice(0, 240));
    else if (e.params.type === 'error' || e.params.type === 'warning')
      console.log(
        `  console.${e.params.type}:`,
        JSON.stringify(e.params.args?.map((a) => a.value ?? a.description)?.join(' ')).slice(0, 240)
      );
  }

  console.log('\n--- 3. 截图（375 首次进入） ---');
  const s1 = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(SHOT, 'probe-375-root.png'), Buffer.from(s1.data, 'base64'));
  console.log('  已存 probe-375-root.png');

  console.log('\n--- 4. 登录后再看 ---');
  const loginRes = await ev(
    `(async () => {
       const r = await fetch('/api/auth/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'admin888'})});
       const j = await r.json();
       if (j.code !== 0) return 'ERR:'+j.message;
       localStorage.setItem('aige-token', j.data.token);
       return 'OK';
     })()`,
    true
  );
  console.log('  登录:', loginRes);

  await cdp.send('Page.navigate', { url: `${ORIGIN}/#/dashboard` });
  await sleep(5000);

  const dump2 = await ev(`JSON.stringify({
    hash: location.hash,
    appChildren: document.querySelector('#app')?.childElementCount ?? -1,
    appHTMLLen: document.querySelector('#app')?.innerHTML.length ?? -1,
    bodyTextLen: document.body.innerText.length,
    bodyTextHead: document.body.innerText.replace(/\\s+/g,' ').slice(0, 300),
    docScrollW: document.documentElement.scrollWidth,
    docClientW: document.documentElement.clientWidth,
  })`);
  console.log(dump2);

  const s2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(SHOT, 'probe-375-dashboard.png'), Buffer.from(s2.data, 'base64'));
  console.log('  已存 probe-375-dashboard.png');

  child.kill();
  process.exit(0);
})();
