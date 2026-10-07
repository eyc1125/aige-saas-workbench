# 艾哥SaaS工作台 · UI 设计规范

> 本文件是本项目的界面约定。新增页面 / 组件前先读一遍，保持一致，不要各自发挥。
> 最后更新：2026-10-08

---

## 一、整体定位

**后台管理系统（product 注册）· 白底轻科技风。**

- 设计服务于「看得清、点得准、不误操作」，不追求视觉炫技
- `SOUL=5 · SPECTACLE=2 · DENSITY=8`（信息密度优先）
- **一页仍然只锁一个主色**；主色本身可在「系统设置 → 外观」里整站切换（见 2.1）

---

## 二、设计令牌（`src/styles/tokens.css`，唯一来源）

**不要在组件里写死颜色 / 字号 / 间距 —— 一律用变量。**

### 2.1 主色：一套可切换的预设（`src/styles/palettes.css`）

> **配色演进**：
> v2 通用蓝 `#2563eb`（AI 生成页面最常撞车）→ v3 深青蓝 `#0a6e86` → v3.5 深祖母绿 `#0b6b47`
> （偏青、太墨）→ v4 森林绿 `#15803d` → **v5 主题色预设（默认「元气青」`#0f766e`，取自 logo 主色）**。
>
> v5 解决的是一句反馈：「别光使用绿色的颜色，试用好几种颜色」。
> 做法不是再挑一个自定义色，而是把主色做成**可选预设**，默认值取主人自己 logo 的青色 ——
> 这样界面和 logo 是一套，想换随时在「系统设置 → 外观」点一下。
>
> 切换机制：`<html data-brand="<id>">`，令牌定义在 `styles/palettes.css`，
> 状态在 `stores/theme.js`，首屏防闪在 `index.html` 的内联脚本里（三处都有注释指向彼此）。

| 预设 id | 名称 | 浅色 `--brand` | 说明 |
| --- | --- | --- | --- |
| `teal` | 元气青 | `#0f766e` | **默认**，取自 logo 主色 |
| `green` | 森林绿 | `#15803d` | v4 的默认绿 |
| `blue` | 科技蓝 | `#1d4ed8` | 最稳的后台蓝 |
| `amber` | 暖阳金 | `#9c4508` | 取自 logo 里的黄色调（压暗到能压住白字） |
| `violet` | 夜幕紫 | `#6d28d9` | — |
| `rose` | 玫瑰红 | `#be123c` | — |

每个预设只定义 7 个值（浅色 + 深色各一套）：`--brand` / `--brand-hover` / `--brand-active` /
`--brand-soft` / `--brand-soft-border` / `--brand-on-light` / `--on-brand`。
**渐变、带色阴影、聚焦环、登录页品牌面板底色全部由 `--brand` 推导**（`color-mix`），
所以新增一个预设 = 在 `palettes.css` 加 14 行，别的文件不用动。

| 令牌 | 浅色（teal） | 用途 |
| --- | --- | --- |
| `--brand` | `#0f766e` | 全站唯一主色 |
| `--brand-hover` / `--brand-active` | `#0d6660` / `#0b5751` | 按钮三态 |
| `--brand-soft` | `#e6f4f2` | 选中行、标签底色 |
| `--brand-gradient` | 由 `--brand → --brand-active` 推导 | 主按钮、品牌标记（两端都过对比度校验） |
| `--brand-on-light` | `#12a89b` | 品牌标记专用（图形按 3:1 判定，可更艳一档） |
| `--on-brand` | `#f0fbf9` | 主色底上的文字（对主色 ≈4.9:1） |
| `--warning` / `--danger` / `--info` | `#a9600a` / `#c62f2f` / `#2563eb` | 状态语义（不随主题色变） |

深色主题下每个预设的品牌色一律**提亮一档**（teal → `#2dd4bf`），`--on-brand` 转为近深色。

> ⚠️ **`--success` 不跟随主题色**：绿色 = 健康，那是语义不是风格。
> 品牌换成紫色时「运行正常」不该变紫。只有 `green` 预设下 `--success` 与 `--brand` 同值。

### 2.2 中性色阶（带一点品牌冷调，**不是纯灰**）

