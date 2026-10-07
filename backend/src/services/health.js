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
      const zones = await cf.listZones();
      const certData = await listSslCertsShared();

      const items = [];
      for (const z of zones) {
        // 只看与本站点相关的 zone；无关 zone（别的项目/别的域名）连读都不读
        if (!OWN_ZONE_SUFFIXES.some((suffix) => z.name === suffix || z.name.endsWith(`.${suffix}`)))
          continue;

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

  // ---------------- 6. 账号与令牌弱口令自查（仅报告） ----------------
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

/** 定时器句柄（单例） */
let timer = null;

/** 启动/停止自动自愈定时器（改配置后调用即可） */
function syncAutoHealTimer() {
  const { enabled, intervalMin } = getAutoHeal();
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (!enabled) return { running: false, ...getAutoHeal() };

  // 启动后先延迟一轮，避免和容器刚起来的自检动作挤在一起
  timer = setInterval(
    () => {
      runAutoHeal().catch((err) => console.error('[health] 自动自愈异常：', err.message));
    },
    intervalMin * 60 * 1000
  );
  if (timer.unref) timer.unref();

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
