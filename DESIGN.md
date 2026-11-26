# Skills & MCP 统一包管理页（dsh-agent-packages）

## 挂载与整体风格

- 使用 DSH 正式设置分类插槽 `settings.section`（`id: 'dsh-agent-packages'`，`order: 28`，标签 `Skills & MCP`），紧邻 `Harness`（25）与 `Hindsight`（30）；服务端关闭自动配置页（`settings.configure({ auto: false })`），避免重复入口。
- 全面复用 DSH 主题变量（`--dsw-alias-border-l2`、`--dsw-alias-label-primary`、`--dsw-alias-label-secondary`、`--dsw-alias-bg-layer-1`、`--dsw-alias-state-active-primary`、`--dsw-alias-state-error-primary`、`--dsw-alias-state-success-primary`）与 `@deepseek-ai/dsh-client-ui-primitives` 的 `Button` 组件，天然适配明暗主题，充分使用设置页可用宽度。
- 所有字段配有可访问 `<label>`；错误使用 `role="alert"`；操作结果使用 `role="status"`；按钮文案不折行；窄屏（`<= 720px`）自动换行堆叠，不出现横向溢出。

## 信息架构

1. **顶部工具栏与汇总带**
   - 展示标题、简洁说明、已纳管数量 / 可升级数量 / 待处理数量，以及高频全局按钮：「添加包」「检查更新」「预览同步」「全部同步」。
2. **双视图切换（Tablist）**
   - **包清单（Packages）**：支持按类型（全部 / Skills / 插件 / MCP / 安装器）与搜索词过滤。每条记录以清晰的行卡呈现：包名、类型标签、GitHub 地址、锁定版本与远端最新版对比、4 个 Harness（Codex / Claude Code / Antigravity / DSH）安装状态徽章、以及快捷操作（安装 / 升级 / 编辑 / 卸载）。
   - **本机扫描与诊断（Doctor）**：只读扫描 4 个 Harness 本机现有 Skills、已装插件和 MCP 配置，列出已纳管、未纳管与异常项。不提供本机导入，包只能通过「添加包」进入清单。
3. **添加 / 编辑面板**
   - 顶部支持粘贴 GitHub 地址点击「解析仓库」，自动探测仓库类型（`skills-repo` / `plugin` / `mcp` / `installer`；带插件清单的仓库优先识别为 `plugin`，并提示安装时会注册的 Hooks 事件）、最新版本、包含的 Skills、以及从 README 中提取的各 Harness 安装命令。
   - 名称可重命名：重新解析仓库不覆盖已改的名称；包 ID 留空时按名称生成，与其他来源的包冲突时提示重命名。
   - 目标 Harness 做前置检查：插件按仓库插件清单判断可装的端，DSH 原生无插件机制，MCP 不支持 DSH 原生；不支持的端显示原因；勾选后显示错误并禁用保存，服务端同样拒绝；为该端填写自定义安装命令后视为可装。
   - 同一来源（插件按「插件名@市场」，其他按仓库）再次添加只更新原条目的名称与目标端，锁定版本和自定义命令不变（版本变化走升级）；已装插件的端不重复执行安装命令。
   - 支持按 Harness 勾选目标、选择“内置适配器”或“自定义安装/升级/卸载命令”、编辑 MCP 配置参数与环境变量名引用（明文密钥不进入清单）。
   - 提供「仅保存」「预览变更（Dry-Run）」「保存并安装」清晰路径。
4. **操作反馈与日志面板**
   - 每次同步、安装、升级、卸载或 Dry-Run 预览后，展示可折叠的结构化执行记录（目标 Harness、动作、受影响文件或执行的命令、结果与错误摘要）。

## 设计边界

- 所有对本机 `~/.codex/config.toml`、`~/.claude.json`、`~/.gemini/config/mcp_config.json` 的写入均采用局部合并与原子替换，绝不覆盖无关配置，也绝不删除非受管条目。
- 浏览器与本地后台交互仅限本机回环地址，写操作强制校验会话令牌 `x-agent-pkg-key` 且串行排队。