| 令牌 | 浅色 | 用途 |
| --- | --- | --- |
| `--bg-page` | `#f3f8f4` | 页面底色 |
| `--bg-surface` | `#fcfdfc` | 卡片 / 面板（**近白，但不纯白**） |
| `--bg-subtle` | `#f5faf6` | 表头、内嵌区块 |
| `--bg-hover` / `--bg-active` | `#edf6f0` / `#e4f0e8` | 悬停 / 按下 |
| `--border-hairline` | `rgba(10,50,28,.09)` | **发丝线**（普通分隔） |
| `--text-primary` | `#13251a` | 正文（近黑，非 `#000`，对卡片底 15.9:1） |
| `--text-secondary` | `#4c6a58` | 次要文字（5.9:1） |
| `--text-tertiary` | `#738a7b` | 辅助文字（3.7:1） |

### 2.3 工艺地板（不可破）

- ❌ 不用纯 `#fff` / `#000` 做背景与正文（`--bg-surface` 也必须是近白，不是纯白）
- ❌ 不用硬 `#ccc` / `#333` 边框，一律半透明发丝线
- ❌ 阴影必须带色（浅色下带冷暗调 `rgba(10,50,28,…)`；主色阴影由 `--brand` 推导），不用纯黑投影
- ❌ 一页不出现第二个主色
- **对比度**：正文 ≥7:1、次要 ≥3.5:1、按钮文字 ≥4.5:1

### 2.4 品牌标识（Logo）

> **主人明确要求：所有场合都用整幅 logo，不裁切、不取局部。**
> 早期版本曾拿「头部特写」做小尺寸图标，已按要求全部改回整幅图 —— 不要再改回去。

| 产物 | 文件 | 用途 |
| --- | --- | --- |
| 图源（唯一） | `public/brand-logo.jpg` | 1280×1280 整幅插画，**换 logo 只替换这一个文件** |
| 组件 | `src/components/BrandMark.vue` | 侧栏、抽屉；渲染 `brand-mark.png`，`size` 可控 |
| 标签页图标 | `public/favicon-32.png` / `favicon-48.png` / `icon-192.png` | 浏览器标签、收藏夹 |
| 桌面图标 | `public/apple-touch-icon.png` | iOS 添加到主屏 |
| 分享预览 | `public/og-cover.png` | 1200×630，整幅图居中在白色画布上 |

**生成方式**：`tools/gen-brand-icons.ps1`（System.Drawing，等比缩放不裁切）。
任何尺寸都由该脚本产出，**不要手改生成的 PNG**。

```powershell
# 仓库根目录执行
powershell -NoProfile -ExecutionPolicy Bypass -File tools\gen-brand-icons.ps1
```

---

### 2.5 标度（锁死）

| 类别 | 取值 |
| --- | --- |
| 字号 | `12 / 13 / 14 / 16 / 18 / 20 / 24 / 30` |
| 间距 | `4 / 8 / 12 / 16 / 24 / 32 / 48` |
| 圆角 | `4 / 6 / 8 / 12 / 16 / 999` |
| 行高 | 正文 `1.6`，标题 `1.1–1.25` |
| 字重 | 只用 `400 / 500 / 600` 三档 |
| 动效 | 曲线 `cubic-bezier(.2,0,0,1)`；微交互 150ms、卡片 250ms、弹层 300ms |

---

## 三、布局

### 3.1 应用外壳

```
┌────────┬──────────────────────────────┐
│ 侧边栏  │ 顶栏（sticky, 60px）          │
│ 232px  ├──────────────────────────────┤
│ 可收起  │ 内容区 padding 24px           │
└────────┴──────────────────────────────┘
```

- 侧边栏 `sticky top:0`，收起后 68px（状态存 localStorage）
- 顶栏 `sticky top:0`，半透明白 + `backdrop-blur(12px)`
- 内容区 `flex:1; min-width:0`（**关键**：防止内部表格把整体撑宽）

### 3.2 断点（全站统一）

