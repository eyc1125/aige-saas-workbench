/**
 * 自愈巡检引擎
 * ------------------------------------------------------------------
 * 把「运维里反复出现、且有确定修法」的问题做成固定的检查项 —— 每一项都包含
 * 「只读探测」和「可选修复」两半，探测永不加压、修复必须显式触发（或由开关授权）。
 *
 * 设计原则（这几条是「自愈别变自毁」的全部理由，改代码前先读）：
 *   1. **作用域白名单**：只对本项目名下资源自动修复（自己的域名 / 自己的容器）；
 *      其他项目的站点与容器一律「只报告、不动作」—— 这是本项目的最高优先级铁律。
 *   2. **探测与执行分离**：inspect() 只读，绝不产生副作用；apply() 才动手。
 *   3. **熔断**：同一修复动作 30 分钟内最多执行 3 次。容器起不来时反复重启只会
 *      把机器拖垮，所以宁可停下来报警。
 *   4. **全量留痕**：每次修复（无论成败）都写一条 operation_logs。
 *   5. **动作来自固定注册表**：不接受任意指令，AI 也只能调注册表里的 checkId。
 *
 * 检查项分成两档：
 *   · 可修复（fix 非空）—— 页面给「一键修复」，开启自动修复后也会被定时执行
 *   · 仅报告（fix 为空）—— 比如 zone 级 SSL 模式，改动会影响其他项目，只能人决定
 */
'use strict';

const bcrypt = require('bcryptjs');
const db = require('../db');
const settings = require('./settings');
const baotaService = require('./baota');
const cloudflareService = require('./cloudflare');
const dockerService = require('./docker');
const notify = require('./notify');
const { writeLog } = require('../utils/logger');
const { badRequest } = require('../utils/errors');

// ============================================================
// 作用域白名单
// ============================================================

/** 本项目自己的容器（与 docker-compose.yml 保持一致） */
const OWN_CONTAINERS = ['aige-workbench-backend', 'aige-workbench-frontend'];

/** 本项目自己的域名后缀 —— 用于判断某个 Cloudflare zone 是否与本站点相关 */
const OWN_ZONE_SUFFIXES = ['miaocaieyc.com.cn'];

/**
 * 本项目自己的站点名前缀（对应「二级域名统一加 aige-saas- 前缀」这条约定）。
 * ⚠️ 为什么必须有这个白名单：宝塔站点列表里混着服务器上**其他项目**的站点
 *    （koyca / tito-* / ogkur / play.koyca 等）。证书类修复是会真的去签发/改配置的动作，
 *    不加白名单就会替别的项目动手 —— 这违反本项目的最高优先级铁律（只动自己名下资源）。
 *    其他项目的站点一律只列成 info 级「仅报告」，不进 fix.payload。
 */
const OWN_SITE_PREFIXES = ['aige-saas-'];

/** 是否属于本项目自己的站点 */
function isOwnSite(siteName) {
  const n = String(siteName || '');
  return OWN_SITE_PREFIXES.some((p) => n.startsWith(p));
}

/** 把站点分成「自己的」与「其他项目的」 */
function splitByOwnership(list) {
  return {
    own: list.filter((c) => isOwnSite(c.siteName)),
    foreign: list.filter((c) => !isOwnSite(c.siteName)),
  };
}

/** 其他项目站点的统一标注（渲染到 items 的 tag 里，让使用者一眼看出为什么没被处理） */
const FOREIGN_TAG = '其他项目 · 仅报告，不处理';

/** 是否属于本项目自己的容器 */
function isOwnContainer(c) {
  return !!c.managedByWorkbench || OWN_CONTAINERS.includes(c.name);
}

/** 站点名看起来是不是 IP（IP 型站点不参与"补证书"建议，它本来就没法签） */
const looksLikeIp = (name) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(name || ''));

// ============================================================
// 熔断器（内存态即可：进程重启后重新计时，不会绕过白名单）
// ============================================================
const FIX_WINDOW_MS = 30 * 60 * 1000;
const FIX_MAX_PER_WINDOW = 3;
const fixLog = new Map(); // checkId → [timestamp, ...]

function fixBudget(checkId) {
  const now = Date.now();
  const hits = (fixLog.get(checkId) || []).filter((t) => now - t < FIX_WINDOW_MS);
  fixLog.set(checkId, hits);
  return {
    used: hits.length,
    limit: FIX_MAX_PER_WINDOW,
    remaining: Math.max(0, FIX_MAX_PER_WINDOW - hits.length),
    windowMinutes: FIX_WINDOW_MS / 60000,
  };
}

function assertFixBudget(checkId, title) {
  const b = fixBudget(checkId);
  if (b.remaining <= 0) {
    throw Object.assign(
      new Error(
        `「${title}」在 ${b.windowMinutes} 分钟内已修复 ${b.limit} 次，已触发熔断。` +
          '通常是问题没被真正解决——请先看修复日志，别继续重试。'
      ),
      { expected: true, status: 429 }
    );
  }
}

function recordFixAttempt(checkId) {
  const hits = fixLog.get(checkId) || [];
  hits.push(Date.now());
  fixLog.set(checkId, hits);
}

// ============================================================
// 单次巡检内的共享缓存
// ------------------------------------------------------------------
// 背景：ssl_expiring / ssl_missing / cf_ssl_mode 三个检查项都要「全站证书台账」，
//      而 listSslCerts() 会逐站读证书文件（14 个站点 = 14 次面板调用）。
//      不加缓存就是把同一份数据重复读 3 遍，页面白等十几秒。
//
// 缓存生命周期 = **一次 runChecks**（每次开跑就清空）：
//   · 同一次巡检内共享，省掉重复读取
//   · 下一次巡检重新算，避免修复完还拿到旧数据
// ============================================================
let runMemo = new Map();

function memoized(key, fn) {
  if (runMemo.has(key)) return runMemo.get(key);
  const value = Promise.resolve().then(fn);
  runMemo.set(key, value);
  // 失败不留在缓存里，避免一次网络抖动被固化到本次巡检结束
  value.catch(() => runMemo.delete(key));
  return value;
}

/** 本次巡检共享的证书台账 */
const listSslCertsShared = () =>
  memoized('sslCerts', () => baotaService.createClient().listSslCerts());

// ---------------- 「内存水位」用到的阈值与取数 ----------------

/** 判断内存水位持续多久：5 分钟（采样 2 分钟一条，够算出「最坏时刻」） */
const MEMORY_WINDOW_MIN = 5;

/**
 * 近 N 分钟的样本统计（复用 metrics_samples，2 分钟一条）
 * @returns {{ samples:number, maxUsed:number, avgUsed:number }}
 *          maxUsed / avgUsed 都是「已用百分比」，可用内存 = 100 - 它
 */
