# dsh-agent-packages

面向 DeepSeek Harness（DSH）的多 Harness Skills & MCP Server 统一版本与安装管理插件。

## 核心能力

- **单一清单 + 锁文件**：在 `<DSH_HOME>/dsh-agent-packages/` 下维护 `packages.json` 与 `packages.lock.json`，不强制搬运所有文件，按各 Harness 各自机制安装与升级。
- **支持 4 个 Harness 目标**：Codex（`~/.codex/skills`、`~/.codex/config.toml`）、Claude Code（`~/.claude/skills`、`~/.claude.json`）、Antigravity（`~/.gemini/config/skills`、`~/.gemini/config/mcp_config.json`）、DSH 原生（`~/.dsh/skills`）。
- **四种包类型**：
  1. `skills-repo`：指定 GitHub 仓库与 `ref`（Tag/分支/Commit），自动检出并将发现的 `SKILL.md` 软链或复制到目标 Harness；卸载时仅清理受管路径。
  2. `plugin`：插件式 Skills（如 ponytail），仓库带 `.claude-plugin/`、`.codex-plugin/` 或 `.agents/plugins/` 清单。安装、升级、卸载调用各 Harness 自己的插件命令（`claude plugin`、`codex plugin`、`agy plugin`），插件声明的 Hooks、命令与 Skills 由 Harness 一并注册和清理，本插件不直接改写 hooks 配置。插件已装在某端时，「安装」「全部同步」和重复添加都不会再次执行安装命令。Codex 需在 `/hooks` 中信任插件 Hooks 后生效；DSH 原生暂无插件机制，会跳过。
  3. `mcp`：关联 GitHub 仓库与锁定版本号，支持 `{{version}}` 模板变量，安全局部更新 Codex TOML（保留原注释与其他节）和 Claude / Antigravity JSON（原子写入、不覆盖运行时状态）。
  4. `installer`：针对自带安装器/插件生命周期的复合项目，按 Harness 配置各自的 `install` / `upgrade` / `uninstall` 命令统一调度。
- **GitHub 仓库解析**：输入 `owner/repo` 或完整 URL 自动识别仓库类型、最新 Release / Commit、Skills 列表、插件清单及其安装时注册的 Hooks、npm/Python MCP 信息及 README 中的分端安装命令。
- **只通过添加进入清单**：粘贴 GitHub 地址解析后添加。添加时可以重命名（包 ID 留空时按名称生成，与已有包冲突时提示重命名）；保存前按包类型和插件清单检查各 Harness 是否支持，不支持的端显示原因，勾选后禁止保存（为该端填写自定义安装命令后可装）；同一来源再次添加只更新名称与目标端（锁定版本不变，版本变化走升级），不重复安装。
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
