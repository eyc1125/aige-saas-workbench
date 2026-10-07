/**
 * 应用商店 · 预置部署模板
 * ------------------------------------------------------------------
 * 每个模板是一份「可被程序执行的容器编排描述」，部署服务（deploy.js）会：
 *   替换占位符 → 拉镜像 → 建容器 → 起容器 → 配域名 → 配反向代理 → 申 SSL
 *
 * 占位符语法（部署时统一替换）：
 *   {{domain}}              目标域名，如 kuma.example.com
 *   {{appUrl}}              完整访问地址，如 https://kuma.example.com
 *   {{secret:NAME}}         模板 secrets 里定义的随机密钥
 *   {{serviceHost:NAME}}    同一模板里某个服务的容器名（容器间互访用）
 *   {{random:32}}           临时生成 32 位随机串（不共享时用）
 *
 * 说明：图标使用「字母标记 + 品牌色」的纯本地方案，不引外部图片，避免图床失效。
 */
'use strict';

const TEMPLATES = [
  // ============================================================
  {
    key: 'uptime-kuma',
    name: 'Uptime Kuma',
    title: '服务运行监控',
    description: '开源自托管监控系统，可监控站点、端口、心跳、证书到期，支持告警到微信/钉钉/邮件。',
    category: '监控告警',
    color: '#16A34A',
    iconText: 'UK',
    tags: ['监控', '告警', '轻量'],
    recommendMemory: '256 MB',
    docsUrl: 'https://github.com/louislam/uptime-kuma',
    notes: ['首次打开需要创建管理员账号', '数据保存在宿主机应用数据目录，删容器不丢数据'],
    secrets: {},
    services: [
      {
        name: 'app',
        image: 'louislam/uptime-kuma:1',
        containerPort: 3001,
        primary: true,
        volumes: [{ container: '/app/data', subdir: 'data' }],
        env: {
          TZ: 'Asia/Shanghai',
          UPTIME_KUMA_DISABLE_STATS: 'true',
        },
      },
    ],
  },

  // ============================================================
  {
    key: 'n8n',
    name: 'n8n',
    title: '自动化工作流',
    description: '开源工作流自动化平台，400+ 节点连接各类服务，适合做数据同步、通知机器人、定时任务。',
    category: '自动化',
    color: '#EA4B71',
    iconText: 'n8n',
    tags: ['工作流', '自动化', '低代码'],
    recommendMemory: '512 MB',
    docsUrl: 'https://docs.n8n.io/',
    notes: ['首次打开需要设置所有者账号', '已自动关闭 Secure Cookie，便于反代后直接登录'],
    secrets: {
      // n8n 用这个密钥加密保存的凭据，务必稳定，重装会失效
      N8N_ENCRYPTION_KEY: 'random:32',
      N8N_BASIC_AUTH_PASSWORD: 'random:16',
    },
    services: [
      {
        name: 'app',
        image: 'n8nio/n8n:latest',
        containerPort: 5678,
        primary: true,
        volumes: [{ container: '/home/node/.n8n', subdir: 'data' }],
        env: {
          TZ: 'Asia/Shanghai',
          GENERIC_TIMEZONE: 'Asia/Shanghai',
          N8N_HOST: '{{domain}}',
          N8N_PROTOCOL: 'https',
          N8N_PORT: '5678',
          WEBHOOK_URL: '{{appUrl}}/',
          // 反向代理后走 https，关掉 Secure Cookie 限制避免登录后反复掉线
          N8N_SECURE_COOKIE: 'false',
          N8N_ENCRYPTION_KEY: '{{secret:N8N_ENCRYPTION_KEY}}',
          N8N_BASIC_AUTH_ACTIVE: 'false',
          N8N_DIAGNOSTICS_ENABLED: 'false',
        },
      },
    ],
  },

  // ============================================================
  {
    key: 'nocodb',
    name: 'NocoDB',
    title: '开源表格数据库',
    description: '把任何数据库变成智能电子表格，支持表单、看板、视图、API，Airtable 的开源替代。',
    category: '数据协作',
    color: '#0E7490',
    iconText: 'NC',
    tags: ['表格', '数据库', '协作'],
    recommendMemory: '512 MB',
    docsUrl: 'https://docs.nocodb.com/',
    notes: ['默认使用内置 SQLite，数据存于宿主机应用数据目录', '也可改 NC_DB 环境变量接入外部 MySQL/PostgreSQL'],
    secrets: {},
    services: [
      {
        name: 'app',
        image: 'nocodb/nocodb:latest',
        containerPort: 8080,
        primary: true,
        volumes: [{ container: '/usr/app/data', subdir: 'data' }],
        env: {
          TZ: 'Asia/Shanghai',
          NC_PUBLIC_URL: '{{appUrl}}',
          NC_DISABLE_TELE: 'true',
        },
      },
    ],
  },

  // ============================================================
  {
    key: 'wordpress',
    name: 'WordPress',
    title: 'WordPress 建站',
    description: '全球最流行的建站系统，一键部署 WordPress + MySQL 双容器，自动配置数据库连接。',
    category: '建站',
    color: '#21759B',
    iconText: 'WP',
    tags: ['CMS', '博客', '建站'],
    recommendMemory: '768 MB',
    docsUrl: 'https://cn.wordpress.org/',
    notes: ['包含 MySQL 8 数据库容器，数据各自持久化到宿主机', '数据库密码自动生成，可到容器环境变量中查看'],
    secrets: {
      DB_PASSWORD: 'random:24',
      DB_ROOT_PASSWORD: 'random:28',
    },
    services: [
      {
        name: 'db',
        image: 'mysql:8.0',
        internal: true, // 不对外暴露端口，仅供 web 容器内网访问
        volumes: [{ container: '/var/lib/mysql', subdir: 'mysql' }],
        env: {
          TZ: 'Asia/Shanghai',
          MYSQL_ROOT_PASSWORD: '{{secret:DB_ROOT_PASSWORD}}',
          MYSQL_DATABASE: 'wordpress',
          MYSQL_USER: 'wordpress',
          MYSQL_PASSWORD: '{{secret:DB_PASSWORD}}',
        },
      },
      {
        name: 'web',
        image: 'wordpress:6.5-php8.2-apache',
        containerPort: 80,
        primary: true,
        volumes: [{ container: '/var/www/html', subdir: 'html' }],
        env: {
          TZ: 'Asia/Shanghai',
          WORDPRESS_DB_HOST: '{{serviceHost:db}}:3306',
          WORDPRESS_DB_NAME: 'wordpress',
          WORDPRESS_DB_USER: 'wordpress',
          WORDPRESS_DB_PASSWORD: '{{secret:DB_PASSWORD}}',
          // 让站点地址跟随域名，避免装完跳回 http://localhost
          WORDPRESS_CONFIG_EXTRA: "define('WP_HOME','{{appUrl}}');define('WP_SITEURL','{{appUrl}}');",
        },
      },
    ],
  },

  // ============================================================
  {
    key: 'dify',
    name: 'Dify',
    title: 'LLM 应用开发平台',
    description: '开源的 LLM 应用编排平台，支持 RAG 知识库、Agent、工作流编排，可对接多种大模型。',
    category: 'AI 平台',
    color: '#4F46E5',
    iconText: 'DF',
    tags: ['AI', 'LLM', 'RAG', '重量级'],
    recommendMemory: '4 GB+',
    docsUrl: 'https://docs.dify.ai/',
    notes: [
      '⚠️ 该应用为多容器架构（6 个服务），建议服务器内存 4 GB 以上，首次启动约需 2-5 分钟',
      '部署后请进入容器环境变量补充你的大模型 API Key（如 OpenAI / 通义千问）',
      '如需更换版本，可在模板里统一修改镜像 tag',
    ],
    secrets: {
      DB_PASSWORD: 'random:24',
      SECRET_KEY: 'random:48',
      INIT_PASSWORD: 'random:16',
    },
    services: [
      {
        name: 'db',
        image: 'postgres:15-alpine',
        internal: true,
        volumes: [{ container: '/var/lib/postgresql/data', subdir: 'postgres' }],
        env: {
          TZ: 'Asia/Shanghai',
          POSTGRES_DB: 'dify',
          POSTGRES_USER: 'postgres',
          POSTGRES_PASSWORD: '{{secret:DB_PASSWORD}}',
          PGDATA: '/var/lib/postgresql/data/pgdata',
        },
      },
      {
        name: 'redis',
        image: 'redis:6-alpine',
        internal: true,
        volumes: [{ container: '/data', subdir: 'redis' }],
        env: { TZ: 'Asia/Shanghai' },
      },
      {
        name: 'weaviate',
        image: 'semitechnologies/weaviate:1.19.0',
        internal: true,
        volumes: [{ container: '/var/lib/weaviate', subdir: 'weaviate' }],
        env: {
          TZ: 'Asia/Shanghai',
          PERSISTENCE_DATA_PATH: '/var/lib/weaviate',
          DEFAULT_VECTORIZER_MODULE: 'none',
          AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED: 'true',
          CLUSTER_HOSTNAME: 'node1',
        },
      },
      {
        name: 'api',
        image: 'langgenius/dify-api:0.6.15',
        internal: true,
        volumes: [{ container: '/app/api/storage', subdir: 'storage' }],
        env: {
          TZ: 'Asia/Shanghai',
          MODE: 'api',
          LOG_LEVEL: 'INFO',
          SECRET_KEY: '{{secret:SECRET_KEY}}',
          INIT_PASSWORD: '{{secret:INIT_PASSWORD}}',
          DB_USERNAME: 'postgres',
          DB_PASSWORD: '{{secret:DB_PASSWORD}}',
          DB_HOST: '{{serviceHost:db}}',
          DB_PORT: '5432',
          DB_DATABASE: 'dify',
          REDIS_HOST: '{{serviceHost:redis}}',
          REDIS_PORT: '6379',
          REDIS_DB: '0',
          VECTOR_STORE: 'weaviate',
          WEAVIATE_ENDPOINT: 'http://{{serviceHost:weaviate}}:8080',
          CONSOLE_API_URL: '{{appUrl}}',
          CONSOLE_WEB_URL: '{{appUrl}}',
          SERVICE_API_URL: '{{appUrl}}',
          APP_WEB_URL: '{{appUrl}}',
          STORAGE_TYPE: 'local',
        },
      },
      {
        name: 'worker',
        image: 'langgenius/dify-api:0.6.15',
        internal: true,
        volumes: [{ container: '/app/api/storage', subdir: 'storage' }],
        env: {
          TZ: 'Asia/Shanghai',
          MODE: 'worker',
          LOG_LEVEL: 'INFO',
          SECRET_KEY: '{{secret:SECRET_KEY}}',
          DB_USERNAME: 'postgres',
          DB_PASSWORD: '{{secret:DB_PASSWORD}}',
          DB_HOST: '{{serviceHost:db}}',
          DB_PORT: '5432',
          DB_DATABASE: 'dify',
          REDIS_HOST: '{{serviceHost:redis}}',
          REDIS_PORT: '6379',
          REDIS_DB: '0',
          VECTOR_STORE: 'weaviate',
          WEAVIATE_ENDPOINT: 'http://{{serviceHost:weaviate}}:8080',
          STORAGE_TYPE: 'local',
        },
      },
      {
        name: 'web',
        image: 'langgenius/dify-web:0.6.15',
        containerPort: 3000,
        primary: true, // 反向代理指向 Web 控制台
        env: {
          TZ: 'Asia/Shanghai',
          CONSOLE_API_URL: '{{appUrl}}',
          APP_API_URL: '{{appUrl}}',
        },
      },
    ],
  },
];