function memoryWindow(minutes) {
  const since = Math.floor(Date.now() / 1000) - minutes * 60;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n,
              MAX(mem_percent) AS maxUsed,
              ROUND(AVG(mem_percent), 1) AS avgUsed
         FROM metrics_samples
        WHERE ts >= ?`
    )
    .get(since);
  return {
    samples: row?.n || 0,
    maxUsed: Number(row?.maxUsed) || 0,
    avgUsed: Number(row?.avgUsed) || 0,
  };
}

/**
 * 内存占用 Top 的容器（只在水位告急时调用）
 * ------------------------------------------------------------------
 * ⚠️ 这里**故意把其他项目的容器也列出来**：内存是被整台机器共用的，
 *    真凶很可能是别的项目的容器。列出来是为了让人**看得见**，
 *    但其他项目的容器只标 `FOREIGN_TAG`、不提供任何动作（同 container_down 的口径）。
 */
async function topMemoryContainers(limit = 6) {
  const docker = dockerService.createClient();
  const all = await docker.listContainers(true);
  const rows = [];

  for (const c of all.filter((x) => x.running)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const stats = await docker.containerStats(c.id);
      rows.push({ container: c, ...stats });
    } catch {
      /* 个别容器取不到（刚重启 / 权限）不影响整体结论，跳过 */
    }
  }

  rows.sort((a, b) => b.memUsedMb - a.memUsedMb);
  return rows.slice(0, limit).map((r) => {
    const own = isOwnContainer(r.container);
    return {
      name: r.container.name,
      tag: `占用 ${r.memUsedMb} MB · 上限的 ${r.memPercent}%${
        r.cpuPercent ? ` · CPU ${r.cpuPercent}%` : ''
      }${own ? '' : ` · ${FOREIGN_TAG}`}`,
      level: own && r.memUsedMb >= 300 ? 'warning' : 'info',
    };
  });
}

// ---------------- 「容器重启循环」用到的阈值 ----------------

/** 累计重启次数下限 */
const RESTART_LOOP_MIN_COUNT = 3;
/** 「最近启动过」的时间窗：1 小时 */
const RESTART_LOOP_WINDOW_MS = 60 * 60 * 1000;

// ---------------- 「站点配置 / 证书链 / 日志」共用的台账 ----------------

/** 访问日志告警线：500MB；严重线：2GB */
const LOG_BLOAT_WARN_BYTES = 500 * 1024 * 1024;
const LOG_BLOAT_CRITICAL_BYTES = 2 * 1024 * 1024 * 1024;

/** 站点日志目录（与 baota.js 的 WWWLOGS_DIR 保持一致） */
const WWWLOGS_DIR = '/www/wwwlogs';

/**
 * 日志目录索引：文件名 → 字节数（一次 listDir，所有站点共用）
 * 取不到时返回空 Map —— 日志大小只是增值信息，不该让整项巡检失败。
 */
const logsIndex = () =>
  memoized('logsIndex', async () => {
    const res = await baotaService
      .createClient()
      .listDir(WWWLOGS_DIR, 500)
      .catch(() => null);
    const map = new Map();
    (res?.entries || []).forEach((e) => {
      if (!e.isDir) map.set(e.name, Number(e.size) || 0);
    });
    return map;
  });

/**
 * 本项目站点的「配置 + 证书链」台账（一次巡检只算一遍）
 * ------------------------------------------------------------------
 * 为什么要做成台账而不是各检查项各读一遍：`getNginxConfig` 是按站点发请求的，
 * 本项目站点有好几个，三个检查项各读一次就是三倍的等待 —— 而它们要的是同一份数据。
 *
 * 每条的字段都是「探测结论」而不是原始配置（原始配置可能几十 KB，
 * 没必要在巡检结果里传一遍）：
 *   has443 / certPaths / chainCount / configEmpty / logBytes
 */
const ownSiteFacts = () =>
  memoized('ownSiteFacts', async () => {
    const baota = baotaService.createClient();
    const [{ list }, certData, logs] = await Promise.all([
      baota.getSiteList({ page: 1, limit: 500 }),
      listSslCertsShared(),
      logsIndex(),
    ]);

    const own = list.filter((s) => isOwnSite(s.name));
    const out = [];

    for (const site of own) {
      // eslint-disable-next-line no-await-in-loop -- 逐站读配置，一次一个，别把面板打满
      const conf = await baota.getNginxConfig(site.name).catch(() => null);
      const content = String(conf?.content || '');

      // 配置里 ssl_certificate 指向的证书文件（宝塔通常指 fullchain.pem）
      const certPaths = [...content.matchAll(/ssl_certificate\s+([^;]+);/g)].map((m) =>
        m[1].trim()
      );
      const mainCert = certPaths.find((p) => !/\.key$/i.test(p));

      let chainCount = null;
      let certFileMissing = false;
      if (mainCert) {
        // eslint-disable-next-line no-await-in-loop
        const pem = await baota.readFile(mainCert).catch(() => null);
        if (pem) chainCount = (String(pem).match(/BEGIN CERTIFICATE/g) || []).length;
        else certFileMissing = true;
      }

      const cert = certData.certs.find((c) => c.siteName === site.name);
      out.push({
        siteName: site.name,
        domains: site.domains.length ? site.domains : [site.name],
        hasCert: !!cert?.hasCert,
        daysLeft: cert?.daysLeft ?? null,
        configEmpty: !content,
        has443: /listen\s+[^;]*443/.test(content) || /ssl_certificate/.test(content),
        certPaths,
        mainCert: mainCert || '',
        chainCount,
        certFileMissing,
        logBytes: (logs.get(`${site.name}.log`) || 0) + (logs.get(`${site.name}.error.log`) || 0),
      });
    }
    return out;
  });

/** 本项目站点台账里的 domain → siteName 反查（DNS / 缓存漂移要用域名） */
async function ownDomainsToSites() {
  const facts = await ownSiteFacts();
  const pairs = [];
  facts.forEach((f) => f.domains.forEach((d) => pairs.push({ domain: d, siteName: f.siteName })));
  return pairs;
}

/**
 * 本项目自己的 Cloudflare 区域（一次巡检只列一遍）
 * 与 OWN_ZONE_SUFFIXES 白名单同一口径 —— 无关区域（别的项目 / 别的域名）连读都不读。
 */
const listOwnZones = () =>
  memoized('ownZones', async () => {
    const zones = await cloudflareService.createClient().listZones();
    return zones.filter((z) =>
      OWN_ZONE_SUFFIXES.some((suffix) => z.name === suffix || z.name.endsWith(`.${suffix}`))
    );
  });

/** 字节数 → 人话（只在巡检结论里用，保留一位小数） */
function formatMb(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ---------------- 「CF 缓存漂移」用到的探测 ----------------

/** 检查一个页面上引用的第一个 js/css 资源是否被边缘缓存成了 HTML（或直接 404） */
async function probeStaticAsset(domain) {
  const base = `https://${domain}`;
  const withTimeout = async (url, asText) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
      return {
        status: res.status,
        type: String(res.headers.get('content-type') || ''),
        cache: String(res.headers.get('cf-cache-status') || ''),
        body: asText ? (await res.text()).slice(0, 200000) : '',
      };
    } finally {
      clearTimeout(timer);
    }
  };

  const home = await withTimeout(`${base}/`, true);
  if (home.status >= 400 || !home.body) return { domain, skipped: '首页取不到，跳过' };

  const m =
    home.body.match(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/i) ||
    home.body.match(/["']([^"']+\/assets\/[^"']+\.(?:js|css))["']/i);
  if (!m) return { domain, skipped: '首页里没找到 js/css 引用，跳过' };

  const raw = m[1];
  const assetUrl = /^https?:/i.test(raw) ? raw : `${base}${raw.startsWith('/') ? '' : '/'}${raw}`;
  const asset = await withTimeout(assetUrl, false);

  // 「资源被返回成 HTML」是很强的信号：正常 js/css 绝不会是 text/html
  const servedAsHtml = asset.type.includes('text/html');
  const missing = asset.status >= 400;
  return {
    domain,
    assetUrl,
    status: asset.status,
    contentType: asset.type,
    cfCacheStatus: asset.cache,
    servedAsHtml,
    missing,
    drift: servedAsHtml || missing,
  };
}

