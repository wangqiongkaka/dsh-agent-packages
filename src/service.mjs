import { HARNESS_IDS, HARNESS_META, resolveClaudeCodePaths, resolveHarnessPaths } from './constants.mjs';
import { composeSnippets } from './shared.mjs';
import { MODELED_KEYS } from './mcp-render.mjs';
import { defaultExecFile } from './cli.mjs';
import { listSkills } from './skills.mjs';
import { listMcp, mcpHarnesses, removeMcp, saveMcp } from './mcp.mjs';
import { PLUGIN_HARNESSES, listPlugins } from './plugins.mjs';
import {
  InstructionsStore,
  buildInstructionsState,
  importInstructionFromHarness,
  syncInstructions,
} from './instructions.mjs';
import { HttpError } from './http.mjs';
import { isReclaudeCommand, reclaudeConfigDir } from './claude-command.mjs';

const label = harnessId => HARNESS_META[harnessId]?.label ?? harnessId;

function serializeSkills({ rows, errors }) {
  return {
    errors,
    rows: rows.map(row => ({
      name: row.name,
      consistent: row.consistent,
      complete: row.complete,
      harnesses: Object.fromEntries(Object.entries(row.harnesses).map(([h, item]) => [h, {
        path: item.path,
        isSymlink: item.isSymlink,
        real: item.real,
        broken: item.broken,
      }])),
    })),
  };
}

export class PackageManagerService {
  constructor(options = {}) {
    if (!options.root) throw new Error('必须提供配置保存目录 root');
    this.root = options.root;
    this.instructionsStore = new InstructionsStore(this.root);
    const staticClaudeConfigDir = typeof options.claudeConfigDir === 'string' ? options.claudeConfigDir.trim() : '';
    this.harnessPaths = resolveHarnessPaths({
      homeDir: options.homeDir,
      dshHome: options.dshHome,
      codexHome: options.codexHome,
      claudeConfigDir: staticClaudeConfigDir,
    });
    this.execImpl = options.execImpl ?? defaultExecFile;
    // Claude Code / Codex 启动命令与配置目录，均可为取值函数以读到 dsh-harness-provider 最新设置
    this.claudeCommand = options.claudeCommand ?? '';
    this.claudeConfigDir = options.claudeConfigDir ?? '';
    this.codexCommand = options.codexCommand ?? '';
  }

  // 每次操作读取最新的 Claude Code / Codex 命令与配置目录：
  // 显式 claudeConfigDir（dsh-harness-provider 设置或入参）> 环境变量 CLAUDE_CONFIG_DIR > reclaude 账号探测兜底 > 默认目录。
  async currentHarnessPaths() {
    const configured = typeof this.claudeCommand === 'function' ? this.claudeCommand() : this.claudeCommand;
    const command = (typeof configured === 'string' && configured.trim()) || 'claude';
    const configuredCodex = typeof this.codexCommand === 'function' ? this.codexCommand() : this.codexCommand;
    const codexCommand = (typeof configuredCodex === 'string' && configuredCodex.trim()) || 'codex';
    const rawConfigDir = typeof this.claudeConfigDir === 'function' ? this.claudeConfigDir() : this.claudeConfigDir;
    let configDir = (typeof rawConfigDir === 'string' && rawConfigDir.trim()) || process.env.CLAUDE_CONFIG_DIR?.trim() || '';
    if (!configDir && await isReclaudeCommand(command)) {
      configDir = (await reclaudeConfigDir(command, this.execImpl)) || '';
    }
    const claude = { ...resolveClaudeCodePaths(this.harnessPaths.home, configDir), command };
    const codex = { ...this.harnessPaths.codex, command: codexCommand };
    return { ...this.harnessPaths, codex, 'claude-code': claude };
  }

  async init() {
    await this.instructionsStore.init();
    await this.instructionsStore.readConfig();
  }

  async state() {
    const paths = await this.currentHarnessPaths();
    const [skills, mcp, plugins, instructions] = await Promise.all([
      listSkills(paths),
      listMcp(paths),
      // 插件由各端原生命令手工安装，这里只读取各端记录
      listPlugins(paths),
      buildInstructionsState({ store: this.instructionsStore, harnessPaths: paths }),
    ]);
    return {
      harnesses: HARNESS_IDS.map(id => ({
        id,
        label: label(id),
        skillsDir: paths[id].skillsDir,
        mcpFile: paths[id].mcpFile,
        instructionsFile: paths[id].instructionsFile,
        supportsMcp: mcpHarnesses(paths).includes(id),
        supportsPlugins: PLUGIN_HARNESSES.includes(id),
        // 各端插件 CLI 的命令名，提示用户手工安装时用哪个命令；Antigravity 固定为 agy
        command: paths[id].command ?? (id === 'antigravity' ? 'agy' : ''),
      })),
      skills: serializeSkills(skills),
      mcp: {
        errors: mcp.errors,
        rows: mcp.rows.map(row => ({
          key: row.key,
          consistent: row.consistent,
          // extras：各端自己的未建模字段（如 alwaysLoad），供编辑预览与对比显示；写回时服务端原样保留
          harnesses: Object.fromEntries(Object.entries(row.harnesses).map(([h, item]) => [h, {
            spec: item.spec,
            extras: Object.fromEntries(Object.entries(item.raw ?? {}).filter(([field]) => !MODELED_KEYS.includes(field) && field !== 'type')),
          }])),
        })),
      },
      plugins,
      instructions,
    };
  }

