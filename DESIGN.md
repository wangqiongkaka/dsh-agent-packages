---
name: Skills & MCP 多 Harness 统一管理页
description: 在 DSH 设置页里用「条目 × 4 端」矩阵查看 4 端的 Skills、MCP 与插件，添加 / 编辑 / 移除 MCP，并管理规则
colors:
  host-accent: "#386bdd"
  host-error: "#b32f35"
  host-success: "#18704a"
  amber-warn: "#c47f17"
  ink: "#202631"
  slate-muted: "#5c6573"
  hairline: "#d9dfe7"
  panel: "#fafbfc"
typography:
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.55
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.55
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: "20px"
  caption:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.55
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  seg: "6px"
  icon: "7px"
  control: "8px"
  callout: "9px"
  card: "12px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  2xl: "20px"
components:
  switch-on:
    backgroundColor: "color-mix(in srgb, #386bdd 16%, transparent)"
    textColor: "{colors.host-accent}"
    rounded: "{rounded.control}"
    height: "34px"
  switch-off:
    backgroundColor: "transparent"
    textColor: "{colors.slate-muted}"
    rounded: "{rounded.control}"
    height: "34px"
  switch-broken:
    backgroundColor: "color-mix(in srgb, #c47f17 14%, transparent)"
    textColor: "{colors.amber-warn}"
    rounded: "{rounded.control}"
    height: "34px"
  filter-chip:
    backgroundColor: "transparent"
    textColor: "{colors.slate-muted}"
    rounded: "{rounded.pill}"
    height: "30px"
    padding: "0 12px"
  filter-chip-selected:
    backgroundColor: "color-mix(in srgb, #386bdd 14%, transparent)"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    height: "30px"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.slate-muted}"
    rounded: "{rounded.icon}"
    size: "32px"
  input:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "36px"
    padding: "7px 10px"
  matrix-card:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.card}"
---

# Skills / MCP / 插件 / 规则 多 Harness 统一管理页（dsh-agent-packages）

定位：查看 Codex、Claude Code、Antigravity、DSH 原生 4 个 Harness 各有哪些 Skills、MCP 与插件；MCP 可在页面添加、编辑、移除；规则（全局指令）由片段拼接写入各端。Skills 与插件由用户在各端手工安装，页面只读。

## Overview

**Creative North Star: "配线架 Patch Bay"**

页面是一块配线架：每个 Skill、MCP、插件或规则片段是一排插孔，右侧 4 列是 Codex、Claude Code、Antigravity、DSH 原生 4 个插口，点亮一格表示这一端接通（Skills 与插件只显示接通情况，由各端自己插拔；MCP 可在这里拔掉，接入走「添加 / 编辑」表单）。所有视觉决定都服务于「一眼看清哪些端接通、哪些没接、哪些坏了」，其余元素退到中性色里。

这是 DSH 设置页里的一个分类（Operate 场景），与宿主融为一体：颜色全部来自宿主主题变量 `--dsw-alias-*`，亮色和暗色主题共用同一套规则；不引入自有字体、阴影或装饰图形。密度中等偏紧，常见面板宽度约 585px，也要在 390px 窄屏和 1120px 宽屏下成立。

**Key Characteristics:**
- 条目 × 4 端矩阵是唯一的主结构，4 个视图共用，端列在所有行严格对齐。
- 状态用「形状 + 颜色」双重编码，从不只靠颜色。
- 中性色为底，主题色只出现在已接通的格子、选中态和每个区域唯一的主操作上。
- 平面分层，无阴影；层次靠细边框和浅色分组底区分。

## Colors

中性的宿主底色加一种主题色，另有成功、错误、警示三种状态色；表中十六进制是 `src/client.css` 里宿主变量的兜底值，DSH 中运行时以宿主主题为准。

