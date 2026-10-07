/**
 * Axios 实例与拦截器
 * ------------------------------------------------------------------
 * 约定：后端统一返回 { code, message, data }
 *   - code === 0 → 直接把 data 交给调用方（业务代码不用反复 .data.data）
 *   - 其他 → 抛出带 message 的错误，并在需要时弹全局提示
 *   - HTTP 401 → 清理令牌并跳回登录页
 */
import axios from 'axios';
// 深路径导入：不要改回 'element-plus'（barrel 入口会阻止 tree-shaking，详见 main.js）
import { ElMessage } from 'element-plus/es/components/message/index';

const TOKEN_KEY = 'aige-token';

export const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
export const setToken = (token) => localStorage.setItem(TOKEN_KEY, token);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

const request = axios.create({
  baseURL: '/api',
  timeout: 60000, // 部署、拉镜像等操作可能较慢
  headers: { 'Content-Type': 'application/json' },
});

// ---------------- 请求拦截：带上令牌 ----------------
request.interceptors.request.use(
  (config) => {
    const token = getToken();
    if (token) config.headers.Authorization = `Bearer ${token}`;
    return config;
  },
  (error) => Promise.reject(error)
);

// ---------------- 响应拦截：统一解包与错误提示 ----------------
request.interceptors.response.use(
  (response) => {
    const body = response.data;

    // 非标准响应（例如 nginx 返回的 html）直接原样返回，避免误判
    if (!body || typeof body !== 'object' || !('code' in body)) return body;

    if (body.code === 0) return body.data;

    // 业务失败：抛出错误，由调用方决定是否再提示（silent 时不弹）
    const err = new Error(body.message || '请求失败');
    err.code = body.code;
    err.detail = body.detail;
    err.silent = response.config?.silent === true;
    if (!err.silent) ElMessage.error(err.message);
    return Promise.reject(err);
  },
  (error) => {
    const status = error.response?.status;
    const body = error.response?.data;
    const message =
      body?.message ||
      (status === 401
        ? '登录已过期，请重新登录'
        : status === 429
          ? '操作太频繁，请稍后再试'
          : error.message || '网络异常，请稍后重试');

    const err = new Error(message);
    err.code = body?.code || `HTTP_${status || 'NETWORK'}`;
    err.status = status;
    err.silent = error.config?.silent === true;

    if (status === 401) {
      // 令牌失效：清掉本地状态并回登录页（保留来源路径，登录后跳回）
      clearToken();
      const current = window.location.hash.replace(/^#/, '') || '/';
      if (!current.startsWith('/login')) {
        window.location.hash = `#/login?redirect=${encodeURIComponent(current)}`;
      }
    } else if (!err.silent) {
      ElMessage.error(message);
    }

    return Promise.reject(err);
  }
);

export default request;
