# ============================================================
# 艾哥SaaS工作台 · 后端镜像
# 说明：better-sqlite3 是原生模块，Alpine(musl) 下没有预编译包，
#       所以用多阶段构建：builder 阶段装上 python3/make/g++ 编译，
#       运行阶段只拷贝编译好的 node_modules，镜像体积可控。
# ============================================================

# ---------------- 阶段一：编译依赖 ----------------
FROM node:20-alpine AS builder

# 编译 better-sqlite3 需要的工具链。
# ⚠️ 必须先换国内 Alpine 镜像：Alpine 官方 CDN（dl-cdn.alpinelinux.org）在国内服务器上
#    极慢，实测装 gcc 会卡住 20 分钟以上（网络等待，不是 CPU 瓶颈）。
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories \
 && apk add --no-cache python3 make g++

WORKDIR /app

# 先拷 package.json，利用 Docker 层缓存：源码变了不用重装依赖。
# ⚠️ 同样刻意不拷 package-lock.json：本项目的 lockfile 在 Windows 上生成，
#    缺少 Linux 平台的 optional 依赖，会让 npm 在容器里漏装（npm/cli#4828）。
#    后端依赖里 better-sqlite3 是原生模块，本来就要在本平台现场编译，
#    所以不锁 lockfile 没有额外风险。
COPY package.json ./

# 国内服务器走 npmmirror 提速；better-sqlite3 会在此阶段完成本地编译
RUN npm install --omit=dev --registry=https://registry.npmmirror.com --no-audit --no-fund

# ---------------- 阶段二：运行 ----------------
FROM node:20-alpine

ENV NODE_ENV=production \
    TZ=Asia/Shanghai

WORKDIR /app

# 只搬运编译好的依赖与源码
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src

# 数据目录（docker-compose 会把宿主机 ./data 挂到这里）
RUN mkdir -p /app/data

EXPOSE 3000 3001

# 健康检查：/api/health 不通即认为容器不健康
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