// ============================================================
// 检查项注册表
// ============================================================

const CHECKS = [
  // ---------------- 1. 证书临期 / 已过期 ----------------
  {
    id: 'ssl_expiring',
    title: '证书到期风险',
    group: '安全',
    scope: 'project',
    why: 'Let’s Encrypt 证书有效期 90 天，到期后浏览器会直接拦访问。留出提前量才能无感续签。',
    async inspect() {
      const data = await listSslCertsShared();
      // 只看真的临期的（ok 的不进列表，否则 13 个站点全列出来没人看）
      const risky = data.certs.filter(
        (c) => c.hasCert && (c.status === 'expired' || c.status === 'expiring')
      );
      const { own, foreign } = splitByOwnership(risky);

      const ownExpired = own.filter((c) => c.status === 'expired');
      // 已过期 + 7 天内到期的，才算「必须马上动手」
      const ownUrgent = own.filter((c) => c.status === 'expired' || c.daysLeft <= 7);

      const severity = ownExpired.length
        ? 'critical'
        : own.length
          ? 'warning'
          : foreign.length
            ? 'info'
            : 'ok';
      const summary = own.length
        ? `${own.length} 个本项目证书 15 天内到期${foreign.length ? `；另有 ${foreign.length} 个其他项目站点临期（仅报告）` : ''}`
        : foreign.length
          ? `本项目证书全部正常；另有 ${foreign.length} 个其他项目站点证书临期，仅报告`
          : `全部 ${data.withCert} 个证书状态正常`;

      const tagOf = (c) =>
        c.status === 'expired' ? `已过期 ${Math.abs(c.daysLeft)} 天` : `剩余 ${c.daysLeft} 天`;

      return {
        severity,
        summary,
        items: [
          ...own.map((c) => ({
            name: c.siteName,
            tag: tagOf(c),
            level: c.status === 'expired' || c.daysLeft <= 7 ? 'critical' : 'warning',
          })),
          ...foreign.map((c) => ({
            name: c.siteName,
            tag: `${tagOf(c)} · ${FOREIGN_TAG}`,
            level: 'info',
          })),
        ],
        fix: ownUrgent.length
          ? {
              label: `立即续签 ${ownUrgent.length} 个`,
              description:
                '只对本项目自己的站点重新签发 Let’s Encrypt 证书（逐个串行执行）；其他项目的站点不在处理范围内',
              risk: 'low',
              auto: true,
              payload: { sites: ownUrgent.slice(0, 10).map((c) => c.siteName) },
            }
          : null,
      };
    },
    async apply(payload) {
      const baota = baotaService.createClient();
      const results = [];
      for (const siteName of payload.sites) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const r = await baota.applyLetsEncrypt({ siteName });
          results.push({ siteName, ok: true, message: r.message || '已重新签发' });
        } catch (err) {
          results.push({ siteName, ok: false, message: err.message });
        }
      }
      const okCount = results.filter((r) => r.ok).length;
      return {
        message: `续签完成：成功 ${okCount} 个，失败 ${results.length - okCount} 个`,
        results,
      };
    },
  },

  // ---------------- 2. 站点未部署证书 ----------------
  {
    id: 'ssl_missing',
    title: '站点未启用 HTTPS',
    group: '安全',
    scope: 'project',
    why: '没有证书的站点只能走 HTTP，现代浏览器会标"不安全"，也不利于 SEO。',
    async inspect() {
      const data = await listSslCertsShared();
      // IP 型站点本来就没法签证书，直接排除
      const missingAll = data.certs.filter((c) => !c.hasCert && !looksLikeIp(c.siteName));
      const { own, foreign } = splitByOwnership(missingAll);

      return {
        severity: own.length ? 'info' : 'ok',
        summary: own.length
          ? `${own.length} 个本项目站点还没有证书${foreign.length ? `；另有 ${foreign.length} 个其他项目站点未部署（仅报告）` : ''}`
          : foreign.length
            ? `本项目站点证书齐全；另有 ${foreign.length} 个其他项目站点未部署，仅报告`
            : '所有站点都已启用 HTTPS',
        items: [
          ...own.map((c) => ({ name: c.siteName, tag: '未部署证书', level: 'info' })),
          ...foreign.map((c) => ({
            name: c.siteName,
            tag: `未部署证书 · ${FOREIGN_TAG}`,
            level: 'info',
          })),
        ],
        fix: own.length
          ? {
              label: `为 ${Math.min(own.length, 5)} 个站点申请证书`,
              description:
                '调用 Let’s Encrypt 自动签发。前提是该域名已解析到本机且 80 端口可达，否则会失败并回报原因。仅处理本项目自己的站点。',
              risk: 'medium',
              auto: false,
              payload: { sites: own.slice(0, 5).map((c) => c.siteName) },
            }
          : null,
      };
    },
    async apply(payload) {
      const baota = baotaService.createClient();
      const results = [];
      for (const siteName of payload.sites) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const r = await baota.applyLetsEncrypt({ siteName });
          results.push({ siteName, ok: true, message: r.message || '已提交签发' });
        } catch (err) {
          results.push({ siteName, ok: false, message: err.message });
        }
      }
      const okCount = results.filter((r) => r.ok).length;
      return {
        message: `申请完成：成功 ${okCount} 个，失败 ${results.length - okCount} 个`,
        results,
      };
    },
  },

  // ---------------- 3. Cloudflare SSL 模式与源站是否一致（仅报告） ----------------
  {
    id: 'cf_ssl_mode',
    title: 'Cloudflare SSL 模式一致性',
    group: '安全',
    scope: 'server',
    why: '源站有证书却用 flexible = 回源走明文（等于白装证书）；源站没证书却用 full/strict = 访客报 526。',
    async inspect() {
      const cf = cloudflareService.createClient();
      // 只看与本站点相关的 zone（白名单在 listOwnZones 里）；无关 zone 连读都不读
      const zones = await listOwnZones();
      const certData = await listSslCertsShared();

      const items = [];
      for (const z of zones) {
        // eslint-disable-next-line no-await-in-loop
        const mode = await cf.getSslMode(z.id).catch(() => null);
        if (!mode) continue;

        const sitesInZone = certData.certs.filter((c) =>
          c.domains.some((d) => d === z.name || d.endsWith(`.${z.name}`))
        );
        const hasOriginCert = sitesInZone.some((c) => c.hasCert);

        if (mode === 'flexible' && hasOriginCert) {
          items.push({
            name: z.name,
            tag: `模式 ${mode}，但源站已有证书 → 建议升级为 full`,
            level: 'warning',
            note: '该 zone 下可能还有其他项目的站点，改动会影响它们',
          });
        } else if ((mode === 'full' || mode === 'strict') && sitesInZone.length && !hasOriginCert) {
          items.push({
            name: z.name,
            tag: `模式 ${mode}，但源站没有证书 → 访客会报 526`,
            level: 'critical',
            note: '该 zone 下可能还有其他项目的站点，改动会影响它们',
          });
        }
      }

      return {
        severity: items.some((i) => i.level === 'critical')
          ? 'critical'
          : items.length
            ? 'warning'
            : 'ok',
        summary: items.length
          ? `${items.length} 个区域的 SSL 模式与源站不一致`
          : 'Cloudflare SSL 模式与源站一致',
        items,
        // ⚠️ 刻意不提供一键修复：zone 级设置会影响该域名下**所有**站点（含其他项目），
        //    属于必须由人判断的改动。这里只报告，并在文案里指出该去哪儿改。
        fix: null,
      };
    },
  },

  // ---------------- 4. 本项目容器异常退出 ----------------
  {
    id: 'container_down',
    title: '容器运行状态',
    group: '服务',
    scope: 'project',
    why: '本工作台自己的容器与应用商店部署的容器一旦退出，对应站点就整站不可用。',
    async inspect() {
      const docker = dockerService.createClient();
      const all = await docker.listContainers(true);

      const own = all.filter(isOwnContainer);
      const down = own.filter((c) => !c.running && c.state !== 'restarting');
      // 其他项目的容器：只报告数量，不做任何处理（工作边界）
      const others = all.filter((c) => !isOwnContainer(c) && !c.running);

      const severity = down.length ? 'critical' : others.length ? 'info' : 'ok';
      const summary = down.length
        ? `${down.length} 个本项目容器未在运行`
        : others.length
          ? `本项目容器全部运行中（另有 ${others.length} 个其他项目容器已停止，仅报告）`
          : `本项目 ${own.length} 个容器全部运行中`;

      return {
        severity,
        summary,
        items: [
          ...down.map((c) => ({
            name: c.name,
            tag: `状态 ${c.state}${c.appName ? ` · 应用 ${c.appName}` : ''}`,
            level: 'critical',
          })),
          ...others.map((c) => ({
            name: c.name,
            tag: `状态 ${c.state} · 其他项目，不处理`,
            level: 'info',
          })),
        ],
        fix: down.length
          ? {
              label: `启动 ${down.length} 个容器`,
              description: '只启动本工作台自己的容器与应用商店部署的容器；其他项目容器不碰',
              risk: 'low',
              auto: true,
              payload: { containers: down.map((c) => ({ name: c.name, id: c.id })) },
            }
          : null,
      };
    },
    async apply(payload) {
      const docker = dockerService.createClient();
      const results = [];
      for (const c of payload.containers) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await docker.startContainer(c.id);
          results.push({ siteName: c.name, ok: true, message: '已启动' });
        } catch (err) {
          results.push({ siteName: c.name, ok: false, message: err.message });
        }
      }
      const okCount = results.filter((r) => r.ok).length;
      return {
        message: `容器启动：成功 ${okCount} 个，失败 ${results.length - okCount} 个`,
        results,
      };
    },
  },

  // ---------------- 5. 磁盘水位 ----------------
  {
    id: 'disk_watermark',
    title: '磁盘水位',
    group: '服务',
    scope: 'server',
    why: '磁盘写满会让 Nginx / Docker / 数据库同时出问题，且故障表现千奇百怪，最难排查。',
    async inspect() {
      const { root, disks } = await baotaService.createClient().getDiskInfo();
      const usage = Number(root?.usage ?? 0);
      const severity = usage >= 92 ? 'critical' : usage >= 85 ? 'warning' : 'ok';

      return {
        severity,
        summary:
          severity === 'ok'
            ? `根分区已用 ${usage}%，处于安全水位`
            : `根分区已用 ${usage}%，建议先清理无用镜像`,
        items: disks.map((d) => ({
          name: d.path,
          tag: `${d.used} / ${d.total}（${d.usage}%）`,
          level: d.usage >= 92 ? 'critical' : d.usage >= 85 ? 'warning' : 'ok',
        })),
        fix:
          severity === 'ok'
            ? null
            : {
                label: '清理无用镜像',
                description:
                  '只清 dangling 镜像（<none>:<none>，不承载任何容器，删除零风险）。清理容器卷或站点数据需人工确认。',
                risk: 'low',
                auto: true,
                payload: { danglingOnly: true },
              },
      };
    },
    async apply(payload) {
      const r = await dockerService
        .createClient()
        .pruneImages({ danglingOnly: payload.danglingOnly !== false });
      return {
        message:
          r.deletedCount > 0
            ? `已清理 ${r.deletedCount} 层无用镜像，释放 ${r.reclaimedText}`
            : '没有可清理的无用镜像（说明空间被别的东西占着，需要人工看目录）',
        result: r,
      };
    },
  },

  // ---------------- 7. 内存水位（仅报告） ----------------
  {
    id: 'memory_watermark',
    title: '内存水位',
    group: '服务',
    scope: 'server',
    why: '机器内存打满时，最先被 OOM Killer 干掉的是 Docker / 数据库，表现是「站点突然没了」而 CPU 看着一切正常。',
    async inspect() {
      // 复用 2 分钟一条的采样表：这项要回答的是「水位低了多久」，单次快照说明不了
      const win = memoryWindow(MEMORY_WINDOW_MIN);
      const items = [];
      let severity;
      let summary;

      if (win.samples < 2) {
        // 刚部署 / 采样还没攒够：只用当前快照，并如实说明「暂时判断不了持续性」
        const cur = require('./metrics').snapshot();
        const avail = 100 - (Number(cur.memUsage) || 0);
        severity = avail < 10 ? 'warning' : 'ok';
        summary =
          avail < 10
            ? `可用内存仅剩 ${avail.toFixed(1)}%（采样 ${win.samples} 条，还判断不了是否持续，暂按警告提示）`
            : `可用内存 ${avail.toFixed(1)}%，采样数据还不足 ${MEMORY_WINDOW_MIN} 分钟`;
      } else {
        const avail = 100 - win.maxUsed; // 用窗口内「最坏时刻」判断，而不是平均值
        severity = avail < 10 ? 'critical' : avail < 15 ? 'warning' : 'ok';
        summary =
          severity === 'ok'
            ? `近 ${MEMORY_WINDOW_MIN} 分钟可用内存最低 ${avail.toFixed(1)}%，处于安全水位`
            : `近 ${MEMORY_WINDOW_MIN} 分钟可用内存最低 ${avail.toFixed(1)}%，建议先看是哪个容器在吃内存`;
      }

      // 只在告急时才逐个去问 Docker（这是个要按容器发请求的动作，平时不做）
      if (severity !== 'ok') items.push(...(await topMemoryContainers()));

      return {
        severity,
        summary,
        items,
        // ⚠️ 刻意不提供一键修复：真能立刻释放内存的动作是「重启吃内存的容器」，
        //    那会让对应站点短暂下线，必须由人看着做。
        //    （本项在方案文档里原本写的是「清 dangling 镜像」—— 那是释放磁盘、不是释放内存，已纠正。）
        fix: null,
      };
    },
  },

  // ---------------- 8. 容器重启循环（仅报告） ----------------
  {
    id: 'container_restart_loop',
    title: '容器重启循环',
    group: '服务',
    scope: 'project',
    why: '容器反复「崩溃→重启」会持续吃掉 CPU 与磁盘，而且表现是「能打开一下又断」，比彻底挂掉更难查。',
    async inspect() {
      const docker = dockerService.createClient();
      const all = await docker.listContainers(true);
      const own = all.filter(isOwnContainer);

      const looping = [];
      for (const c of own) {
        // eslint-disable-next-line no-await-in-loop
        const info = await docker.inspectContainer(c.id).catch(() => null);
        const count = Number(info?.RestartCount) || 0;
        if (count < RESTART_LOOP_MIN_COUNT) continue;

        const restarting = info?.State?.Restarting === true;
        const startedAt = info?.State?.StartedAt ? Date.parse(info.State.StartedAt) : 0;
        const startedRecently = startedAt > 0 && Date.now() - startedAt < RESTART_LOOP_WINDOW_MS;
        if (!restarting && !startedRecently) continue;

        // 正在重启中 = 铁证；「累计重启 ≥3 次且最近一小时内启动过」= 近似判断
        looping.push({ name: c.name, count, restarting });
      }

      const critical = looping.filter((c) => c.restarting);
      const severity = critical.length ? 'critical' : looping.length ? 'warning' : 'ok';

      return {
        severity,
        summary: looping.length
          ? `${looping.length} 个本项目容器疑似在重启循环（重启 ${looping
              .map((c) => c.count)
              .join('/')} 次）`
          : `本项目 ${own.length} 个容器没有重启循环迹象`,
        items: looping.map((c) => ({
          name: c.name,
          tag: c.restarting
            ? `正在重启中 · 累计重启 ${c.count} 次`
            : `累计重启 ${c.count} 次，且最近 ${RESTART_LOOP_WINDOW_MS / 60000} 分钟内启动过`,
          level: c.restarting ? 'critical' : 'warning',
        })),
        // ⚠️ 刻意不提供一键修复：这里能做的「修复」只有停容器或改重启策略，
        //    前者等于让站点下线、后者要重建容器 —— 两个都不该自动做。
        //    （方案文档原写「停止重试 + 告警」，改重启策略没有不动容器的 API，已纠正为：只报告 + 进告警。）
        //
        // 关于「近似判断」的取舍：RestartCount 是累计值，用它 + RecentlyStarted 判定
        // 存在一种误报 —— 历史上重启过多次、最近又被人为重启的容器会被提一次。
        // 而漏报的代价是「容器崩到天亮没人知道」。监控里这个方向的取舍是明确的：宁可多一条提醒。
        fix: null,
      };
    },
  },

  // ---------------- 9. 证书链完整性 ----------------
  {
    id: 'ssl_chain',
    title: '证书链完整性',
    group: '安全',
    scope: 'project',
    why: '证书缺中间证书时，桌面 Chrome 能自己补链、看着是好的，但 Android / 小程序 / 老设备会直接报「证书无效」—— 这类问题最容易被拖到最后才发现。',
    async inspect() {
      const facts = (await ownSiteFacts()).filter((f) => f.hasCert);
      const items = [];
      const broken = [];

      for (const f of facts) {
        if (f.certFileMissing) {
          items.push({
            name: f.siteName,
            tag: `配置指向的证书文件读不到：${f.mainCert || '（配置里没有 ssl_certificate）'}`,
            level: 'critical',
          });
          broken.push(f);
        } else if (f.chainCount !== null && f.chainCount < 2) {
          items.push({
            name: f.siteName,
            tag: `证书文件里只有 ${f.chainCount} 张证书，缺中间证书`,
            level: 'warning',
          });
          broken.push(f);
        }
      }

      return {
        severity: items.some((i) => i.level === 'critical')
          ? 'critical'
          : items.length
            ? 'warning'
            : 'ok',
        summary: items.length
          ? `${items.length} 个本项目站点证书链不完整，部分客户端会报证书无效`
          : `本项目 ${facts.length} 个有证书的站点，证书链都完整`,
        items,
        fix: broken.length
          ? {
              label: `重新签发 ${Math.min(broken.length, 10)} 个`,
              description:
                '走 Let’s Encrypt 重新签发（LE 下发的 fullchain 自带中间证书）。只处理本项目自己的站点。',
              risk: 'low',
              auto: true,
              payload: { sites: broken.slice(0, 10).map((f) => f.siteName) },
            }
          : null,
      };
    },
    async apply(payload) {
      const baota = baotaService.createClient();
      const results = [];
      for (const siteName of payload.sites) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const r = await baota.applyLetsEncrypt({ siteName });
          results.push({ siteName, ok: true, message: r.message || '已重新签发' });
        } catch (err) {
          results.push({ siteName, ok: false, message: err.message });
        }
      }
      const okCount = results.filter((r) => r.ok).length;
      return {
        message: `重新签发完成：成功 ${okCount} 个，失败 ${results.length - okCount} 个`,
        results,
      };
    },
  },

  // ---------------- 10. 站点 HTTPS 配置（仅报告） ----------------
  {
    id: 'site_https_config',
    title: '站点 HTTPS 配置',
    group: '安全',
    scope: 'project',
    why: '在宝塔里「证书签好了」和「Nginx 真的挂了证书」是两件事：证书签发完但没点「部署」，站点仍然只监听 80 端口。',
    async inspect() {
      const facts = await ownSiteFacts();
      const items = facts
        .filter((f) => f.hasCert && !f.has443)
        .map((f) => ({
          name: f.siteName,
          tag: '证书已签发，但 Nginx 配置里没有 443 / ssl_certificate 段',
          level: 'warning',
        }));

      return {
        severity: items.length ? 'warning' : 'ok',
        summary: items.length
          ? `${items.length} 个本项目站点签了证书却没配到 Nginx`
          : '本项目站点的 HTTPS 配置与证书状态一致',
        items,
        // ⚠️ 刻意不给一键修复：把证书重新写进 nginx 要读私钥内容再重放、并且会改动站点行为；
        //    宝塔面板里点一下「部署」更稳妥，也更符合「改线上配置先说明」的约定。
        fix: null,
      };
    },
  },

  // ---------------- 11. 站点日志膨胀（仅报告） ----------------
  {
    id: 'log_bloat',
    title: '站点日志膨胀',
    group: '服务',
    scope: 'project',
    why: '访问日志不切割会一直涨，最后把 40G 的盘吃满；而盘满的故障表现千奇百怪，是最难排查的一类。',
    async inspect() {
      const facts = await ownSiteFacts();
      const items = facts
        .filter((f) => f.logBytes >= LOG_BLOAT_WARN_BYTES)
        .sort((a, b) => b.logBytes - a.logBytes)
        .map((f) => ({
          name: f.siteName,
          tag: `日志合计 ${formatMb(f.logBytes)}`,
          level: f.logBytes >= LOG_BLOAT_CRITICAL_BYTES ? 'critical' : 'warning',
        }));

      return {
        severity: items.some((i) => i.level === 'critical')
          ? 'critical'
          : items.length
            ? 'warning'
            : 'ok',
        summary: items.length
          ? `${items.length} 个本项目站点的日志超过 ${LOG_BLOAT_WARN_BYTES / 1024 / 1024}MB`
          : '本项目站点日志体积正常',
        items,
        // ⚠️ 刻意不给一键修复：现在的能力只有「读/写整个文件」，没有安全的 rename / truncate 封装。
        //    硬做等于把几 GB 的日志读进内存再重写 —— 会把这台 2GB 的机器直接拖垮。
        //    正确做法是去宝塔「网站 → 日志」做日志切割。
        fix: null,
      };
    },
  },

  // ---------------- 12. DNS 解析缺失 ----------------
  {
    id: 'dns_drift',
    title: 'DNS 解析缺失',
    group: '安全',
    scope: 'project',
    why: '站点域名在本项目的 Cloudflare 区域里没有解析记录时，一个原因会表现成两个故障：域名失效 + 证书签发失败（LE 要靠解析校验）。',
    async inspect() {
      const pairs = await ownDomainsToSites();
      const zones = await listOwnZones();
      const missing = [];

      for (const z of zones) {
        // eslint-disable-next-line no-await-in-loop -- 逐区域取记录，本项目区域只有个位数
        const recs = await cloudflareService
          .createClient()
          .listDnsRecords(z.id)
          .catch(() => []);
        const names = new Set(
          recs
            .filter((r) => ['A', 'AAAA', 'CNAME'].includes(String(r.type).toUpperCase()))
            .map((r) => String(r.name).toLowerCase())
        );
        pairs.forEach(({ domain, siteName }) => {
          const inZone = z.name === domain || domain.endsWith(`.${z.name}`);
          if (inZone && !names.has(domain.toLowerCase()))
            missing.push({ domain, siteName, zoneId: z.id });
        });
      }

      const publicIp = settings.get('server_public_ip');
      return {
        severity: missing.length ? 'warning' : 'ok',
        summary: missing.length
          ? `${missing.length} 个本项目站点域名在本项目的 Cloudflare 区域里没有解析记录`
          : `本项目 ${pairs.length} 个站点域名解析都在`,
        items: missing.map((m) => ({
          name: m.domain,
          tag: `区域里没有 A / AAAA / CNAME 记录（站点 ${m.siteName}）`,
          level: 'warning',
        })),
        fix:
          missing.length && publicIp
            ? {
                label: `补 ${missing.length} 条 A 记录`,
                description: `把这些域名解析到本机公网 IP ${publicIp} 并开启橙色云代理。只在本项目的区域里新增，不动其他记录。`,
                risk: 'medium',
                // 改 DNS 会直接影响可达性，属于「先说明再动手」的动作，所以不参与自动自愈
                auto: false,
                payload: { records: missing.map((m) => ({ zoneId: m.zoneId, domain: m.domain })) },
              }
            : null,
      };
    },
    async apply(payload) {
      const cf = cloudflareService.createClient();
      const ip = settings.get('server_public_ip');
      const results = [];
      for (const r of payload.records) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await cf.createDnsRecord(r.zoneId, {
            type: 'A',
            name: r.domain,
            content: ip,
            proxied: true,
            comment: '由艾哥SaaS工作台自愈补建',
          });
          results.push({ siteName: r.domain, ok: true, message: `已解析到 ${ip}` });
        } catch (err) {
          results.push({ siteName: r.domain, ok: false, message: err.message });
        }
      }
      const okCount = results.filter((r) => r.ok).length;
      return {
        message: `补记录完成：成功 ${okCount} 条，失败 ${results.length - okCount} 条`,
        results,
      };
    },
  },

  // ---------------- 13. CF 缓存漂移 ----------------
  {
    id: 'cf_cache_drift',
    title: 'Cloudflare 缓存漂移',
    group: '安全',
    scope: 'project',
    why: '站点改版后，如果发布前没刷新边缘缓存，就会「本地好好的、线上白屏」—— 因为浏览器拿到的是旧 HTML 配新文件名，或者干脆把 HTML 当成 js 返回。',
    async inspect() {
      // 站点多的时候逐个探测会很慢，这里最多看 3 个（够发现系统性问题了）
      const facts = (await ownSiteFacts()).filter((f) => f.hasCert && f.has443).slice(0, 3);
      if (!facts.length) {
        return {
          severity: 'ok',
          summary: '没有可探测的 HTTPS 站点（无证书或未配 443）',
          items: [],
          fix: null,
        };
      }

      const probes = await Promise.all(
        facts.map((f) => probeStaticAsset(f.domains[0]).catch(() => null))
      );
      const drifted = probes.filter((p) => p && p.drift);

      return {
        severity: drifted.length ? 'critical' : 'ok',
        summary: drifted.length
          ? `${drifted.length} 个站点引用的静态资源取回来不是 JS/CSS（很可能是把 HTML 当资源返回，页面会白屏）`
          : `探测了 ${probes.filter(Boolean).length} 个站点，静态资源类型都正常`,
        items: drifted.map((p) => ({
          name: p.domain,
          tag: p.missing
            ? `资源 ${p.assetUrl} 返回 ${p.status}`
            : `资源被当成 ${p.contentType} 返回（CF 缓存：${p.cfCacheStatus || '未知'}）`,
          level: 'critical',
        })),
        fix: drifted.length
          ? {
              label: `清 ${drifted.length} 个漂移资源`,
              description:
                '只清这几个具体的资源 URL（Cloudflare 按 URL 精确清理），**不做全量清理** —— 全量会波及该区域下其他项目的缓存。',
              risk: 'low',
              auto: true,
              payload: { urls: drifted.map((p) => p.assetUrl) },
            }
          : null,
      };
    },
    async apply(payload) {
      const cf = cloudflareService.createClient();
      const zones = await listOwnZones();
      const results = [];
      for (const url of payload.urls) {
        // 找到这个 URL 所属的区域（本项目区域里最长匹配那个）
        const host = (() => {
          try {
            return new URL(url).hostname.toLowerCase();
          } catch {
            return '';
          }
        })();
        const zone = zones
          .filter((z) => host === z.name || host.endsWith(`.${z.name}`))
          .sort((a, b) => b.name.length - a.name.length)[0];

        if (!zone) {
          results.push({
            siteName: url,
            ok: false,
            message: '该 URL 不在本项目的 Cloudflare 区域里，已跳过（不越界操作）',
          });
          continue;
        }
        try {
          // eslint-disable-next-line no-await-in-loop
          await cf.purgeCache(zone.id, { urls: [url] });
          results.push({ siteName: url, ok: true, message: `已提交清理（区域 ${zone.name}）` });
        } catch (err) {
          results.push({ siteName: url, ok: false, message: err.message });
        }
      }
      const okCount = results.filter((r) => r.ok).length;
      return {
        message: `缓存清理：成功 ${okCount} 个，失败 ${results.length - okCount} 个`,
        results,
      };
    },
  },

  // ---------------- 14. 账号与令牌弱口令自查（仅报告） ----------------
  {
    id: 'weak_credentials',
    title: '登录口令与令牌',
    group: '安全',
    scope: 'project',
    why: '面板直接暴露在公网，弱口令是最容易被撞的入口；这里只做自查提示，不会替你改密码。',
    async inspect() {
      const items = [];

      // 默认口令自检（只对比哈希，不落明文）
      const defaults = [
        ['elyac123456', '默认口令 elyac123456 仍在使用'],
        ['admin888', '历史默认口令 admin888 仍在使用'],
      ];
      const users = db.prepare('SELECT username, password FROM users').all();
      for (const u of users) {
        for (const [plain, label] of defaults) {
          if (bcrypt.compareSync(plain, u.password)) {
            items.push({ name: u.username, tag: label, level: 'warning' });
          }
        }
      }

      // MCP 令牌是否已配置
      const token = settings.get('mcp_auth_token');
      if (!token)
        items.push({
          name: 'MCP 令牌',
          tag: '尚未生成，MCP 服务当前允许匿名连接',
          level: 'critical',
        });

      return {
        severity: items.some((i) => i.level === 'critical')
          ? 'critical'
          : items.length
            ? 'warning'
            : 'ok',
        summary: items.length ? `${items.length} 项口令/令牌需要处理` : '口令与令牌配置正常',
        items,
        // 不改密码：改了用户立刻登不上，必须由人自己在「系统设置」里做
        fix: null,
      };
    },
  },
];

