# dsh-agent-packages

面向 DeepSeek Harness（DSH）的多 Harness 统一管理插件：在 Codex、Claude Code、Antigravity、DSH 原生之间查看并同步 Skills、MCP、插件与规则（全局指令）。

## 核心能力

- **本机配置即真相**：不维护清单与锁文件。页面每次读取 4 端（Codex、Claude Code、Antigravity、DSH 原生）的真实目录与配置文件，按名称合并列出 Skills、MCP 与插件；手工安装的条目刷新后即出现，可直接同步到其他端。只有规则片段由本插件存储（`<DSH_HOME>/dsh-agent-packages/instructions/snippets.json`）。
- **条目 × 端矩阵**：Skills / MCP / 插件 / 规则 4 个视图，每行一个条目、右侧 4 列对齐各端，格子是开关：点亮立即同步，熄灭先行内确认；只有该端操作成功、且重新读取记录确认生效后才翻转。
- **Skills**：开启某端 = 在该端 Skills 目录建软链指向已有内容（优先实体目录）；关闭软链直接删除，实体目录移入回收目录 `<DSH_HOME>/dsh-agent-packages/trash/`（不直接删除），仍被其他端软链引用的目录拒绝关闭。
- **MCP**：读取 Codex `config.toml`、Claude Code `.claude.json`、Antigravity `mcp_config.json`；开启某端 = 把已有配置翻译成该端格式写入（环境变量引用 `${KEY}` 与 Codex `env_vars` 互转）；支持手工添加与编辑，写回时保留各端原有的未建模字段（如 `alwaysLoad`）。全部写入局部合并、原子替换。
- **插件**：参照各端原生流程「先添加市场再安装插件」。Claude Code 用 `plugin marketplace add` / `plugin install|uninstall|update`（经 dsh-harness-provider 配置的 `claudeCommand` 与 `CLAUDE_CONFIG_DIR`），Codex 用 `plugin marketplace add|upgrade` / `plugin add|remove`，Antigravity 内置市场用 `plugin install 名称@市场`、其他市场用本地插件目录安装（agy 会转换 Claude Code 格式）。市场里的插件来自本地 `marketplace.json`，展开即可浏览并安装。所有 CLI 调用带超时、关闭 stdin，避免等待交互。
- **规则（AGENTS.md / CLAUDE.md）**：规则由多条片段组成，开关决定写入哪些端，各端文件严格等于开启片段按顺序拼接；只写拼接结果有变化的端，覆盖外部修改前确认；本机文件可原样纳管为片段；旧的「公共 + 私有」内容自动迁移（逐字节一致，旧文件保留）。软链目标原子拆分为独立文件。
- **不做的事**：不从 GitHub 安装 Skills / MCP、不解析仓库、不调用 AI 分析、不管理 CLI 工具（如 codegraph）的安装升级、不查 Skills / MCP 的远端版本。
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
