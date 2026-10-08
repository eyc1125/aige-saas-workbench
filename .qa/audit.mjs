/**
 * 多端适配验收台（Edge 无头 + Chrome DevTools Protocol）
 * ------------------------------------------------------------------
 * 目的：不靠"把浏览器窗口拖窄看看"，而是在真实渲染下按 finesse mobile floor
 *      在 320 / 375 / 414 / 768 / 1440 五个宽度逐页做机械体检：
 *
 *        M1  整页横向溢出（html/body scrollWidth > 可视宽）
 *        M2  具体是哪些元素溢出了（定位到元素）
 *        M3  可点击文本折成两行
 *        M4  长串（域名、URL、容器 ID）撑破容器
 *        —   触控目标 < 44px（仅在 ≤768 的移动宽度下判定）
 *
 *      同时逐页截图存到 .qa/shots/，供人眼复核。
 *
 * 为什么自己写 CDP 而不装 Playwright：本机已有 Edge，Node 24 自带 WebSocket，
 * 零依赖就能跑，不用往项目里加 200MB 的测试依赖。
 *
 * 用法：
 *   node .qa/audit.mjs
 *   node .qa/audit.mjs --origin=https://aige-saas-panel.miaocaieyc.com.cn
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------- 配置 ----------------
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};

const ORIGIN = arg('origin', 'https://aige-saas-panel.miaocaieyc.com.cn').replace(/\/$/, '');
const ORIGIN_IP = arg('origin-ip', '120.53.102.56');
/** 默认绕开 Cloudflare 直连源站：本机到 CF 的国际链路拉大文件会断，
 *  而验证的是「页面本身」在手机上的表现，走不走 CDN 不影响结论。
 *  想测 CDN 链路加 --through-cf。 */
const THROUGH_CF = process.argv.includes('--through-cf');
const USERNAME = arg('user', 'elyac');
const PASSWORD = arg('pass', 'elyac123456');
const SHOT_DIR = resolve('.qa/shots');
const PROFILE = join(tmpdir(), `aige-qa-${Date.now()}`);
const DEBUG_PORT = Number(arg('port', '9333'));

/** 断点：320 是地板（iPhone SE），768 是两栏该塌陷的位置 */
const VIEWPORTS = [
  { w: 320, h: 568, name: '320-se', mobile: true },
  { w: 375, h: 812, name: '375-iphone', mobile: true },
  { w: 414, h: 896, name: '414-plus', mobile: true },
  { w: 768, h: 1024, name: '768-ipad', mobile: true },
  { w: 1440, h: 900, name: '1440-pc', mobile: false },
];

/** 被测页面：hash 路由 */
const PAGES = [
  { hash: '/login', name: 'login', title: '登录页', shot: true },
  { hash: '/dashboard', name: 'dashboard', title: '仪表盘', shot: true },
  { hash: '/websites', name: 'websites', title: '网站管理', shot: true },
  { hash: '/certificates', name: 'certificates', title: '证书与安全', shot: true },
  { hash: '/inspect', name: 'inspect', title: '健康巡检', shot: true },
  { hash: '/domains', name: 'domains', title: '域名管理', shot: true },
  { hash: '/docker', name: 'docker', title: 'Docker 管理', shot: true },
  { hash: '/apps', name: 'apps', title: '应用商店', shot: true },
  { hash: '/settings', name: 'settings', title: '系统设置', shot: true },
];

/** --only=dashboard,settings 只跑指定页面（只想复核某一页时用，省时间） */
const ONLY = arg('only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const PAGES_TO_RUN = ONLY.length ? PAGES.filter((p) => ONLY.includes(p.name)) : PAGES;

/** --click=<选择器> + --click-on=<页面name>：进页面后先点一下再体检（用于弹窗/抽屉这类"打开才存在"的 UI） */
const CLICK_SELECTOR = arg('click', '');
const CLICK_PAGE = arg('click-on', 'settings');

/** --full 截图包含视口以下的内容（用来核对「必须往下滚才看得到」的区块，如设置页的 MCP 段） */
const FULL_PAGE = process.argv.includes('--full');

/** --settle=6000 每页额外多等 N 毫秒（有些页面首屏就要读证书/查云端，默认 3s 会截到加载态） */
const SETTLE_MS = Number(arg('settle', '0')) || 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 极简 CDP 客户端 ----------------
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(`${msg.error.message} (${msg.error.code})`)) : res(msg.result);
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
          rej(new Error(`CDP 超时：${method}`));
        }
      }, 20000);
    });
  }
}

async function connect() {
  // 轮询调试端口，等 Edge 起来
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const targets = await r.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.addEventListener('open', res, { once: true });
          ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
        });
        return new CDP(ws);
      }
    } catch {
      /* 还没起来，继续等 */
    }
    await sleep(500);
  }
  throw new Error('无法连接 Edge 调试端口');
}