// ============================================================
// 执行
// ============================================================

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2, ok: 3, unknown: 4 };

/**
 * 把巡检结论同步成告警
 * ------------------------------------------------------------------
 * · critical / warning → 产生（或累加）告警，指纹 health:<checkId>
 * · ok                 → 自动把该告警标记为已解决（问题消失了就该消失）
 * · info / unknown     → 不产生告警（info 多是「其他项目站点」这类只报告项，
 *                        每次巡检都提醒会变成噪音）
 *
 * 用 raiseDetached 而不是 await：外发 webhook 最长要等 10 秒超时，
 * 在这里 await 会把 /api/inspect 拖慢（监控不能反过来拖垮主流程）。
 */
function syncAlerts(checks) {
  for (const c of checks) {
    const fingerprint = `health:${c.id}`;

    if (c.severity === 'critical' || c.severity === 'warning') {
      notify.raiseDetached({
        fingerprint,
        level: c.severity,
        source: 'health',
        title: `${c.title}：${c.summary}`,
        detail: (c.items || [])
          .slice(0, 8)
          .map((i) => `· ${i.name} ${i.tag}`)
          .join('\n'),
      });
    } else if (c.severity === 'ok') {
      notify.resolve(fingerprint);
    }
  }
}

/**
 * 跑一遍全部检查（或指定检查）
 * 单项失败不影响其他项：每一项都独立 try/catch，坏掉的项会显式标 unknown
 */
