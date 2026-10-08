/**
 * 应用入口
 * ------------------------------------------------------------------
 * Element Plus 采用**按需引入**：
 *   · 组件（<el-button> 这类）由 vite.config.js 里的 unplugin-vue-components
 *     在编译期解析，所以这里**不再** app.use(ElementPlus)。
 *     全量注册会把所有组件打进产物（element 分包约 1MB / gzip 339KB），
 *     而本系统只用到十几个。
 *   · 样式仍用 element-plus 的全量 CSS（~49KB gzip）。省体积的重头在 JS，
 *     全量 CSS 换来的是「绝不出现某个组件样式塌陷」的确定性，很划算。
 *   · 函数式组件 ElMessage / ElMessageBox 在各页面是显式 import 的，
 *     不经过模板解析，所以它们的样式仍需手动引入（下面的 css-vars 之后）。
 *
 * 图标只注册**实际用到的 43 个**：
 *   全量注册会让 @element-plus/icons-vue 的约 290 个图标全部进包。
 *   新增图标时，在下面 USED_ICONS 里补一行即可。
 *   模板里既可写 <Menu /> 这种标签，也可写 <component :is="'Odometer'" /> 这种
 *   动态字符串写法 —— 后者正是靠全局注册解析的，所以不能删掉这段注册。
 */
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import {
  ArrowDown,
  ArrowRight,
  Bell,
  Box,
  Check,
  CircleCheck,
  CircleCheckFilled,
  CircleCloseFilled,
  Close,
  Coin,
  Connection,
  Cpu,
  DataLine,
  Document,
  DocumentCopy,
  Expand,
  Files,
  FirstAidKit,
  Fold,
  FolderOpened,
  Grid,
  Key,
  Link,
  Lock,
  Medal,
  Menu,
  Monitor,
  Moon,
  Odometer,
  Plus,
  Refresh,
  RefreshRight,
  Search,
  Setting,
  Sunny,
  SwitchButton,
  Timer,
  TrendCharts,
  Upload,
  User,
  UserFilled,
  View,
  Warning,
  WarningFilled,
} from '@element-plus/icons-vue';

import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import './styles/index.css';

import App from './App.vue';
import router from './router';

/** 本系统实际用到的图标（模板静态标签 + 动态 :is 字符串都会命中这里） */
const USED_ICONS = {
  ArrowDown,
  ArrowRight,
  Bell,
  Box,
  Check,
  CircleCheck,
  CircleCheckFilled,
  CircleCloseFilled,
  Close,
  Coin,
  Connection,
  Cpu,
  DataLine,
  Document,
  DocumentCopy,
  Expand,
  Files,
  FirstAidKit,
  Fold,
  FolderOpened,
  Grid,
  Key,
  Link,
  Lock,
  Medal,
  Menu,
  Monitor,
  Moon,
  Odometer,
  Plus,
  Refresh,
  RefreshRight,
  Search,
  Setting,
  Sunny,
  SwitchButton,
  Timer,
  TrendCharts,
  Upload,
  User,
  UserFilled,
  View,
  Warning,
  WarningFilled,
};

const app = createApp(App);

Object.entries(USED_ICONS).forEach(([name, component]) => {
  app.component(name, component);
});

app.use(createPinia());
app.use(router);

// 全局兜底：未捕获的组件错误不至于让整页白屏
app.config.errorHandler = (err, _instance, info) => {
  console.error('[vue] 组件异常：', err, info);
};

app.mount('#app');