  async action(input) {
    if (!input || typeof input.type !== 'string') throw new HttpError(400, '缺少操作类型 type');
    let paths;
    const currentPaths = async () => (paths ??= await this.currentHarnessPaths());
    const harnessOf = value => {
      if (!HARNESS_IDS.includes(value)) throw new HttpError(400, `不支持的 Harness：${value}`);
      return value;
    };
    const done = async (message, steps = [], ok = true) => ({ ok, message, steps, state: await this.state() });

    switch (input.type) {
      case 'mcp.remove': {
        const harness = harnessOf(input.harness);
        try {
          const { detail } = await removeMcp({ harnessPaths: await currentPaths(), key: input.key, harness });
          return done(detail, [{ harness, status: 'ok', detail }]);
        } catch (error) {
          return done(`「${input.key}」在 ${label(harness)} 未变更：${error.message}`, [{ harness, status: 'error', detail: error.message }], false);
        }
      }

      case 'mcp.save': {
        try {
          const { steps } = await saveMcp({ harnessPaths: await currentPaths(), key: input.key, spec: input.spec, specs: input.specs, harnesses: input.harnesses });
          return done(`已把「${input.key}」写入 ${steps.map(step => label(step.harness)).join('、')}`, steps);
        } catch (error) {
          throw new HttpError(400, error.message);
        }
      }

      case 'rules.save': {
        if (!Array.isArray(input.snippets)) throw new HttpError(400, '缺少 snippets 数组');
        const before = (await this.instructionsStore.readSnippets()).snippets;
        const saved = await this.instructionsStore.writeSnippets(input.snippets);
        // 只写拼接结果因本次保存而变化的端；没有开启片段的端保持文件原状
        const changed = HARNESS_IDS.filter(h => {
          const next = composeSnippets(saved, h);
          return next && next !== composeSnippets(before, h);
        });
        const steps = changed.length
          ? (await syncInstructions({ store: this.instructionsStore, harnessPaths: await currentPaths(), harnesses: changed })).steps
          : [];
        const errorCount = steps.filter(step => step.status === 'error').length;
        const labels = changed.map(h => HARNESS_META[h].label).join('、');
        // saved：片段已存储（草稿可清除）；ok：所有需要写入的端都成功
        return {
          ok: !errorCount,
          saved: true,
          message: !changed.length
            ? '已保存规则，各端文件无需改动'
            : errorCount
              ? `已保存规则，${errorCount} 端写入失败，请查看执行记录`
              : `已保存规则并写入 ${labels}`,
          steps,
          state: await this.state(),
        };
      }

      case 'rules.sync': {
        const dryRun = Boolean(input.dryRun);
        const result = await syncInstructions({
          store: this.instructionsStore,
          harnessPaths: await currentPaths(),
          harnesses: Array.isArray(input.harnesses) ? input.harnesses : undefined,
          dryRun,
        });
        const errorCount = result.steps.filter(s => s.status === 'error').length;
        const okCount = result.steps.filter(s => s.status === 'ok').length;
        return {
          ok: !errorCount,
          message: dryRun
            ? `规则同步预览完成（涉及 ${result.steps.length} 端）`
            : errorCount
              ? `规则同步结束，其中 ${errorCount} 端失败，请查看执行记录`
              : `规则同步完成（${okCount}/${result.steps.length} 端）`,
          dryRun,
          steps: result.steps,
          state: await this.state(),
        };
      }

      case 'rules.import': {
        const harnessId = typeof input.harness === 'string' ? input.harness.trim() : '';
        if (!HARNESS_IDS.includes(harnessId)) {
          throw new HttpError(400, `不支持的 Harness：${harnessId || '空'}`);
        }
        let imported;
        try {
          imported = await importInstructionFromHarness({ harnessId, harnessPaths: await currentPaths() });
        } catch (error) {
          throw new HttpError(error.message.includes('不存在') ? 404 : 400, error.message);
        }
        return {
          message: `已读取 ${HARNESS_META[harnessId].label} 的 ${HARNESS_META[harnessId].instructionsFileName}`,
          ...imported,
        };
      }

      default:
        throw new HttpError(400, `不支持的操作类型：${input.type}`);
    }
  }
}