async function runChecks({ only } = {}) {
  const targets = only && only.length ? CHECKS.filter((c) => only.includes(c.id)) : CHECKS;

  // 每次巡检开跑先清缓存：同一次内共享（省重复读取），跨次不共享（避免修复后拿到旧数据）
  runMemo = new Map();

  const checks = await Promise.all(
    targets.map(async (c) => {
      const startedAt = Date.now();
      try {
        const r = await c.inspect();
        return {
          id: c.id,
          title: c.title,
          group: c.group,
          scope: c.scope,
          why: c.why,
          severity: r.severity || 'unknown',
          summary: r.summary || '',
          items: r.items || [],
          fix: r.fix || null,
          budget: fixBudget(c.id),
          elapsedMs: Date.now() - startedAt,
        };
      } catch (err) {
        return {
          id: c.id,
          title: c.title,
          group: c.group,
          scope: c.scope,
          why: c.why,
          severity: 'unknown',
          summary: `巡检失败：${err.message}`,
          items: [],
          fix: null,
          budget: fixBudget(c.id),
          error: err.message,
          elapsedMs: Date.now() - startedAt,
        };
      }
    })
  );

  checks.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));

  // 结论同步成告警（用 detached，不拖慢本接口）
  syncAlerts(checks);

  const summary = {
    total: checks.length,
    critical: checks.filter((c) => c.severity === 'critical').length,
    warning: checks.filter((c) => c.severity === 'warning').length,
    info: checks.filter((c) => c.severity === 'info').length,
    ok: checks.filter((c) => c.severity === 'ok').length,
    unknown: checks.filter((c) => c.severity === 'unknown').length,
    fixable: checks.filter((c) => c.fix).length,
  };

  return { checks, summary, checkedAt: new Date().toLocaleString('zh-CN') };
}