### Primary
- **宿主激活蓝 Host Accent** (#386bdd)：已接通格子的边框与浅底（16% 混合）、选中的筛选标签与分段按钮、Tab 下划线、链接按钮、焦点环。来自 `--dsw-alias-state-active-primary`。

### Neutral
- **墨色 Ink** (#202631)：正文与名称。来自 `--dsw-alias-label-primary`。
- **石板灰 Slate Muted** (#5c6573)：说明行、列头、计数、未接通格子的图标。来自 `--dsw-alias-label-secondary`。
- **细线灰 Hairline** (#d9dfe7)：卡片、输入框、矩阵边框；行间分隔线用它的 60% 透明度。来自 `--dsw-alias-border-l2`。
- **面板底 Panel** (#fafbfc)：卡片与输入框底色；分组标题行在它上面叠 3% 墨色。来自 `--dsw-alias-bg-layer-1`。

### Status
- **成功绿 Host Success** (#18704a)：完成的提示条、「已同步」、执行成功。
- **错误红 Host Error** (#b32f35)：确认条边框、行内错误、写入失败、执行失败。
- **琥珀警示 Amber Warn** (#c47f17)：损坏的格子（失效软链）、部分失败的提示条、「需处理 / 待同步」徽标。用作文字时与墨色按 65:35 混合（`--ap-warn-text`），亮色主题更深、暗色主题更亮，两种主题在琥珀浅底上都不低于 4.5:1。

### Named Rules
**The Connected-Only Rule.** 主题蓝只表示「已接通 / 已选中 / 主操作」。不要用它做装饰、分组标题或普通链接以外的强调。

**The Never-Color-Alone Rule.** 每种状态都同时有形状：✓ 接通、虚线 + 未接通、✕ 损坏、斜纹锁定、◇ 待同步、转圈执行中。去掉颜色后状态仍然可读。

## Typography

**Body Font:** 系统字体栈（-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif）
**Label/Mono Font:** ui-monospace, SFMono-Regular, Menlo, monospace

**Character:** 沿用宿主的系统字体，不引入品牌字体；等宽字体只用在名称、路径、命令和配置上，标记「这是机器读的东西」。

### Hierarchy
- **Title** (600, 16px)：表单标题（添加 MCP、编辑 MCP）。
- **Headline** (600, 15px)：规则预览等侧栏标题。
- **Body** (400, 14px, 1.55)：Tab、正文、条目名称（名称用 600）。
- **Label** (600, 13px, 20px)：矩阵分组标题；与端名列头同行时按 20px 行高顶部对齐。
- **Caption** (400, 12px)：说明行、分组说明、帮助文字、端名列头（11.5px）。
- **Mono** (400, 12px)：Skill / MCP 名称、路径、命令、配置预览、执行记录输出。

### Named Rules
**The One-Line Name Rule.** 条目名称和徽章保持一行；空间不足时只截断名称（悬停看全名），徽章完整保留。

## Layout

根节点是 `inline-size` 容器，按插件实际宽度（不是窗口宽度）分三档：

- **宽（≥ 760px）**：端列 96px，列头显示端名全称。
- **常规面板（≈ 585px）**：端列 48px，列头显示简称（Codex / Claude / Agy / DSH）；搜索、刷新、主操作保持一行，筛选标签另起一行；≤ 560px 时 Tab 徽标只显示数字。
- **窄（≤ 460px）**：隐藏列头，4 个格子换到第二行、等分宽度并带端名；路径条两列。任何宽度都不出现横向溢出。

矩阵是三列网格（信息 / 4 端 / 行末动作；没有行末动作的视图如 Skills、插件为两列），每行用 `subgrid` 继承列宽；有行末动作的视图把动作列固定为 40px（规则视图 104px），使同一视图里的多个矩阵端列对齐。表单和规则视图是「主区 + 侧栏」：主区 `flex: 999 1 320–520px`、侧栏 `flex: 1 1 240–280px`，放不下时侧栏落到下方。

间距节奏为 4 / 6 / 8 / 12 / 16 / 20px；行高约 60px，行内上下 8px、左 14px。

## Elevation & Depth

完全平面，没有阴影。层次靠三样东西：细线边框（Hairline）、分组标题行的 3% 墨色底、侧栏与执行记录的同一浅底（Subtle）。状态区块（确认条、行内错误、警示框、提示条）用对应状态色的 45% 边框加 6–8% 浅底，而不是投影。

### Named Rules
**The Flat-Panel Rule.** 不加 box-shadow。需要突出某块时换边框颜色和浅底，不抬高它。

## Shapes

小圆角、细边框。控件统一 8px（输入框、开关块、代码块），图标按钮 7px，分段按钮内项 6px，状态区块 9px，卡片与矩阵外框 12px，筛选标签和徽章用全圆角胶囊。未接通的格子用 1px 虚线框，锁定的格子用 135° 斜纹底且无边框。

## Components

**基调：安静、精确。** 中性色为底，只有状态和主操作带颜色；边框细、圆角小，一眼能读出状态，与宿主 DSH 设置页融为一体。

### 端开关块（Signature）
- **形状**：宽 `min(列宽 - 6px, 56px)`、高 34px（窄屏 38px 等分）、8px 圆角，`role="switch"`。
- **接通**：主题蓝 75% 实线边框、16% 浅底、✓。
- **未接通**：虚线边框、灰色 ＋；悬停变主题蓝实线。
- **损坏**：琥珀边框、14% 浅底、✕。
- **锁定 / 不可用**：斜纹底、无边框、75% 不透明；存在时保留淡色 ✓。原因写在 `aria-label` 与 `title`。
- **执行中**：主题蓝实线边框、转圈图标。

### 只读状态格
规则文件状态与未纳管文件用的图形 + 下方 11px 状态文字：✓ 已同步（成功绿）、◇ 外部修改 / 未创建 / 待拆软链（琥珀）、✕ 写入失败 / 读取异常（错误红）、文档图标 未纳管（琥珀）、短横 不改动（灰）。

### Buttons
- **主操作**：宿主 `Button variant="primary"`，每个区域只有一个（添加 MCP、新建片段、保存并写入 N 端、重试 N 端）。
- **次要**：宿主 `Button variant="outline"`（刷新、取消、同步 N 端、纳管）。
- **行末图标按钮**：32px、7px 圆角、灰色图标，悬停 6% 墨色底；删除类悬停变错误红。名称写在 `aria-label` 与 `title`。

### Chips
- **筛选标签**：30px 胶囊、细线边框、灰字，右侧带计数；选中时主题蓝 60% 边框 + 14% 浅底 + 墨色字。计数为 0 的隐藏（「全部」与当前选中项除外）。

### Inputs / Fields
- **Style**：36px 高、8px 圆角、细线边框、面板底；名称类输入用等宽字体。
- **Focus**：2px 主题蓝外环，偏移 2px。
- **Error**：边框变错误红，下方 12px 错误文字（`role="alert"`）。
- **分段单选**：外框 9px 圆角，内项 6px，选中项 18% 主题蓝底。
- **端卡片复选框**：9px 圆角卡片，名称 + 一行现状说明；选中主题蓝边框 + 7% 浅底；不可用斜纹底。

### Navigation
- **Tab**：下划线样式，42px 高；未选中灰字，选中墨色字 + 2px 主题蓝下划线；名称后跟数量，需要处理时加琥珀徽标「N 需处理 / N 待同步」。

### Cards / Containers
- **矩阵与表单卡片**：12px 圆角、细线边框、面板底、无阴影；内边距 16px（矩阵行 8px / 14px）。

## Do's and Don'ts

### Do:
- **Do** 让同一视图里所有端列严格对齐：新增矩阵时沿用三列网格 + `subgrid`，并固定行末动作列宽。
- **Do** 每种新状态同时给出形状和颜色，并在 `aria-label` 写明「端名：状态」。
- **Do** 颜色一律从 `--dsw-alias-*` 派生（`color-mix`），确保亮色和暗色主题都成立。
- **Do** 在 585px、390px 与 ≥ 760px 三个宽度下检查布局。

### Don't:
- **Don't** 加阴影、渐变或装饰图形。
- **Don't** 在页面内重复「Skills & MCP」标题，宿主已经显示。
- **Don't** 用主题蓝表示「已接通 / 选中 / 主操作」以外的含义。
- **Don't** 在一个区域放第二个 `primary` 按钮。
- **Don't** 在页面上显示 MCP 环境变量或其他字符串配置的值，只显示名称。

## 核心原则

- **本机配置即真相**：不维护清单与锁文件。页面每次读取 4 端的真实目录与配置文件，列出已有的 Skills / MCP / 插件；手工安装的条目刷新后即出现，没有「纳管」步骤。只有规则片段由本插件存储（`<DSH_HOME>/dsh-agent-packages/instructions/snippets.json`）。
- **页面不做跨端同步**：Skills 与插件只读；MCP 只通过「添加 / 编辑」表单显式写入所勾选的端，格子只能移除，不能点亮从其他端复制。不从 GitHub 下载或解析仓库。各家插件框架（清单位置、组件类型、MCP 文件名、市场机制）不一致，很难做到所有端都兼容，因此插件由用户用各端原生命令手工安装。也不区分 Skill / MCP 是否由插件带来，统一按各端目录与配置文件的实际内容展示。
- **不做的事**：不从 GitHub 安装 Skills / MCP、不解析仓库、不调用 AI 分析、不管理 CLI 工具（如 codegraph）的安装升级、不查 Skills / MCP 的远端版本。手工装的东西由其来源工具自行更新；插件的安装、更新、卸载与市场管理都用各端原生命令。

## 挂载与整体风格

- 使用 DSH 正式设置分类插槽 `settings.section`（`id: 'dsh-agent-packages'`，`order: 28`，标签 `Skills & MCP`）；服务端关闭自动配置页（`settings.configure({ auto: false })`）。
- 复用 DSH 主题变量（`--dsw-alias-*`，其余颜色由它们 `color-mix` 派生，亮色 / 暗色主题通用）与 `@deepseek-ai/dsh-client-ui-primitives` 的 `Button`：每个区域只有一个主操作用 `primary`（如「添加 MCP」「新建片段」「保存并写入」「重试 N 端」），其余用 `outline`；行末次要动作用图标按钮（名称写在 `aria-label` 与 `title`）。所有字段有可访问 `<label>`；错误 `role="alert"`；结果 `role="status"`；按钮文案不折行；二选一用分段单选，多选端用卡片式复选框（写明该端的现状或不可用原因）。
- 页面结构：下划线 Tab（名称 + 数量 + 「N 需处理 / N 待同步」徽标）→ 提示条（成功提示 3 秒后自动消失；失败或需要核对的警示提示保留到手动关闭）→ 工具栏（搜索、「本机路径」下拉、刷新、主操作）→ 分组筛选标签（Skills / MCP：全部 / 需处理 / N 端一致，计数为 0 的隐藏）→ 矩阵 → 执行记录。宿主设置页已有「Skills & MCP」标题，页面内不再重复；视图不放说明文字。
- 「本机路径」下拉：工具栏里与「刷新」同款的描边按钮（右侧箭头，展开时翻转），点开后右对齐浮层列出本视图读写的各端目录、配置文件或命令（规则视图另含片段存储），显示完整路径、过长换行；点页面别处或按 Esc 收起。用原生 `<details>` 实现，键盘可操作。
- 根节点是 `inline-size` 容器，按插件实际宽度（容器查询）切换布局：`>= 760px` 时端列 96px、表头显示端名全称；一般面板端列 48px、表头显示简称；`<= 460px` 时隐藏端名表头，格子换到第二行、4 格等分并显示端名，不出现横向溢出。

## 结构主线：条目 × 端矩阵

- 4 个视图「Skills｜MCP｜插件｜规则」共用同一种矩阵：每行一个条目，右侧 4 列对齐 Codex / Claude / Agy / DSH（三列网格 + `subgrid`），端名并入第一个分组标题行。
- **格子**：Skills 与插件是只读状态格（`MatrixCells`，`role="img"`），没有该条目的端显示短横。MCP 与规则的格子是开关（`role="switch"`）：MCP 只有已有该 key 的端可点，点了先在行内确认（写明移除什么）再从该端移除；没有该 key 的可写端显示普通短横（静态格，不是斜纹），标签提示「要写入该端请用『编辑』」；规则开关决定片段写入哪些端。只有该端操作成功才翻转，失败时保持原状并在行内与执行记录里写明原因。不可用的端置灰并说明原因（如「DSH 原生没有可写入的 MCP 配置文件」）。
- 格子是开关块，状态用形状 + 颜色编码：主题色实底 + ✓＝存在，虚线框 + ＋＝不存在（可开启，规则用），警示色 + ✕＝损坏（失效软链），斜纹＝锁定或不可用（存在时保留淡色 ✓），旋转圈＝执行中；只读状态格（规则文件、未纳管文件）用 ✓ / ◇ / ✕ / 文档图标并在下方写状态文字。每格 `aria-label` 写明端名与状态。
- 行信息列：展开箭头 + 名称（悬停显示全名）+ 必要徽章，保持一行，空间不足只截断名称；下方一行灰色说明（来源、版本、命令或路径，过长截断）。行末是图标按钮：MCP「编辑」、规则「上移 / 下移 / 删除」；没有「更多」菜单。
- 执行中：被点的格子 / 按钮显示进行时；写操作串行，执行期间其他写操作禁用。提示条与执行记录只属于触发它们的视图；执行记录默认折叠为一行摘要，失败时自动展开。

## 各视图

1. **Skills**：只读。行 = 4 端 Skills 目录里出现过的 Skill 名称（按名称合并）。分组依次为「需处理」（只在部分端、各端内容不同或有失效软链）、「4 端一致」（默认折叠，搜索或筛选时自动展开）。格子标签写明实体目录或软链指向。安装、同步与删除由用户在各端手工处理。
   - 各端是不同的副本（真实路径不同）时，行内提示「各端内容不同」，展开可看各端路径。失效软链显示 ✕。
2. **MCP**：行 = 3 端 MCP 配置里出现过的 Server key（Codex `config.toml`、Claude Code `.claude.json`、Antigravity `mcp_config.json`）。DSH 原生列恒为不可用（没有可写入的 MCP 配置文件）。
   - 移除：点亮的格子点击后行内确认，从该端配置移除这个 key（`mcp.remove`，局部修改，不动其他条目）。没有该 key 的端不能点亮，写入其他端用「编辑」勾选。
   - 「添加 MCP」表单手工填写（key、传输方式、命令与参数或 URL、Key-Value 环境变量、写入哪些端）；行末「编辑」以第一个已有该 key 的端为底稿修改（表单写明底稿来自哪一端），写回所选端时翻译成各端格式（command / args / env / url / headers 互通，环境变量引用 `${KEY}` 与 Codex `env_vars` 互转），并保留各端原有的未建模字段（如 `alwaysLoad`）。各端配置不同时默认只勾选底稿所在的端，避免一次编辑抹平各端有意保留的差异。环境变量每行可切换「各端相同 / 按端不同」：按端不同时每个勾选的端各填一个值（如 `HINDSIGHT_MCP_HARNESS` 在 Codex 写 `codex`、Claude Code 写 `claude-code`），新勾选的端先沿用共用值，留空同样表示引用宿主机变量；编辑时各端取值不同的变量自动切到按端不同并填入各端现有值。保存时前端按端发送各自的定义（`mcp.save` 的 `specs`）。表单右侧「将写入」按端显示写入内容（与服务端同一份渲染函数 `src/mcp-render.mjs`，Codex 以 TOML 示意，含保留的未建模字段）；每个端卡片写明「底稿所在端 / 已配置 / 配置不同 · 勾选会覆盖 / 未配置 · 将新增」。
   - 分组：「需处理」（只在部分可写端或各端配置不同）、「N 端一致」（默认折叠）。展开行逐字段对比各端（传输方式、命令、参数、地址、环境变量、其他字段），不同的字段高亮；环境变量只显示变量名，不在页面显示值。
   - 归一化定义（命令、参数、URL、环境变量名、请求头）不同时行内中性提示「各端配置不同」，展开查看各端配置；只是环境变量的值不同视为有意为之，算一致（对比表仍高亮该变量）。
3. **插件**：只读。插件由用户用各端原生命令手工安装（「本机路径」下拉给出各端命令：`codex plugin`、`claude plugin`（取配置的 claudeCommand）、`agy plugin`），页面不提供安装、卸载、更新，也不提供市场的添加、移除、刷新与浏览。
   - **已安装**组：行 = 任一端已装的插件（`名称@市场`；Antigravity 没有市场名，按名称并入），版本取自各端记录（Claude Code `installed_plugins.json`、Codex `config.toml` 的 `[plugins."…"]` 与插件缓存、Antigravity `~/.gemini/config/plugins/`），只读文件，不调用任何插件 CLI。4 端格子是只读状态格（`MatrixCells`，`role="img"`）：已安装显示 ✓（标签写明版本），未安装与 DSH 原生显示短横（标签写明「未安装」或「没有插件机制」），不出现可开启的「+」。没有行末动作，矩阵用两列网格。
   - Codex 内置市场（`openai-bundled`、`openai-primary-runtime`）的插件归入单独的折叠组，不与第三方插件混排。
4. **规则**：规则由多条片段组成，开关决定写入哪些端，各端文件严格等于开启片段按顺序拼接（去首尾空行、空行分隔）。
   - 展开片段编辑标题与正文；上移 / 下移；删除（行内确认）；「新建片段」。
   - 只写拼接结果因本次操作而变化的端；某端没有开启的片段时不改动该端文件；会覆盖外部修改时先确认。
   - 「各端文件」行显示每端状态（已同步 / 外部修改 / 未创建 / 待拆软链 / 读取异常 / 不改动），「同步 N 端」显式重写待同步的端（先确认）。
   - 布局为左矩阵 + 右侧常驻「最终写入预览」（分段按钮切端，待同步的端带点）；预览的端有外部修改时并列「纳管为片段」与「同步覆盖」。
   - 本机指令文件与片段不一致（或没有片段）时可「纳管」：全文导入为只对该端开启的片段并关闭该端其他片段，文件内容不变；软链文件写入时拆分为独立文件，原链接目标不受影响。
   - 旧的「公共 + 私有」内容自动迁移为片段，拼接结果逐字节不变，旧文件保留。

## 失败与重试

- 前端能判断的错误不发请求：如 MCP 表单的必填项与 key 格式，错误写在对应输入框下方；服务端仍返回 400 时把 message 放到同一位置，不只显示在页面顶部。
- 逐端执行的动作（如规则写入多端）一端失败不影响另一端；结果 `ok: false` 时用警示提示，失败的端在行内标明原因，主按钮变为「重试 N 端」，只重试失败的端，成功的端不重复执行。
- 规则：`rules.save` 返回 `saved`（片段已存储，草稿即可清除）与 `ok`（所有需要写入的端都成功）；`rules.sync` 同样返回 `ok`。某端写入失败时提示条用警示色，「各端文件」该端显示「写入失败」（来自本次执行记录，下一次写入成功后消失），并提供「重试写入」，只对失败的端调用 `rules.sync`。
- 纳管读取失败（`rules.import` 抛错）时什么都没改，错误显示在该行内：文件不存在或失效软链给「刷新」，其余给「重试」。
- 有失败时执行记录自动展开，失败的步骤排在最前；部分失败的提示条用警示色。

## 设计边界

- 对 `config.toml`、`.claude.json`、`mcp_config.json` 的写入采用局部合并与原子替换，绝不覆盖无关配置，也绝不删除用户没有关闭的条目。
- 不改动任何 Skills 目录：Skills 只读。
- 插件只读取各端记录，不调用任何插件 CLI，也不改写各端插件记录与 hooks 配置。
- 规则文件写入严格等于开启片段的拼接；软链目标原子拆分为独立文件；没有开启片段时跳过写入。
- 浏览器与本地后台交互仅限本机回环地址，写操作强制校验会话令牌 `x-agent-pkg-key` 且串行排队。页面状态里包含各端 MCP 配置中的环境变量值（编辑表单需要），只经本机回环地址传给本页面。
- 唯一的外部命令是 reclaude 账号探测（`reclaude status --json`，只读、带超时）；`state()` 只读文件，不调用插件或其他 CLI。
