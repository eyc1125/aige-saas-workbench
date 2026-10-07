# ============================================================
# 艾哥SaaS工作台 · 前端镜像
# 两阶段：Node 构建静态产物 → Nginx 托管（并反代 /api 到后端）
# ============================================================

# ---------------- 阶段一：构建 ----------------
FROM node:20-alpine AS builder

# Vite 构建 Element Plus + ECharts 这类大依赖时内存峰值较高。
# 小内存服务器（2GB）上不设上限可能触发 OOM，这里给 Node 堆设一个安全上限，
# 超出会明确报错而不是把整台机器拖垮。
ENV NODE_OPTIONS=--max-old-space-size=1024

WORKDIR /app

# ⚠️ 关于源的选择（实测踩坑记录）：
#   npmmirror 虽然能装到绝大多数包，但在解析 rollup 的「平台专属可选依赖」时有问题——
#   装在 Alpine 上时 node_modules/@rollup/ 会是空的，随后 vite build 报
#   "Cannot find module @rollup/rollup-linux-x64-musl"。
#   实测官方源可正确装入 musl 版，因此这里：官方源优先 → 失败退回国内镜像并补装平台包。
#   最后用 node 自检一次，让问题在依赖阶段就暴露，而不是拖到 build 阶段。
COPY package.json ./
RUN set -eux; \
    if ! npm install --registry=https://registry.npmjs.org --no-audit --no-fund --fetch-timeout=180000; then \
      echo "⚠️ 官方源安装失败，退回 npmmirror 并补装 rollup 平台包"; \
      npm install --registry=https://registry.npmmirror.com --no-audit --no-fund; \
      npm install --no-save --registry=https://registry.npmmirror.com --no-audit --no-fund \
        @rollup/rollup-linux-x64-musl; \
    fi; \
    node -e "require('rollup');console.log('✅ rollup 平台包就绪:', require('rollup').VERSION)"

COPY . .
RUN npm run build

# ---------------- 阶段二：运行 ----------------
FROM nginx:1.31-alpine

ENV TZ=Asia/Shanghai

# 静态产物 + 站点配置（站点配置里已包含 /api 反向代理）
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