| 断点 | 变化 |
| --- | --- |
| `> 900px` | 侧栏常驻 + 完整表格 |
| `≤ 900px` | 侧栏收成抽屉（汉堡菜单）；**列表页切换为卡片** |
| `≤ 768px` | 所有可点击元素 ≥44px；弹窗两侧留边；表格行加高 |
| `≤ 640px` | 卡片内部进一步紧凑 |

> ⚠️ **侧栏收起与卡片切换必须共用 900px 这一个断点**。
> 否则会出现「侧栏收起了、表格还在横向拖」的半吊子状态。

---

## 四、移动端卡片列表（替代表格）

### 4.1 为什么不用「表格横向滚动」

一个 6 列表格在 375px 上只能露出约三分之一；`fixed="right"` 的操作列会盖住下面的列，
按钮互相穿透、文字叠在一起**完全不可读**（实测截图确认过）。

### 4.2 结构

```
li.card
├── .card__head
│   ├── .card__title    标题（长串自动断行）+ 可选 .card__sub 副标题
│   └── .pill           状态胶囊（右对齐）
├── dl.card__meta
│   └── .card__meta-row   dt 字段名（固定 68px 轨道） + dd 字段值
└── .card__actions       操作按钮独立成行，flex-wrap 换行
```

### 4.3 使用方式

```js
import { useNarrow } from '@/composables/useNarrow';
const isNarrow = useNarrow(900);   // 断点与主布局保持一致
```

```vue
<ul v-if="isNarrow" class="cards"> … </ul>
<div v-else class="table-wrap"> <el-table> … </el-table> </div>
```

```js
// ⚠️ 必须用 v-if / v-else 的相邻兄弟写法
//    不要用 <template v-else> 包住两者，否则表格会被整体重新缩进、改动面变大
```

### 4.4 硬规则

- 卡片标题里的长串（域名、路径）必须 `overflow-wrap: anywhere`
- 操作按钮 `flex:1 1 auto; min-width:84px; margin-left:0`（清掉 Element Plus 的相邻左边距，否则错位）
- 字段名轨道宽度全站统一 68px，不要每个页面各写一个

---

## 五、触控目标标准

**手机上手指能点准的下限是 44×44px**（WCAG / iOS HIG 一致）。

只抬高**点击区**（`min-height`），不改图标尺寸与字号 —— 视觉不变，手感变好。

| 元素 | 桌面 | ≤768px |
| --- | --- | --- |
| 顶栏汉堡 / 主题 / 用户菜单 | 34px | **44px** |
| Element Plus 按钮、输入框、下拉、单选多选、Tab | 默认 | **≥44px** |
| 表格内链接式操作按钮 | 默认 | **44px** |
| 复制按钮 `.copy-btn` | 26px | **44px** |
| 分段控件 `.range-switch__btn` / `.swatch` / `.mode-switch__btn` | 26–34px | **≥44px** |

> `.qa/audit.mjs` 会在 320/375/414/768 四个宽度逐一量触控目标，
> 新增任何可点元素后跑一次，别靠肉眼估。

---

## 六、动效与 3D

**总原则：动效只用来表达「发生了什么」，不用来表演。** 服务器是 2 核机器、还要跑
宝塔 + 其它项目，所以三条硬约束写在所有动效之前：

1. **只用合成器友好的属性**（`transform` / `opacity`），不动 `width` / `height` / `top`；
2. **高频事件必须用 rAF 合并**（指针移动可达 120Hz，一次移动写一次样式会掉帧）；
3. **尊重 `prefers-reduced-motion`，并且要能降到「静止终止态」** ——
   只把 `duration` 压到 0.01ms 是不够的：带 `both` 填充的进场动画仍会先「隐身」一段时间，
   必须把动画整个 `none` 掉（见 `Login.vue` 底部）。

| 场景 | 做法 | 时长 |
| --- | --- | --- |
| KPI 卡 3D 倾斜 | `perspective(760px) rotateX(≤5°) rotateY(≤7°)`，角度由指针位置算出 | 跟随 250ms |
| KPI 卡指针高光 | `radial-gradient` 跟随 `--glow-x/y`，品牌色 12% 透明 | 250ms |
| KPI 数字滚动 | rAF + 三次缓出；只在「数值→数值」滚动 | 520ms |
| 登录页 logo 进场 | `rotateX(-14°) → 0`，小角度=「放上去」，大角度=「转出来」 | 620ms |
| 登录页文案逐条上浮 | 每条差 60ms，三条合计 180ms | 420ms |
| 页面切换 | `App.vue` 的 `page-fade`（淡入 + 上移 6px） | 250ms |

