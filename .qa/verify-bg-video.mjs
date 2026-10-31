/**
 * 全屏视频背景验收（Edge 无头 + Chrome DevTools Protocol）
 * 验证：登录页 / 仪表盘 / 404 / 移动端：视频背景是否可见、是否真在播放、是否破坏 UI。
 * 用法：node .qa/verify-bg-video.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p));

const ORIGIN = 'https://aige-saas-panel.miaocaieyc.com.cn';
const IP = '120.53.102.56';
const PORT = 9377;
const PROFILE = join(tmpdir(), 'aige-bgv-' + Date.now());
const SHOTS = resolve('.qa/shots');
// 账号不写死在文件里（这是要入库的脚本）：从环境变量取，没给就跳过需要登录的步骤。
const USER = process.env.AIGE_QA_USER || 'elyac';
const PASS = process.env.AIGE_QA_PASS || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (child && child.pid) {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (e) {
      void e;
    }
  }
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -like '*aige-bgv-*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try {
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      stdio: 'ignore',
      timeout: 20000,
    });
  } catch (e) {
    void e;
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch (e) {
        void e;
        return;
      }
      if (m.id && this.pending.has(m.id)) {
        const h = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) h.rej(new Error(String(m.error.message)));
        else h.res(m.result);
      } else if (m.method) {
        this.events.push(m);
      }
    });
  }
  send(method, params) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error('CDP timeout ' + method));
        }
      }, 25000);
    });
  }
}

async function connect() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const list = await r.json();
      const pg = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (pg) {
        const ws = new WebSocket(pg.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.addEventListener('open', res, { once: true });
          ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
        });
        return new CDP(ws);
      }
    } catch (e) {
      void e;
    }
    await sleep(500);
  }
  throw new Error('cannot connect to edge');
}
const probeExpr = () => `(() => {
  const vw = document.documentElement.clientWidth;
  const o = { iw: window.innerWidth, ih: window.innerHeight, cw: vw, docScrollW: document.documentElement.scrollWidth, bodyScrollW: document.body.scrollWidth };
  o.hOverflow = document.documentElement.scrollWidth > vw + 1;
  o.videoCount = document.querySelectorAll('video').length;
  // 第 7 轮起背景是多段轮播（每段一个 <video>），探针要盯**当前显示的那一层**
  o.layers = document.querySelectorAll('.vbg__layer').length;
  o.activeLayer = [...document.querySelectorAll('.vbg__layer')].findIndex((el) => el.classList.contains('vbg__layer--on'));
  // 第 8 轮：非激活层必须 visibility:hidden，否则每帧都要多合成一块全屏贴图（卡顿主因）
  o.layerStates = [...document.querySelectorAll('.vbg__layer')].map((el) => { const s = getComputedStyle(el); return s.visibility + '/' + s.opacity + '/' + (el.querySelector('.vbg__poster') ? getComputedStyle(el.querySelector('.vbg__poster')).display : '-'); });
  o.bodyText = (document.body.textContent || '').replace(/[ ]+/g, ' ').trim().slice(0, 140);
  const v = document.querySelector('.vbg__layer--on video') || document.querySelector('video');
  if (v) {
    const cs = getComputedStyle(v);
    const r = v.getBoundingClientRect();
    o.video = { src: v.currentSrc, paused: v.paused, muted: v.muted, loop: v.loop, autoplay: v.autoplay, controls: v.controls, playsInline: v.playsInline, readyState: v.readyState, currentTime: Number(v.currentTime.toFixed(3)), duration: Number.isFinite(v.duration) ? Number(v.duration.toFixed(2)) : null, nw: v.videoWidth, nh: v.videoHeight, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], objectFit: cs.objectFit, opacity: cs.opacity, err: v.error ? v.error.code : null };
  }
  const wrap = document.querySelector('.vbg');
  if (wrap) {
    const w = getComputedStyle(wrap);
    const wr = wrap.getBoundingClientRect();
    o.vbg = { pos: w.position, z: w.zIndex, pe: w.pointerEvents, bg: w.backgroundColor, w: Math.round(wr.width), h: Math.round(wr.height) };
  }
  const sc = document.querySelector('.vbg__scrim');
  if (sc) { const s = getComputedStyle(sc); o.scrim = { opacity: s.opacity, bg: s.backgroundColor }; }
  return JSON.stringify(o);
})()`;

const overflowExpr = () => `(() => {
  const vw = document.documentElement.clientWidth;
  const label = (el) => el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(' ').slice(0, 2).join('.') : '');
  const seen = new Set();
  const ov = [];
  const sc = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) <= 0.05) continue;
    if (cs.position === 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.right > vw + 2 || r.left < -2) {
      const k = label(el) + Math.round(r.width);
      if (seen.has(k)) continue;
      seen.add(k);
      let p = el.parentElement;
      let inScroll = false;
      while (p && p !== document.documentElement) {
        const pc = getComputedStyle(p);
        if ((pc.overflowX === 'auto' || pc.overflowX === 'scroll') && p.scrollWidth > p.clientWidth + 1) { inScroll = true; break; }
        p = p.parentElement;
      }
      const item = { el: label(el), l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), text: (el.textContent || '').trim().slice(0, 28) };
      if (inScroll) sc.push(item); else ov.push(item);
    }
  }
  return JSON.stringify({ vw: vw, docScrollW: document.documentElement.scrollWidth, overs: ov, scrollers: sc });
})()`;

const loginExpr = () => `(async () => {
  try {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: '${USER}', password: '${PASS}' }) });
    const j = await r.json();
    if (j.code !== 0) return 'ERR:' + (j.message || '');
    localStorage.setItem('aige-token', j.data.token);
    return 'OK';
  } catch (e) { return 'EXC:' + e.message; }
})()`;
(async () => {
  if (!EDGE) {
    console.log('NO_EDGE');
    process.exit(1);
  }
  mkdirSync(SHOTS, { recursive: true });
  child = spawn(
    EDGE,
    [
      '--headless=new',
      '--remote-debugging-port=' + PORT,
      '--user-data-dir=' + PROFILE,
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--autoplay-policy=no-user-gesture-required',
      '--host-resolver-rules=MAP aige-saas-panel.miaocaieyc.com.cn ' + IP,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  const cdp = await connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  const ev = async (expr, ap) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: !!ap,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error('page exc: ' + String(r.exceptionDetails.text));
    return r.result.value;
  };
  const setVP = async (w, h, m) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: h,
      deviceScaleFactor: 1,
      mobile: !!m,
    });
    await cdp.send(
      'Emulation.setTouchEmulationEnabled',
      m ? { enabled: true, maxTouchPoints: 5 } : { enabled: false }
    );
  };
  let navSeq = 0;
  const nav = async (url, waitMs) => {
    navSeq += 1;
    const full = url.replace('/#', '/?v=' + navSeq + '#');
    await cdp.send('Page.navigate', { url: full });
    await sleep(waitMs);
  };
  const shots = {};
  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const b = Buffer.from(r.data, 'base64');
    writeFileSync(join(SHOTS, name), b);
    shots[name] = { bytes: b.length, md5: createHash('md5').update(b).digest('hex').slice(0, 12) };
  };
  const report = { meta: { origin: ORIGIN, ip: IP, mode: 'headless' }, steps: {} };
  const V = (p) => p.video || {};
  // 第 7 轮：背景是多段轮播（每段一个 <video>），健康检查必须盯**当前显示的那一层**
  const videoHealth = () =>
    ev(
      `(() => { const v = document.querySelector('.vbg__layer--on video') || document.querySelector('video'); if (!v) return 'no-video'; const q = (typeof v.getVideoPlaybackQuality === 'function') ? v.getVideoPlaybackQuality() : null; return JSON.stringify({ src: v.currentSrc, nw: v.videoWidth, nh: v.videoHeight, rs: v.readyState, ct: Number(v.currentTime.toFixed(2)), paused: v.paused, frames: q ? q.totalVideoFrames : -1, dropped: q ? q.droppedVideoFrames : -1, err: v.error ? (v.error.code + ':' + v.error.message) : null }); })()`
    );

  await setVP(1440, 900, false);
  await nav(ORIGIN + '/#/login', 3500);
  const cap = await ev(
    `JSON.stringify({ hvc1: document.createElement('video').canPlayType('video/mp4; codecs="hvc1"'), hev1: document.createElement('video').canPlayType('video/mp4; codecs="hev1"'), avc1: document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"'), vp9: document.createElement('video').canPlayType('video/webm; codecs="vp9"') })`
  );
  console.log('CAP ' + cap);
  report.capability = JSON.parse(cap);

  const h1 = await videoHealth();
  const a1 = JSON.parse(await ev(probeExpr()));
  await shot('01-login-desktop-3s.png');
  await sleep(5000);
  const h2 = await videoHealth();
  const a2 = JSON.parse(await ev(probeExpr()));
  await shot('02-login-desktop-8s.png');
  console.log('HEALTH t3 ' + h1);
  console.log('HEALTH t8 ' + h2);
  console.log(
    'A login ct=' +
      V(a1).currentTime +
      '->' +
      V(a2).currentTime +
      ' rect=' +
      JSON.stringify(V(a1).rect) +
      ' vp=' +
      a1.iw +
      'x' +
      a1.ih +
      ' vbg=' +
      JSON.stringify(a1.vbg) +
      ' scrim=' +
      JSON.stringify(a1.scrim) +
      ' hOv=' +
      a1.hOverflow
  );
  report.steps.loginDesktop = { t3: a1, t8: a2, healthT3: h1, healthT8: h2 };

  const login = await ev(loginExpr(), true);
  console.log('LOGIN ' + login);
  report.login = login;

  if (login === 'OK') {
    await nav(ORIGIN + '/#/dashboard', 6500);
    const b1 = JSON.parse(await ev(probeExpr()));
    await shot('03-dashboard-desktop.png');
    console.log(
      'B dash health ' +
        (await videoHealth()) +
        ' rect=' +
        JSON.stringify(V(b1).rect) +
        ' hOv=' +
        b1.hOverflow +
        ' text=' +
        b1.bodyText.slice(0, 55)
    );
    report.steps.dashboardDesktop = { probe: b1 };

    // 需求 ⑦：同一会话内切路由，背景视频不能中断/重建。
    // 给 video 节点打个标记，切完路由标记还在 + 时间轴继续走 = 组件没被重建。
    const chrome = await ev(
      `(() => { const f = (el) => { if (!el) return null; const c = getComputedStyle(el); return { bg: c.backgroundColor, blur: c.backdropFilter || c.webkitBackdropFilter || 'none' }; }; return JSON.stringify({ side: f(document.querySelector('.side')), topbar: f(document.querySelector('.topbar')) }); })()`
    );
    console.log('F chrome ' + chrome);
    report.chrome = JSON.parse(chrome);

    // 浮层玻璃（主人本轮点名「每一个页面消息框，还有其他的，都是玻璃」）：
    // ① 用户菜单 = el-dropdown 的 popper；② 退出确认 = el-message-box。
    // 打开菜单后**点取消**，不真的退出，后面步骤不受影响。
    const styleOf = (sel) =>
      `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const c = getComputedStyle(el); return { bg: c.backgroundColor, blur: c.backdropFilter || c.webkitBackdropFilter || 'none' }; })()`;
    await ev(
      `(() => { const u = document.querySelector('.user'); if (u) u.click(); return !!u; })()`
    );
    await sleep(800);
    const menuStyle = await ev(
      `JSON.stringify({ menu: (${styleOf('.el-dropdown-menu')}), popper: (${styleOf('.el-dropdown__popper')}) || (${styleOf('.el-popper.is-light')}) })`
    );
    await shot('07-user-menu-desktop.png');
    console.log('G dropdown ' + menuStyle);
    report.glassDropdown = JSON.parse(menuStyle);

    const logoutHit = await ev(
      `(() => { const items = [...document.querySelectorAll('.el-dropdown-menu__item')]; const t = items.find((el) => /退出/.test(el.textContent || '')); if (!t) return 'no-item'; t.click(); return 'ok'; })()`
    );
    await sleep(900);
    const boxStyle = JSON.parse(await ev(`JSON.stringify(${styleOf('.el-message-box')})`));
    await shot('08-message-box-desktop.png');
    console.log('H messageBox ' + logoutHit + ' ' + JSON.stringify(boxStyle));
    report.glassMessageBox = { hit: logoutHit, box: boxStyle };
    await ev(
      `(() => { const btns = [...document.querySelectorAll('.el-message-box__btns button')]; const c = btns.find((el) => /取消/.test(el.textContent || '')) || btns[0]; if (!c) return 'no-btn'; c.click(); return 'canceled'; })()`
    );
    await sleep(700);

    await ev(
      `(() => { const v = document.querySelector('.vbg__layer--on video') || document.querySelector('video'); if (v) v.dataset.keepProbe = '1'; return 'tagged'; })()`
    );
    const ctBefore = V(JSON.parse(await ev(probeExpr()))).currentTime;
    await ev(`(location.hash = '#/websites')`);
    await sleep(4500);
    const keep = await ev(
      `(() => { const v = document.querySelector('.vbg__layer--on video') || document.querySelector('video'); if (!v) return 'no-video'; return JSON.stringify({ tag: v.dataset.keepProbe || '', ct: Number(v.currentTime.toFixed(2)), paused: v.paused }); })()`
    );
    console.log('E route-switch video ' + keep + ' ctBefore=' + ctBefore);
    report.steps.routeSwitch = { keep: JSON.parse(keep), ctBefore };

    // ---- 第 7 轮新增：多段轮播验证 ----
    // ① 层数必须是 2（App.vue 的 bgSources 有两段）；
    // ② seek 到当前段末尾触发 ended（代替干等 22 秒），等交叉淡入完成后，
    //    断言 activeLayer 变成另一段，且**新段确实在播**（paused=false / currentTime 在涨）；
    // ③ 再等它自己走一段，确认不会卡死在第二段。
    const layers0 = JSON.parse(await ev(probeExpr()));
    console.log(
      'K carousel layers=' +
        layers0.layers +
        ' active=' +
        layers0.activeLayer +
        ' states=' +
        JSON.stringify(layers0.layerStates)
    );
    report.steps.carousel = {
      layers: layers0.layers,
      activeBefore: layers0.activeLayer,
      layerStates: layers0.layerStates,
    };

    if (layers0.layers > 1) {
      const kicked = await ev(
        `(() => {
          const v = document.querySelector('.vbg__layer--on video');
          if (!v) return 'no-video';
          if (!Number.isFinite(v.duration) || v.duration <= 0) return 'no-duration';
          try { v.currentTime = Math.max(0, v.duration - 0.25); } catch (e) { return 'seek-fail:' + e.message; }
          return 'kicked:' + Number(v.duration.toFixed(2));
        })()`
      );
      console.log('L kick ' + kicked);
      await sleep(3200);
      const after = JSON.parse(await ev(probeExpr()));
      const hAfter = JSON.parse(await videoHealth());
      const ctAfter2 = V(JSON.parse(await ev(probeExpr()))).currentTime;
      await sleep(1500);
      const ctAfter3 = V(JSON.parse(await ev(probeExpr()))).currentTime;
      console.log(
        'M carousel after active=' +
          after.activeLayer +
          ' src=' +
          String(V(after).src || '')
            .split('/')
            .pop() +
          ' paused=' +
          V(after).paused +
          ' ct=' +
          V(after).currentTime +
          '->' +
          ctAfter3 +
          ' frames=' +
          hAfter.frames
      );
      console.log('N layer states after switch ' + JSON.stringify(after.layerStates));
      report.steps.carousel.afterStates = after.layerStates;
      report.steps.carousel.kicked = kicked;
      report.steps.carousel.after = {
        activeLayer: after.activeLayer,
        video: V(after),
        health: hAfter,
        ctGrowth: Number((ctAfter3 - ctAfter2).toFixed(2)),
      };
    }

    await nav(ORIGIN + '/#/this-route-does-not-exist', 3500);
    const c1 = JSON.parse(await ev(probeExpr()));
    await shot('04-404-desktop.png');
    console.log('C 404 text=' + c1.bodyText.slice(0, 55));
    report.steps.notFoundDesktop = { probe: c1 };
  }

  await setVP(390, 844, true);
  await ev(`localStorage.removeItem('aige-token')`);
  await nav(ORIGIN + '/#/login', 3500);
  const d1 = JSON.parse(await ev(probeExpr()));
  const d1ov = JSON.parse(await ev(overflowExpr()));
  await shot('05-login-mobile-390.png');
  console.log(
    'D1 mobile login vp=' +
      d1.iw +
      'x' +
      d1.ih +
      ' rect=' +
      JSON.stringify(V(d1).rect) +
      ' hOv=' +
      (d1ov.docScrollW > d1ov.vw + 1) +
      ' realOv=' +
      d1ov.overs.length +
      ' inScroller=' +
      d1ov.scrollers.length
  );
  if (d1ov.overs.length) console.log('D1 overs ' + JSON.stringify(d1ov.overs.slice(0, 5)));
  report.steps.loginMobile = { probe: d1, overflow: d1ov };

  if (login === 'OK') {
    const login2 = await ev(loginExpr(), true);
    console.log('LOGIN2 ' + login2);
    await nav(ORIGIN + '/#/dashboard', 6500);
    const d2 = JSON.parse(await ev(probeExpr()));
    const d2ov = JSON.parse(await ev(overflowExpr()));
    await shot('06-dashboard-mobile-390.png');
    console.log(
      'D2 mobile dash rect=' +
        JSON.stringify(V(d2).rect) +
        ' hOv=' +
        (d2ov.docScrollW > d2ov.vw + 1) +
        ' realOv=' +
        d2ov.overs.length +
        ' text=' +
        d2.bodyText.slice(0, 55)
    );
    if (d2ov.overs.length) console.log('D2 overs ' + JSON.stringify(d2ov.overs.slice(0, 5)));
    report.steps.dashboardMobile = { probe: d2, overflow: d2ov };

    // 移动端抽屉（主人本轮点名「侧边栏，我们展开这个，这边不是玻璃」）：
    // 展开前先点汉堡按钮，读抽屉与抽屉里导航项的 computed 底色/模糊。
    // 抽屉必须是**跟桌面侧栏同一档**（50% / blur(4px)），否则展开后是一块比侧栏白的板子。
    const drawerOpenHit = await ev(
      `(() => { const b = document.querySelector('.topbar__left .topbar__icon-btn'); if (!b) return 'no-btn'; b.click(); return 'ok'; })()`
    );
    await sleep(900);
    const drawerStyle = await ev(
      `(() => { const f = (el) => { if (!el) return null; const c = getComputedStyle(el); return { bg: c.backgroundColor, blur: c.backdropFilter || c.webkitBackdropFilter || 'none' }; }; const d = document.querySelector('.el-drawer'); return JSON.stringify({ drawer: f(d), navItem: f(d ? d.querySelector('.nav__item') : null), navActive: f(d ? d.querySelector('.nav__item--active') : null) }); })()`
    );
    await shot('09-drawer-mobile-390.png');
    console.log('I drawer ' + drawerOpenHit + ' ' + drawerStyle);
    report.drawerMobile = { hit: drawerOpenHit, style: JSON.parse(drawerStyle) };
    await ev(
      `(() => { const items = [...document.querySelectorAll('.el-drawer .nav__item')]; const t = items.find((el) => /网站管理/.test(el.textContent || '')) || items[0]; if (!t) return 'no-item'; t.click(); return 'ok'; })()`
    );
    await sleep(1200);
  }

  const mp4 = [];
  for (const e of cdp.events) {
    if (
      e.method === 'Network.responseReceived' &&
      e.params.response &&
      String(e.params.response.url).indexOf('.mp4') >= 0
    )
      mp4.push({
        file: String(e.params.response.url).split('/').pop().split('?')[0],
        status: e.params.response.status,
        mime: e.params.response.mimeType,
      });
  }
  const mp4Files = [...new Set(mp4.map((x) => x.file))];
  console.log('NET mp4 ' + JSON.stringify({ files: mp4Files, sample: mp4.slice(0, 4) }));
  const jsErr = cdp.events
    .filter((x) => x.method === 'Runtime.exceptionThrown')
    .map((x) => String(x.params.exceptionDetails && x.params.exceptionDetails.text));
  console.log('JS errors ' + JSON.stringify(jsErr.slice(0, 6)));
  report.network = { mp4: mp4, jsErrors: jsErr };
  report.shots = shots;
  writeFileSync(join(SHOTS, 'bg-video-report.json'), JSON.stringify(report, null, 2));
  console.log('DONE');
  cleanup();
  process.exit(0);
})().catch((err) => {
  console.log('FATAL ' + (err && err.stack ? err.stack : err));
  cleanup();
  process.exit(1);
});
