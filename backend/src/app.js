/**
 * Express 应用装配
 * ------------------------------------------------------------------
 * 顺序很重要：安全头 → CORS → 限流 → 请求体解析 → 业务路由 → 静态前端 → 404 → 错误处理
 */
'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const routes = require('./routes');
const { generalLimiter } = require('./middleware/rateLimit');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const app = express();

// 部署在宝塔 Nginx 反向代理之后，必须信任代理才能拿到真实客户端 IP
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ---------------- 安全响应头 ----------------
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// ---------------- CORS ----------------
// 生产环境默认同源（前端由本服务或同域 Nginx 托管），只在配置了额外来源时才放开跨域
const corsOptions = {
  origin(origin, callback) {
    // 无 Origin（同源请求 / curl / MCP 客户端）直接放行
    if (!origin) return callback(null, true);
    if (config.corsOrigins.includes(origin)) return callback(null, true);
    // 开发环境放开 localhost 任意端口，方便 Vite 调试
    if (!config.isProd && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS 未允许的来源：${origin}`));
  },
  credentials: true,
};
app.use(cors(corsOptions));

// ---------------- 请求解析与限流 ----------------
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use('/api', generalLimiter);

// 简易访问日志（只在开发环境打印，生产靠操作日志表）
if (!config.isProd) {
  app.use((req, _res, next) => {
    console.log(`[api] ${req.method} ${req.originalUrl}`);
    next();
  });
}

// ---------------- 业务接口 ----------------
app.use('/api', routes);

// ---------------- 静态前端（可选） ----------------
// 把 frontend 构建产物 dist 拷到 backend/public 后，本服务就能同时提供界面，
// 这样宝塔只反代一个 3000 端口即可（README 里给了两种部署方式）。
if (fs.existsSync(config.staticDir)) {
  app.use(express.static(config.staticDir, { index: false, maxAge: '1h' }));

  // SPA 兜底：非 /api 的 GET 请求统一返回 index.html，交给前端路由处理
  app.get(/^(?!\/api\/).*/, (req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(path.join(config.staticDir, 'index.html'));
  });
}

// ---------------- 兜底 ----------------
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