**登录页时序（整段 ≈0.9s，但表单 0.6s 就能用）**：
logo 翻正(60ms) → 说明淡入(220ms) → 能力列表(300/360/420ms) → 页脚(520ms)；
**表单面板从 120ms 就开始淡入** —— 进来是要登录的，不让它等装饰。

**为什么不上 Three.js 全景 3D**：`three` 的 gzip 体积约 3.2MB，在这台 2 核机器 + 手机端
必然掉帧，还会把首屏拖回「卡一下」的老问题。CSS 3D 能表达的立体感，这里已经够用。

---

## 七、公共组件

| 组件 | 用途 | 关键约定 |
| --- | --- | --- |
| `BrandMark.vue` | 品牌标识 | `size` 控制边长；渲染整幅 logo（`brand-mark.png`），不做裁切 |
| `StatCard.vue` | 仪表盘 KPI 卡 | `icon` 名（字符串）+ 数值 + 单位 + 进度条；自带 3D 倾斜与数字滚动 |
| `StateBlock.vue` | 数据四态占位 | `state` = loading / error / empty；error 必须带「重试」 |
| `CopyBtn.vue` | 一键复制 | 必须 `@click.stop`（常位于可点击行内，否则会误触发行点击） |
| `useCopy.js` | 复制逻辑 | https 用 `navigator.clipboard`，http 退回 `execCommand`；**设置页也复用它**，不要各写一份 |
| `useNarrow.js` | 窄屏判定 | `matchMedia` 驱动，只在跨断点时触发 |

**状态完备要求（缺一即不合格）：**

- 交互三态：hover / active / disabled
- 数据四态：正常 / 空 / 加载中（骨架屏）/ 加载失败（含重试）
- 提交类按钮：点击后立即 loading，防重复提交

---

## 八、图标

- **只注册用到的图标**（`src/main.js` 的 `USED_ICONS`），当前 43 个
- 全量注册会让约 290 个图标全部进包，毫无意义
- 新增图标时在 `USED_ICONS` 里补一行
- 模板里两种写法都支持：`<Menu />`（静态标签）、`<component :is="'Odometer'" />`（动态字符串）

---

## 九、Element Plus 使用约定

1. **组件按需引入**：模板里直接写 `<el-xxx>` 即可，
   由 `unplugin-vue-components` 在编译期解析，**不要**再 `app.use(ElementPlus)`
2. **样式用全量 CSS**：`element-plus/dist/index.css`（约 49KB gzip）。
   省体积的重头在 JS，全量 CSS 换来「绝不样式塌陷」的确定性
3. ⚠️ **`ElMessage` / `ElMessageBox` 必须用深路径导入**：

   ```js
   // ✅ 正确
   import { ElMessage } from 'element-plus/es/components/message/index';
   // ❌ 错误：barrel 入口会阻止 tree-shaking
   import { ElMessage } from 'element-plus';
   ```

4. 中文语言包由 `App.vue` 的 `<el-config-provider :locale="zhCn">` 下发

---

## 十、交付门禁（每次 UI 改动前必过）

1. 跑多端验收台，确认无回归：

   ```bash
   node .qa/audit.mjs
   ```

   检查项：横向溢出 / 可点击文本折行 / 触控目标 <44px
   判定宽度：320 · 375 · 414 · 768 · 1440

2. **必须人工看截图**（`.qa/shots/`）。
   只看数值会翻车：验收台第一版没有「页面真渲染」断言时，
   页面全白也会全绿 —— 没有元素自然没有溢出。

3. 新增颜色 / 字号 / 间距前，先查 `tokens.css` 有没有现成令牌

4. 反廉价黑名单自查：
   - 无左侧 3px 色条装饰
   - 无等大卡片网格堆砌
   - 无 `#fff` / `#000` 硬写
   - 无编造的精确数字
   - 无 div 手绘的假截图 / 假窗口壳
