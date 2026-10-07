<template>
  <div class="login">
    <!-- 背景：极淡的品牌色径向铺底，不使用光斑/网格这类装饰 -->
    <div class="login__wash" aria-hidden="true" />

    <div class="login__card surface">
      <!-- ---------------- 品牌侧 ---------------- -->
      <section class="brand">
        <BrandMark :size="44" label="艾哥 SaaS 工作台" />
        <h1 class="brand__title">艾哥 SaaS 工作台</h1>
        <p class="brand__desc">
          一个界面统一管好整台服务器：网站、域名、容器、应用部署，
          并开放 MCP 接口让 AI 直接帮你干活。
        </p>

        <ul class="brand__list">
          <li v-for="item in capabilities" :key="item.label">
            <span class="brand__dot" aria-hidden="true" />
            <span>
              <strong>{{ item.label }}</strong>
              <em>{{ item.desc }}</em>
            </span>
          </li>
        </ul>

        <p class="brand__foot">已对接：宝塔面板 · Cloudflare · Docker Engine · MCP</p>
      </section>

      <!-- ---------------- 表单侧 ---------------- -->
      <section class="form-panel">
        <header class="form-panel__head">
          <h2>登录</h2>
          <p>请使用管理员账号进入工作台</p>
        </header>

        <el-form
          ref="formRef"
          :model="form"
          :rules="rules"
          label-position="top"
          size="large"
          @submit.prevent="onSubmit"
        >
          <el-form-item label="用户名" prop="username">
            <el-input v-model="form.username" placeholder="请输入用户名" autocomplete="username" clearable>
              <template #prefix><el-icon><User /></el-icon></template>
            </el-input>
          </el-form-item>

          <el-form-item label="密码" prop="password">
            <el-input
              v-model="form.password"
              type="password"
              placeholder="请输入密码"
              autocomplete="current-password"
              show-password
              @keyup.enter="onSubmit"
            >
              <template #prefix><el-icon><Lock /></el-icon></template>
            </el-input>
          </el-form-item>

          <div class="form-panel__row">
            <el-checkbox v-model="remember">记住账号密码</el-checkbox>
            <span class="form-panel__row-hint">仅保存在本机浏览器，换设备需重新输入</span>
          </div>

          <el-alert
            v-if="errorMessage"
            class="form-panel__alert"
            type="error"
            :title="errorMessage"
            :closable="false"
            show-icon
          />

          <el-button type="primary" class="form-panel__submit" :loading="loading" @click="onSubmit">
            {{ loading ? '正在登录…' : '进入工作台' }}
          </el-button>
        </el-form>

        <p v-if="isDev" class="form-panel__hint">
          开发环境默认账号：<code>elyac / elyac123456</code>（首次登录后请立刻在「系统设置」修改）
        </p>
      </section>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
// 深路径导入：不要改回 'element-plus'（barrel 入口会阻止 tree-shaking，详见 main.js）
import { ElMessage } from 'element-plus/es/components/message/index';
import BrandMark from '@/components/BrandMark.vue';
import { useAuthStore } from '@/stores/auth';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const formRef = ref(null);
const loading = ref(false);
const errorMessage = ref('');
const isDev = import.meta.env.DEV;

const form = reactive({ username: '', password: '' });
const remember = ref(true);

// ============================================================
// 「记住账号密码」
// ------------------------------------------------------------------
// 说明：存的是 base64 编码，只防肩窥、不是加密 —— 请勿在此账号上复用
//      其他重要系统的密码。勾选框可随时取消，取消后立即从本机清除。
// ============================================================
const REMEMBER_KEY = 'aige-remember-login';

const encodeB64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
};

const decodeB64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

function loadRemembered() {
  try {
    const raw = localStorage.getItem(REMEMBER_KEY);
    if (!raw) {
      remember.value = false;
      return;
    }
    const saved = JSON.parse(decodeB64(raw));
    form.username = saved.u || '';
    form.password = saved.p || '';
    remember.value = true;
  } catch {
    // 数据损坏（手工改过 / 换了编码方式）→ 清掉，让用户重新输入
    try {
      localStorage.removeItem(REMEMBER_KEY);
    } catch {
      /* 隐私模式下不可用，忽略 */
    }
    remember.value = false;
  }
}

function persistRemembered() {
  try {
    if (remember.value) {
      localStorage.setItem(REMEMBER_KEY, encodeB64(JSON.stringify({ u: form.username.trim(), p: form.password })));
    } else {
      localStorage.removeItem(REMEMBER_KEY);
    }
  } catch {
    /* 隐私模式 / 存储已满：记住功能失效不影响登录 */
  }
}

loadRemembered();

const rules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 4, message: '密码长度不正确', trigger: 'blur' },
  ],
};