/**
 * 执行一次修复
 * @param {string} checkId 注册表里的检查项 id
 * @param {object} [actor] { userId, username, source, ip } 用于审计留痕
 */
async function applyFix(checkId, actor = {}) {
  const check = CHECKS.find((c) => c.id === checkId);
  if (!check)
    throw badRequest(`未知的检查项：${checkId}（可用：${CHECKS.map((c) => c.id).join(', ')}）`);
  if (typeof check.apply !== 'function') throw badRequest(`「${check.title}」没有可执行的修复动作`);

  assertFixBudget(check.id, check.title);

  // 每次修复前重新探测一次，避免拿过期快照去修（状态可能已经变了）
  const inspected = await check.inspect();
  if (!inspected.fix) throw badRequest(`「${check.title}」当前没有需要修复的问题`);

  recordFixAttempt(check.id);
  const startedAt = Date.now();
  let result = null;
  let failure = null;

  try {
    result = await check.apply(inspected.fix.payload);
  } catch (err) {
    failure = err;
  }

  const elapsedMs = Date.now() - startedAt;
  writeLog({
    userId: actor.userId,
    username: actor.username,
    module: 'health',
    action: `fix_${check.id}`,
    target:
      (inspected.items || [])
        .slice(0, 5)
        .map((i) => i.name)
        .join(', ') || check.title,
    source: actor.source || 'system',
    status: failure ? 'failed' : 'success',
    message: failure ? `自愈失败：${failure.message}` : result?.message || '自愈完成',
    detail: {
      checkId: check.id,
      action: inspected.fix.label,
      risk: inspected.fix.risk,
      elapsedMs,
      result: result || undefined,
    },
    ip: actor.ip,
  });

  if (failure) {
    // 修复失败要单独告警：这类问题「自动修也修不好」，必须让人看到
    notify.raiseDetached({
      fingerprint: `health:${check.id}:fix`,
      level: 'critical',
      source: 'health',
      title: `自愈失败：${check.title}`,
      detail: `尝试「${inspected.fix.label}」失败：${failure.message}`,
    });
    throw failure;
  }

  // 修复成功 → 把该项的告警一并解决（下一次巡检也会自动解决，这里只是让状态立刻正确）
  notify.resolve(`health:${check.id}`);
  notify.resolve(`health:${check.id}:fix`);

  return {
    checkId: check.id,
    title: check.title,
    action: inspected.fix.label,
    elapsedMs,
    budget: fixBudget(check.id),
    ...result,
  };
}

