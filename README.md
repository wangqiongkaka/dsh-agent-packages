# dsh-agent-packages

面向 DeepSeek Harness（DSH）的多 Harness Skills & MCP Server 统一版本与安装管理插件。

## 核心能力

- **单一清单 + 锁文件**：在 `<DSH_HOME>/dsh-agent-packages/` 下维护 `packages.json` 与 `packages.lock.json`，不强制搬运所有文件，按各 Harness 各自机制安装与升级。
- **支持 4 个 Harness 目标**：Codex（`~/.codex/skills`、`~/.codex/config.toml`）、Claude Code（默认 `~/.claude/skills`、`~/.claude.json`；当 `dsh-harness-provider` 设置了 `claudeConfigDir`、环境变量设置了 `CLAUDE_CONFIG_DIR` 或使用 `reclaude` 时，统一读取该配置目录下的 `skills/`、`.claude.json`、`plugins/`）、Antigravity（`~/.gemini/config/skills`、`~/.gemini/config/mcp_config.json`）、DSH 原生（`~/.dsh/skills`）。
- **四种包类型**：
  1. `skills-repo`：指定 GitHub 仓库与 `ref`（Tag/分支/Commit），自动检出并将发现的 `SKILL.md` 软链或复制到目标 Harness；卸载时仅清理受管路径。
  2. `plugin`：插件式 Skills（如 ponytail），仓库带 `.claude-plugin/`、`.codex-plugin/` 或 `.agents/plugins/` 清单。安装、升级、卸载调用各 Harness 自己的插件命令（`claude plugin`、`codex plugin`、`agy plugin`），Claude Code 端沿用 dsh-harness-provider 统一配置的 `claudeCommand`（如 `reclaude`）与 `claudeConfigDir`（执行命令时自动透传 `CLAUDE_CONFIG_DIR`；未显式配置且命令为 `reclaude` 时按其当前账号目录自动兜底）。插件声明的 Hooks、命令与 Skills 由 Harness 一并注册和清理，本插件不直接改写 hooks 配置。插件已装在某端时，「安装」「全部同步」和重复添加都不会再次执行安装命令。Codex 需在 `/hooks` 中信任插件 Hooks 后生效；DSH 原生暂无插件机制，会跳过。
  3. `mcp`：关联 GitHub 仓库与锁定版本号，支持 `{{version}}` 模板变量，安全局部更新 Codex TOML（保留原注释与其他节）和 Claude / Antigravity JSON（原子写入、不覆盖运行时状态）。
  4. `installer`：针对自带 CLI 与多端安装器生命周期的复合项目（如 CodeGraph），支持配置每次操作仅执行一次的全局 CLI 命令（`install` / `upgrade` / `uninstall` / `version` 版本检测）以及各 Harness 的分端接入与卸载命令；全部端卸载完成后才执行全局卸载命令。
- **GitHub 仓库解析与 AI 深度分析**：默认通过静态规则快速识别仓库类型（区分项目自用 `.claude/skills` 与对外分发的 Skills）、最新 Release / Commit、Skills 列表、插件清单及其 Hooks、npm/Python 包与 CLI 安装器命令；也支持在「添加包」面板的「当前解析 · 切换」中全局指定 Codex / Claude Code / Antigravity 及模型，点击「解析仓库」时浅克隆仓库到隔离临时目录进行只读深度分析，为复合型仓库生成各端安装、升级、卸载与版本检测草稿（仅回填供审阅，绝不自动执行）。
- **只通过添加进入清单**：粘贴 GitHub 地址解析后添加。添加时可以重命名（包 ID 留空时按名称生成，与已有包冲突时提示重命名）；保存前按包类型和插件清单检查各 Harness 是否支持，不支持的端显示原因，勾选后禁止保存（为该端填写自定义安装命令后可装）；同一来源再次添加只更新名称与目标端（锁定版本不变，版本变化走升级），不重复安装。
- **全局指令维护（AGENTS.md / CLAUDE.md）**：在 `<DSH_HOME>/dsh-agent-packages/instructions/` 下分别维护跨 Harness 共享的「公共内容（`shared.md`）」与各端独立的「私有内容（`private/<harness>.md`）」，合并后写入 Codex（`~/.codex/AGENTS.md`）、Claude Code（`<claudeConfigDir>/CLAUDE.md`）、Antigravity（`~/.gemini/AGENTS.md`）与 DSH 原生（`~/.dsh/AGENTS.md`）。支持从本机现有文件原样导入、实时预览最终合并内容、Dry-Run 变更预览与全量同步；写入内容严格等于「公共 + 私有」，不再自动保留外部工具注入的标记块（如 CodeGraph 的 `<!-- CODEGRAPH_START -->` 块），遇到软链目标自动拆分为独立文件原子写入且不改动原链接目标。
- **统一版本检查与批量同步**：一键查更新、一键升级、支持 Dry-Run 预览变更，以及只读扫描本机现有 Skills / 插件 / MCP 状态做诊断（不提供本机导入）。
- **DSH 设置管理页**：挂载在「设置 → Skills & MCP」，支持桌面端与窄屏视图。

## 开发与热加载

```bash
npm install
npm run build     # 单次构建服务端 lib/index.js 与客户端 lib/client.js
npm run dev       # 监听 src/ 增量构建到 lib/，配合 DSH @deepseek-ai/dsh-hmr 自动热重载
npm test          # 运行核心逻辑单元测试（全隔离临时目录，不改动本机配置）
npm run test:ui   # 启动无界面 Playwright 验收管理页交互并生成截图
npm run check     # 完整构建 + 单元测试 + UI 验收
```

配合 `~/.dsh/profiles/desktop/cordis.patch.yml` 中的 `@deepseek-ai/dsh-hmr`（监听 `dsh-agent-packages/lib`），在运行 `npm run dev` 或手动执行 `npm run build` 后，DSH 会自动热重载插件服务端与前端页面，无需重启 DSH；服务端重载产生的新会话令牌也会由前端自动静默续期。

## 打包与安装到 DSH

```bash
npm pack
```

生成 `dsh-agent-packages-0.1.0.tgz` 后，可在 DSH 插件管理中安装本地包，或在目标 DSH profile 中引入。