const capabilities = [
  { label: '网站管理', desc: '宝塔站点一键创建、删除、申请证书' },
  { label: '域名解析', desc: 'Cloudflare 记录增删改与代理开关' },
  { label: '容器与应用', desc: 'Docker 启停、日志，应用一键部署上线' },
];

async function onSubmit() {
  if (loading.value) return;
  errorMessage.value = '';

  try {
    await formRef.value.validate();
  } catch {
    // 表单校验失败：字段下方已有提示，无需重复弹窗
    return;
  }

  loading.value = true;
  try {
    await auth.login(form.username.trim(), form.password);
    persistRemembered();
    ElMessage.success(`欢迎回来，${auth.displayName}`);
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/dashboard';
    router.replace(redirect);
  } catch (err) {
    errorMessage.value = err.message || '登录失败，请检查用户名与密码';
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  min-height: 100dvh;
  padding: var(--sp-5);
  background: var(--bg-page);
  overflow: hidden;
}

.login__wash {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(60% 50% at 12% 0%, color-mix(in srgb, var(--brand) 8%, transparent) 0%, transparent 70%),
    radial-gradient(50% 45% at 100% 100%, color-mix(in srgb, var(--brand) 6%, transparent) 0%, transparent 72%);
  pointer-events: none;
}

.login__card {
  position: relative;
  display: grid;
  grid-template-columns: 1.05fr 0.95fr;
  width: min(920px, 100%);
  overflow: hidden;
  box-shadow: var(--shadow-lg);
}

/* ---------------- 品牌侧 ---------------- */
.brand {
  padding: var(--sp-7) var(--sp-6);
  background: linear-gradient(160deg, #052012 0%, #08331e 55%, #0b4a2a 100%);
  color: var(--text-on-dark);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.brand__title {
  font-size: var(--fs-3xl);
  font-weight: 600;
  letter-spacing: -0.03em;
  line-height: 1.15;
  color: #f2f6ff;
}

.brand__desc {
  font-size: var(--fs-base);
  line-height: 1.7;
  color: rgba(226, 236, 255, 0.72);
  max-width: 42ch;
}

.brand__list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  margin: var(--sp-2) 0 0;
  padding: 0;
  list-style: none;
}

.brand__list li {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
}

.brand__list span {
  display: flex;
  flex-direction: column;
}

.brand__list strong {
  font-size: var(--fs-base);
  font-weight: 500;
  color: #eaf1ff;
}

.brand__list em {
  font-size: var(--fs-xs);
  font-style: normal;
  color: rgba(214, 228, 250, 0.6);
}

.brand__dot {
  flex: 0 0 6px;
  width: 6px;
  height: 6px;
  margin-top: 8px;
  border-radius: 50%;
  background: #4ade80;
}

.brand__foot {
  margin-top: auto;
  padding-top: var(--sp-4);
  border-top: 1px solid rgba(255, 255, 255, 0.12);
  font-size: var(--fs-xs);
  color: rgba(214, 228, 250, 0.55);
}

/* ---------------- 表单侧 ---------------- */
.form-panel {
  padding: var(--sp-7) var(--sp-6);
  background: var(--bg-surface);
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.form-panel__head {
  margin-bottom: var(--sp-5);
}

.form-panel__head h2 {
  font-size: var(--fs-xl);
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--text-primary);
}

.form-panel__head p {
  margin-top: var(--sp-1);
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

.form-panel__alert {
  margin-bottom: var(--sp-4);
}

/* 记住账号密码：左侧勾选，右侧一句说明（窄屏折行） */
.form-panel__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  flex-wrap: wrap;
  margin-bottom: var(--sp-4);
}

.form-panel__row-hint {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}

.form-panel__submit {
  width: 100%;
  height: 42px;
  font-size: var(--fs-base);
  font-weight: 500;
  margin-top: var(--sp-1);
}

.form-panel__hint {
  margin-top: var(--sp-5);
  padding-top: var(--sp-4);
  border-top: 1px solid var(--border-hairline);
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  line-height: 1.6;
}

.form-panel__hint code {
  padding: 1px 6px;
  border-radius: var(--r-xs);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-family: 'SFMono-Regular', Consolas, Menlo, monospace;
}

/* ---------------- 移动端：单列 ---------------- */
@media (max-width: 860px) {
  .login {
    padding: 0;
    align-items: stretch;
  }

  .login__card {
    grid-template-columns: 1fr;
    width: 100%;
    border: none;
    border-radius: 0;
    box-shadow: none;
    min-height: 100dvh;
  }

  .brand {
    padding: var(--sp-6) var(--sp-5);
    gap: var(--sp-3);
  }

  .brand__title {
    font-size: var(--fs-2xl);
  }

  .brand__list,
  .brand__foot {
    display: none;
  }

  .form-panel {
    padding: var(--sp-6) var(--sp-5) calc(var(--sp-6) + env(safe-area-inset-bottom));
  }
}
</style>