// ============================================================
// 自动自愈（默认关闭；只执行 fix.auto === true 的项）
// ============================================================

const AUTO_KEY = 'auto_heal_enabled';
const AUTO_INTERVAL_KEY = 'auto_heal_interval_min';
const DEFAULT_INTERVAL_MIN = 60;
const MIN_INTERVAL_MIN = 10;

/** 读取自动自愈配置 */
function getAutoHeal() {
  const enabled = settings.get(AUTO_KEY) === 'true';
  const raw = Number(settings.get(AUTO_INTERVAL_KEY));
  const intervalMin =
    Number.isFinite(raw) && raw >= MIN_INTERVAL_MIN ? Math.floor(raw) : DEFAULT_INTERVAL_MIN;
  return { enabled, intervalMin, minIntervalMin: MIN_INTERVAL_MIN };
}

/** 保存自动自愈配置 */
function setAutoHeal({ enabled, intervalMin }) {
  if (enabled !== undefined) settings.set(AUTO_KEY, enabled ? 'true' : 'false');
  if (intervalMin !== undefined) {
    const n = Number(intervalMin);
    if (!Number.isFinite(n) || n < MIN_INTERVAL_MIN)
      throw badRequest(`巡检间隔不能小于 ${MIN_INTERVAL_MIN} 分钟`);
    settings.set(AUTO_INTERVAL_KEY, String(Math.floor(n)));
  }
  return getAutoHeal();
}

/** 最近一次自动自愈的结果（内存态，供页面展示） */
let lastAutoRun = null;

/**
 * 跑一轮自动自愈：只执行标记 auto 的修复，且受熔断约束
 * @returns {Promise<object>} 本轮结果
 */
async function runAutoHeal() {
  const startedAt = Date.now();
  const { checks } = await runChecks();
  const applied = [];
  const skipped = [];

  for (const c of checks) {
    if (!c.fix) continue;
    if (!c.fix.auto) {
      skipped.push({ id: c.id, title: c.title, reason: '该修复风险较高，需人工确认' });
      continue;
    }
    if (c.budget.remaining <= 0) {
      skipped.push({
        id: c.id,
        title: c.title,
        reason: `已达熔断上限（${c.budget.limit} 次 / ${c.budget.windowMinutes} 分钟）`,
      });
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await applyFix(c.id, { source: 'system' });
      applied.push({ id: c.id, title: c.title, message: r.message });
    } catch (err) {
      applied.push({ id: c.id, title: c.title, message: `失败：${err.message}`, ok: false });
    }
  }

  lastAutoRun = {
    at: new Date().toLocaleString('zh-CN'),
    elapsedMs: Date.now() - startedAt,
    applied,
    skipped,
  };
  return lastAutoRun;
}