// ---------------- 页面内体检脚本 ----------------
const AUDIT_FN = `(() => {
  const vw = document.documentElement.clientWidth;
  const isMobileWidth = vw <= 768;
  const label = (el) => {
    let s = el.tagName.toLowerCase();
    if (typeof el.className === 'string' && el.className.trim()) {
      s += '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.');
    }
    return s;
  };
  const visible = (el, cs) => cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05;

  const out = {
    vw,
    docScrollW: document.documentElement.scrollWidth,
    bodyScrollW: document.body.scrollWidth,
    overflow: [],
    scrollContained: [],
    smallTap: [],
    wrapped: [],
  };

  // M1/M2/M4 —— 横向溢出，定位到具体元素
  // 区分两类：真溢出（撑破布局）vs 处于横向滚动容器内（表格的预期行为）
  const inHScroller = (el) => {
    let p = el.parentElement;
    while (p && p !== document.documentElement) {
      const cs = getComputedStyle(p);
      if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && p.scrollWidth > p.clientWidth + 1) return true;
      p = p.parentElement;
    }
    return false;
  };

  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (!visible(el, cs)) continue;
    if (cs.position === 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.right > vw + 2 || r.left < -2) {
      const key = label(el) + Math.round(r.width);
      if (seen.has(key)) continue;
      seen.add(key);
      const item = {
        el: label(el),
        left: Math.round(r.left),
        right: Math.round(r.right),
        w: Math.round(r.width),
        text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 34),
      };
      (inHScroller(el) ? out.scrollContained : out.overflow).push(item);
    }
  }

  // 触控目标 —— 仅在移动宽度下判定（桌面 34px 图标按钮是正常的）
  //   · input 若被 ≥44px 的 el-input__wrapper / el-select__wrapper 包着，
  //     真正的点击区是外层 wrapper，不该按内层输入框的高度判定。
  const wrappedByBigBox = (el) => {
    const box = el.closest('.el-input__wrapper, .el-select__wrapper');
    return !!box && box.getBoundingClientRect().height >= 44;
  };

  if (isMobileWidth) {
    for (const el of document.querySelectorAll('button, a[href], [role=button], .el-button, .el-tabs__item, input, select')) {
      const cs = getComputedStyle(el);
      if (!visible(el, cs)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (el.tagName === 'INPUT' && wrappedByBigBox(el)) continue;
      if (r.height < 44) {
        const txt = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ').slice(0, 22);
        out.smallTap.push({ el: label(el), h: Math.round(r.height), w: Math.round(r.width), text: txt || '(无文字)' });
      }
    }
  }

  // M3 —— 数「文本真的折了几行」。两个坑都踩过：
  //   1) 不能用「元素高度 ÷ 行高」—— 固定 height 的按钮会被误判成两行；
  //   2) 不能直接按 rect.top 分组 —— 图标(16px)与文字(13px)垂直居中后 top 差几像素，
  //      会被当成两行。改用「垂直中心 + 半个行高的容差」聚类。
  // 另外：元素内部若含块级/弹性子元素（例如「姓名在上、角色在下」），
  //      那是刻意的多行排版，不算折行。
  const hasBlockChild = (el) =>
    Array.from(el.children).some((c) => {
      const d = getComputedStyle(c).display;
      return d === 'block' || d === 'flex' || d === 'grid' || d === 'list-item';
    });

  const lineCount = (el) => {
    const rng = document.createRange();
    rng.selectNodeContents(el);
    const rects = Array.from(rng.getClientRects()).filter((x) => x.height > 0 && x.width > 0);
    if (!rects.length) return 0;
    const hs = rects.map((x) => x.height).sort((a, b) => a - b);
    const medH = hs[Math.floor(hs.length / 2)] || 12;
    const tol = Math.max(4, medH * 0.5);
    const centers = [];
    for (const r of rects) {
      const c = (r.top + r.bottom) / 2;
      if (!centers.some((t) => Math.abs(t - c) < tol)) centers.push(c);
    }
    return centers.length;
  };

  for (const el of document.querySelectorAll('button, a[href], .el-button, .el-tabs__item')) {
    const cs = getComputedStyle(el);
    if (!visible(el, cs)) continue;
    if (cs.whiteSpace === 'nowrap') continue; // 已显式不换行，不算缺陷
    if (hasBlockChild(el)) continue; // 刻意的多行排版
    const txt = (el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (!txt || txt.length > 30) continue;
    const lines = lineCount(el);
    if (lines >= 2) out.wrapped.push({ el: label(el), lines, text: txt.slice(0, 22) });
  }

  return out;
})()`;