/** 按 key 找模板 */
function getTemplate(key) {
  return TEMPLATES.find((t) => t.key === key) || null;
}

/** 给前端用的精简列表（不含 services 明细，避免前端拿到内部编排） */
function listTemplates() {
  return TEMPLATES.map((t) => ({
    key: t.key,
    name: t.name,
    title: t.title,
    description: t.description,
    category: t.category,
    color: t.color,
    iconText: t.iconText,
    tags: t.tags,
    recommendMemory: t.recommendMemory,
    docsUrl: t.docsUrl,
    notes: t.notes,
    serviceCount: t.services.length,
    defaultPort: t.services.find((s) => s.primary)?.containerPort || null,
  }));
}

/** 完整的 docker-compose 文本（用于「查看编排」与手动部署兜底） */
function toComposeYaml(key) {
  const tpl = getTemplate(key);
  if (!tpl) return null;

  const lines = [
    '# ============================================================',
    `# ${tpl.name} · 由「艾哥SaaS工作台」应用商店生成`,
    '# 说明：工作台内部通过 Docker API 直接创建容器，本文件仅作参考/手工部署兜底',
    '# ============================================================',
    'services:',
  ];
  tpl.services.forEach((svc) => {
    lines.push(`  ${svc.name}:`);
    lines.push(`    image: ${svc.image}`);
    lines.push('    restart: unless-stopped');
    if (svc.containerPort) {
      lines.push('    ports:');
      lines.push(`      - "${svc.containerPort}:${svc.containerPort}"`);
    }
    if (svc.env && Object.keys(svc.env).length) {
      lines.push('    environment:');
      Object.entries(svc.env).forEach(([k, v]) => lines.push(`      - ${k}=${v}`));
    }
    if (svc.volumes?.length) {
      lines.push('    volumes:');
      svc.volumes.forEach((v) => lines.push(`      - ./${svc.subdir}:${v.container}`));
    }
  });
  return lines.join('\n');
}

module.exports = { TEMPLATES, getTemplate, listTemplates, toComposeYaml };