// ============================================================
// 事件驱动自愈（C2 · 与自动自愈同生共死）
// ------------------------------------------------------------------
// 定时巡检最快也要等一个周期（默认 60 分钟）才发现容器崩了；实际应该「立刻」知道。
// 这里订阅 Docker 事件的 container die：一收到就针对 container_down 跑一次修复。
//
// 三重防护，避免「崩溃 → 重启 → 再崩溃」把机器拖死：
//   1. **沿用同一套熔断**：applyFix 内部 30 分钟最多 3 次，超限自动停手（并已告警）。
//   2. **同容器冷却**：同一个容器 3 分钟内只触发一次（一次崩溃可能连发多条事件）。
//   3. **全局防抖**：任意两次触发之间至少间隔 10 秒，事件风暴不会打满 CPU。
// 白名单同样生效：只有本项目自己的容器才会被处理，其他项目容器一律不碰。
// 这条链路只在「自动自愈」开关打开时才接上（默认关），关闭时立即断开。
// ============================================================

const EVENT_RECONNECT_MS = 15000; // 断线后多久重连
const EVENT_DEBOUNCE_MS = 10 * 1000; // 全局两次触发最小间隔
const EVENT_PER_CONTAINER_MS = 3 * 60 * 1000; // 同一容器的最小触发间隔

let eventHandle = null;
let eventReconnectTimer = null;
let lastEventTriggerAt = 0;
const eventCooldown = new Map(); // 容器名 → 上次触发时间
const eventStatus = {
  running: false,
  lastEventAt: null,
  lastEventName: null,
  lastTriggerAt: null,
  triggers: 0,
  lastError: null,
};

/** 断开事件流（幂等） */
function stopEventHealing() {
  if (eventReconnectTimer) {
    clearTimeout(eventReconnectTimer);
    eventReconnectTimer = null;
  }
  if (eventHandle) {
    try {
      eventHandle.close();
    } catch {
      /* 已经断了，忽略 */
    }
    eventHandle = null;
  }
  eventStatus.running = false;
}

/** 安排一次重连（自动自愈关着的时候不重连） */
function scheduleEventReconnect() {
  if (eventReconnectTimer) return; // 已有重连计划
  if (!getAutoHeal().enabled) return;
  eventReconnectTimer = setTimeout(() => {
    eventReconnectTimer = null;
    connectEventStream().catch((err) => {
      eventStatus.lastError = err.message;
      console.error(`[health] 重连 Docker 事件流失败：${err.message}`);
      scheduleEventReconnect();
    });
  }, EVENT_RECONNECT_MS);
  eventReconnectTimer.unref?.();
}

/** 一个 die 事件的处理：过滤 → 防抖 → 冷却 → 交给 container_down 修复 */
function onDockerEvent(evt) {
  try {
    if (evt?.Type !== 'container' || evt?.Action !== 'die') return;
    const attrs = evt.Actor?.Attributes || {};
    const name = String(attrs.name || '');

    eventStatus.lastEventAt = new Date().toLocaleString('zh-CN');
    eventStatus.lastEventName = name;

    // 白名单：只有本项目自己的容器才处理（与 container_down 判定口径一致）
    const own = OWN_CONTAINERS.includes(name) || attrs['aige.managed'] === 'true';
    if (!own) return;

    const now = Date.now();
    if (now - lastEventTriggerAt < EVENT_DEBOUNCE_MS) return; // 全局防抖
    if (now - (eventCooldown.get(name) || 0) < EVENT_PER_CONTAINER_MS) return; // 同容器冷却

    lastEventTriggerAt = now;
    eventStatus.lastTriggerAt = new Date().toLocaleString('zh-CN');
    eventCooldown.set(name, now);
    eventStatus.triggers += 1;

    // 立刻针对「容器未运行」跑一次修复：内部有熔断，且修复前会重新探测 ——
    // 若容器已被 restart 策略自动拉起，这里会以「无需修复」结束，不会多此一举。
    applyFix('container_down', { source: 'system' })
      .then((r) => console.log(`[health] 事件自愈：${name} → ${r.message}`))
      .catch((err) => {
        // 熔断 / 无需修复 / 修复失败都走这里：只记日志，绝不影响主流程
        console.log(`[health] 事件自愈（${name}）未执行：${err.message}`);
      });
  } catch (err) {
    console.error('[health] 处理 Docker 事件失败：', err.message);
  }
}

/** 接入 Docker 事件流（单例：先断开旧的再连） */
async function connectEventStream() {
  stopEventHealing();
  const handle = await dockerService.createClient().streamEvents(onDockerEvent, {
    filters: { type: ['container'], event: ['die'] },
    onError: (err) => {
      eventStatus.running = false;
      eventStatus.lastError = err.message;
      scheduleEventReconnect();
    },
    onEnd: () => {
      eventStatus.running = false;
      scheduleEventReconnect();
    },
  });
  eventHandle = handle;
  eventStatus.running = true;
  eventStatus.lastError = null;
  console.log('[health] 已接入 Docker 事件流（事件驱动自愈已就绪）');
}

/** 定时器句柄（单例） */
let timer = null;

/** 启动/停止自动自愈定时器（改配置后调用即可） */
function syncAutoHealTimer() {
  const { enabled, intervalMin } = getAutoHeal();
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (!enabled) {
    // 关掉定时自愈时，事件驱动自愈也一并断开（两者同生共死）
    stopEventHealing();
    return { running: false, ...getAutoHeal() };
  }

  // 启动后先延迟一轮，避免和容器刚起来的自检动作挤在一起
  timer = setInterval(
    () => {
      runAutoHeal().catch((err) => console.error('[health] 自动自愈异常：', err.message));
    },
    intervalMin * 60 * 1000
  );
  if (timer.unref) timer.unref();

  // 接入事件流：容器 die 的瞬间就处理，不必等下一次巡检
  if (!eventStatus.running) {
    connectEventStream().catch((err) => {
      eventStatus.lastError = err.message;
      console.error(`[health] 接入 Docker 事件流失败：${err.message}`);
      scheduleEventReconnect();
    });
  }

  return { running: true, ...getAutoHeal() };
}

/**
 * 页面用的完整状态
 * ⚠️ 这里的静态清单必须叫 checkCatalog，**不能叫 checks** ——
 *    `GET /api/inspect` 会把本函数的返回值展开到 runChecks() 的结果上，
 *    如果这里也用 `checks`，就会用「只有 id/title 的静态元数据」把
 *    「带 severity/summary/fix 的巡检结果」整个覆盖掉（实测踩过）。
 */
function getStatus() {
  const cfg = getAutoHeal();
  return {
    autoHeal: { ...cfg, running: !!timer },
    // 事件驱动自愈的运行状态（与 autoHeal 开关联动）
    eventHealing: { ...eventStatus },
    lastAutoRun,
    checkCatalog: CHECKS.map((c) => ({
      id: c.id,
      title: c.title,
      group: c.group,
      scope: c.scope,
      why: c.why,
    })),
  };
}

module.exports = {
  CHECKS,
  runChecks,
  applyFix,
  runAutoHeal,
  getAutoHeal,
  setAutoHeal,
  syncAutoHealTimer,
  getStatus,
  OWN_CONTAINERS,
};