// ---------------- 主流程 ----------------
(async () => {
  const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!edge) {
    console.error('❌ 找不到 Edge/Chrome，无法运行验收台');
    process.exit(1);
  }
  mkdirSync(SHOT_DIR, { recursive: true });

  console.log(`浏览器：${edge}`);
  console.log(`目标站：${ORIGIN}`);
  console.log(`截图目录：${SHOT_DIR}\n`);

  const child = spawn(
    edge,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      ...(THROUGH_CF ? [] : [`--host-resolver-rules=MAP ${new URL(ORIGIN).hostname} ${ORIGIN_IP}`]),
      'about:blank',
    ],
    { stdio: 'ignore', detached: false }
  );

  let cdp;
  try {
    cdp = await connect();
  } catch (err) {
    console.error(`❌ ${err.message}`);
    child.kill();
    process.exit(1);
  }

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // 不开 Network：CDP 会把每个资源的十几个事件都推过来，白白拖慢求值

  const evaluate = async (expr, awaitPromise = false, retries = 2) => {
    let lastErr;
    for (let i = 0; i <= retries; i += 1) {
      try {
        const r = await cdp.send('Runtime.evaluate', {
          expression: expr,
          awaitPromise,
          returnByValue: true,
        });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面内脚本异常');
        return r.result?.value;
      } catch (err) {
        lastErr = err;
        await sleep(1200);
      }
    }
    throw lastErr;
  };

  /**
   * 渲染断言 —— 这一步是整套验收台的地基。
   * 教训：第一版没有这个断言，页面因为资源加载失败而全白时，
   *      体检脚本仍然"全绿"（没有元素自然就没有溢出）。
   *      必须先确认 #app 真的挂载了、页面上真有文字，结论才算数。
   * 注意用 textContent 而不是 innerText —— innerText 会强制样式重算 + 重排，
   *      在重表格页面上会把 CDP 求值拖到超时。
   */
  const assertRendered = async () => {
    const raw = await evaluate(
      `JSON.stringify({
         mounted: (document.querySelector('#app')?.childElementCount ?? 0) > 0,
         textLen: (document.body.textContent || '').trim().length,
         ready: document.readyState,
       })`
    );
    const r = JSON.parse(raw);
    if (!r.mounted || r.textLen < 20) {
      throw new Error(
        `页面未真正渲染（#app 挂载=${r.mounted}，文字=${r.textLen} 字，readyState=${r.ready}）`
      );
    }
    return r;
  };

  const findings = [];
  let loggedIn = false;

  for (const vp of VIEWPORTS) {
    console.log(`\n══════════ 视口 ${vp.w} × ${vp.h}（${vp.name}） ══════════`);

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: vp.w,
      height: vp.h,
      deviceScaleFactor: 1,
      mobile: vp.mobile,
    });
    if (vp.mobile) {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    } else {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    }

    // 首次进入：登录并把 token 写进 localStorage
    if (!loggedIn) {
      await cdp.send('Page.navigate', { url: `${ORIGIN}/` });
      await sleep(7000);
      const token = await evaluate(
        `(async () => {
           const r = await fetch('/api/auth/login', {
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ username: ${JSON.stringify(USERNAME)}, password: ${JSON.stringify(PASSWORD)} }),
           });
           const j = await r.json();
           if (j.code !== 0) return 'ERR:' + j.message;
           localStorage.setItem('aige-token', j.data.token);
           return 'OK';
         })()`,
        true
      );
      if (token !== 'OK') {
        console.error(`❌ 登录失败：${token}`);
        child.kill();
        process.exit(1);
      }
      loggedIn = true;
      console.log('  ✅ 已登录（令牌写入 localStorage）');
    } else {
      // 换视口后整页重载，保证按新宽度的首屏状态渲染
      await cdp.send('Page.reload', { ignoreCache: false });
      await sleep(5000);
      try {
        await assertRendered();
      } catch (err) {
        console.log(`  ⚠️  重载后渲染异常：${err.message}`);
        await sleep(3000);
      }
    }

    for (const page of PAGES_TO_RUN) {
      try {
        await evaluate(`location.hash = ${JSON.stringify(`#${page.hash}`)}`);
      } catch (err) {
        console.log(`  ❌ ${page.title.padEnd(10)} 路由切换失败 —— ${err.message}`);
        findings.push({
          vp: vp.name,
          page: page.title,
          kind: '体检查询失败（截图可人工复核）',
          detail: err.message,
        });
        try {
          await cdp.send('Page.reload', { ignoreCache: false });
          await sleep(5000);
        } catch {
          /* 复位失败无妨，下一页继续 */
        }
        continue;
      }
      await sleep((page.hash === '/login' ? 1800 : 3000) + SETTLE_MS);

      // 可选：进页面后先点一下再体检。
      // 用途：弹窗、抽屉这类"打开才存在"的东西平时根本进不了体检范围，
      // 而它们恰恰最容易在窄屏上溢出（比如固定宽度的 el-dialog）。
      // 用法：--click=.some-btn --click-on=settings
      if (CLICK_SELECTOR && CLICK_PAGE === page.name) {
        try {
          await evaluate(`
            (() => {
              const el = document.querySelector(${JSON.stringify(CLICK_SELECTOR)});
              if (!el) return 'not-found';
              el.click();
              return 'clicked';
            })()
          `);
          await sleep(2200); // 等弹窗动画与内容渲染（二维码是异步生成的）
        } catch (err) {
          console.log(`  ⚠️  点击 ${CLICK_SELECTOR} 失败：${err.message}`);
        }
      }

      // 地基断言：页面必须先真的渲染出来，否则后面的「全绿」毫无意义
      try {
        await assertRendered();
      } catch (err) {
        console.log(`  ❌ ${page.title.padEnd(10)} 未渲染 —— ${err.message}`);
        findings.push({
          vp: vp.name,
          page: page.title,
          kind: '页面未渲染（严重）',
          detail: err.message,
        });
        if (page.shot) {
          try {
            const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
            writeFileSync(
              join(SHOT_DIR, `${vp.name}__${page.name}.png`),
              Buffer.from(shot.data, 'base64')
            );
          } catch {
            /* 截图失败不影响结论 */
          }
        }
        continue;
      }

      let audit;
      try {
        audit = await evaluate(AUDIT_FN);
      } catch (err) {
        console.log(`  ⚠️  ${page.title}：体检脚本失败 —— ${err.message}`);
        continue;
      }

      const overflowN = audit.overflow.length;
      const scrolledN = audit.scrollContained.length;
      const tapN = audit.smallTap.length;
      const wrapN = audit.wrapped.length;
      const hasIssue = audit.docScrollW > audit.vw + 1 || overflowN || tapN || wrapN;
      const flag = hasIssue ? '⚠️ ' : '✅';

      console.log(
        `${flag} ${page.title.padEnd(10)} 页宽=${audit.docScrollW}/${audit.vw}  真溢出=${overflowN}  滚动区内=${scrolledN}（表格预期）  触控过小=${tapN}  文本折行=${wrapN}`
      );

      if (audit.docScrollW > audit.vw + 1) {
        findings.push({
          vp: vp.name,
          page: page.title,
          kind: 'M1 整页横向溢出',
          detail: `scrollWidth ${audit.docScrollW} > 视口 ${audit.vw}`,
        });
      }
      audit.overflow.slice(0, 4).forEach((o) => {
        findings.push({
          vp: vp.name,
          page: page.title,
          kind: 'M2 元素溢出',
          detail: `${o.el} 右边界 ${o.right}（超 ${o.right - audit.vw}px）「${o.text}」`,
        });
      });
      audit.smallTap.slice(0, 4).forEach((t) => {
        findings.push({
          vp: vp.name,
          page: page.title,
          kind: '触控 <44px',
          detail: `${t.el} ${t.h}px「${t.text}」`,
        });
      });
      audit.wrapped.slice(0, 4).forEach((w) => {
        findings.push({
          vp: vp.name,
          page: page.title,
          kind: 'M3 按钮折行',
          detail: `${w.el} 折 ${w.lines} 行「${w.text}」`,
        });
      });

      if (page.shot) {
        try {
          const shot = await cdp.send('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: FULL_PAGE,
          });
          const file = join(SHOT_DIR, `${FULL_PAGE ? 'full__' : ''}${vp.name}__${page.name}.png`);
          writeFileSync(file, Buffer.from(shot.data, 'base64'));
        } catch (err) {
          console.log(`     （截图失败：${err.message}）`);
        }
      }
    }
  }

  // ---------------- 汇总 ----------------
  console.log(`\n${'═'.repeat(70)}`);
  console.log('汇总报告');
  console.log('═'.repeat(70));
  if (!findings.length) {
    console.log('\n✅ 全部视口、全部页面：无横向溢出、无过小触控目标、无按钮折行。\n');
  } else {
    const byKind = {};
    findings.forEach((f) => {
      byKind[f.kind] = (byKind[f.kind] || 0) + 1;
    });
    console.log('\n按问题类型统计：');
    Object.entries(byKind).forEach(([k, n]) => console.log(`  ${k}：${n} 处`));
    console.log('\n明细：');
    findings.forEach((f) => console.log(`  [${f.vp}] ${f.page} · ${f.kind}\n      ${f.detail}`));
    console.log('');
  }
  console.log(`截图：${SHOT_DIR}\n`);

  child.kill();
  await sleep(600);
  try {
    rmSync(PROFILE, { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉不影响结果 */
  }
  process.exit(0);
})().catch((err) => {
  console.error(`\n❌ 验收台异常：${err.stack || err.message}`);
  process.exit(1);
});
