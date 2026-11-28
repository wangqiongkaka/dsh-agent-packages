import { dirname, join } from 'node:path';
import { HARNESS_IDS, HARNESS_META, resolveClaudeCodePaths, resolveHarnessPaths } from './constants.mjs';
import { MARKETPLACE_SOURCE_RE, composeSnippets } from './shared.mjs';
import { MODELED_KEYS } from './mcp-render.mjs';
import { defaultExecFile, runCommand } from './cli.mjs';
import { listSkills, toggleSkill } from './skills.mjs';
import { listMcp, mcpHarnesses, saveMcp, toggleMcp } from './mcp.mjs';
import {
  PLUGIN_HARNESSES,
  PLUGIN_NAME_RE,
  listMarketplacePlugins,
  listPlugins,
  marketplaceArgv,
  pluginArgv,
  pluginBlockReason,
} from './plugins.mjs';
import {
  InstructionsStore,
  buildInstructionsState,
  importInstructionFromHarness,
  syncInstructions,
} from './instructions.mjs';
import { HttpError } from './http.mjs';
import { isReclaudeCommand, reclaudeConfigDir } from './claude-command.mjs';

// owner/repo[@ref]、HTTPS / SSH Git 地址或本地绝对路径

const label = harnessId => HARNESS_META[harnessId]?.label ?? harnessId;

// 插件命令需要的环境：Claude Code 用 dsh-harness-provider 指定的配置目录，Codex 用非默认的 CODEX_HOME
function cliEnv(paths, harnessId) {
  if (harnessId === 'claude-code' && paths['claude-code'].explicitConfigDir) {
    return { CLAUDE_CONFIG_DIR: paths['claude-code'].explicitConfigDir };
  }
  if (harnessId === 'codex') {
    const codexHome = dirname(paths.codex.mcpFile);
    if (codexHome !== join(paths.home, '.codex')) return { CODEX_HOME: codexHome };
  }
  return {};
}

function serializeSkills({ rows, errors }, provides) {
  return {
    errors,
    rows: rows.map(row => ({
      name: row.name,
      providedBy: provides.skills[row.name] ?? [],
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
    this.trashDir = join(this.root, 'trash');
    this.instructionsStore = new InstructionsStore(this.root);
    const staticClaudeConfigDir = typeof options.claudeConfigDir === 'string' ? options.claudeConfigDir.trim() : '';
    this.harnessPaths = resolveHarnessPaths({
      homeDir: options.homeDir,
      dshHome: options.dshHome,
      codexHome: options.codexHome,
      claudeConfigDir: staticClaudeConfigDir,
    });
    this.execImpl = options.execImpl ?? defaultExecFile;
    this.runCommand = options.runCommand ?? runCommand;
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

  async pluginView(paths) {
    const { plugins, marketplaces, provides } = await listPlugins(paths);
    const marketplaceOf = name => marketplaces.find(item => item.name === name);
    return {
      marketplaces,
      provides,
      plugins: plugins.map(row => {
        const localDir = row.harnesses['claude-code']?.installPath || row.harnesses.codex?.installPath || '';
        return {
          ...row,
          blocked: Object.fromEntries(HARNESS_IDS.map(h => [h, pluginBlockReason({
            harness: h,
            marketplace: row.marketplace,
            marketplaceRow: marketplaceOf(row.marketplace),
            localDir,
            installed: Boolean(row.harnesses[h]),
          })])),
        };
      }),
    };
  }

  async state() {
    const paths = await this.currentHarnessPaths();
    const [skills, mcp, plugins, instructions] = await Promise.all([
      listSkills(paths),
      listMcp(paths),
      this.pluginView(paths),
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
        // 各端插件 CLI 的命令名；Antigravity 固定为 agy（见 plugins.mjs）
        command: paths[id].command ?? (id === 'antigravity' ? 'agy' : ''),
      })),
      trashDir: this.trashDir,
      skills: serializeSkills(skills, plugins.provides),
      mcp: {
        errors: mcp.errors,
        rows: mcp.rows.map(row => ({
          key: row.key,
          providedBy: plugins.provides.mcp[row.key] ?? [],
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

  // 执行一条 CLI 命令并记成一步执行记录；失败不抛出，由调用方按步骤结果判断
  async runStep(paths, harnessId, argv) {
    try {
      const { command, stdout, stderr } = await this.runCommand(argv, { env: cliEnv(paths, harnessId) });
      return { harness: harnessId, status: 'ok', command, detail: '命令执行成功', output: (stdout || stderr).trim().slice(-2000) };
    } catch (error) {
      return { harness: harnessId, status: 'error', command: argv.join(' '), detail: error.message };
    }
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
      case 'skill.toggle': {
        const harness = harnessOf(input.harness);
        const owners = (await listPlugins(await currentPaths())).provides.skills[input.name];
        if (owners?.length) throw new HttpError(400, `「${input.name}」由插件 ${owners.join('、')} 提供，请在「插件」视图把插件安装到其他端`);
        try {
          const { detail } = await toggleSkill({ harnessPaths: await currentPaths(), name: input.name, harness, on: Boolean(input.on), trashDir: this.trashDir });
          return done(detail, [{ harness, status: 'ok', detail }]);
        } catch (error) {
          return done(`「${input.name}」在 ${label(harness)} 未变更：${error.message}`, [{ harness, status: 'error', detail: error.message }], false);
        }
      }

      case 'mcp.toggle': {
        const harness = harnessOf(input.harness);
        const owners = (await listPlugins(await currentPaths())).provides.mcp[input.key];
        if (owners?.length) throw new HttpError(400, `「${input.key}」由插件 ${owners.join('、')} 提供，请在「插件」视图把插件安装到其他端`);
        try {
          const { detail, warn = false } = await toggleMcp({ harnessPaths: await currentPaths(), key: input.key, harness, on: Boolean(input.on) });
          // warn：写入成功但需要人去核对（如按端不同的变量被照常复制），提示条用警示色且不自动消失
          return { ...await done(detail, [{ harness, status: 'ok', detail }]), warn };
        } catch (error) {
          return done(`「${input.key}」在 ${label(harness)} 未变更：${error.message}`, [{ harness, status: 'error', detail: error.message }], false);
        }
      }

      case 'mcp.save': {
        const owners = (await listPlugins(await currentPaths())).provides.mcp[input.key];
        if (owners?.length) throw new HttpError(400, `「${input.key}」由插件 ${owners.join('、')} 提供，不能在这里编辑`);
        try {
          const { steps } = await saveMcp({ harnessPaths: await currentPaths(), key: input.key, spec: input.spec, specs: input.specs, harnesses: input.harnesses });
          return done(`已把「${input.key}」写入 ${steps.map(step => label(step.harness)).join('、')}`, steps);
        } catch (error) {
          throw new HttpError(400, error.message);
        }
      }

      case 'plugin.toggle': {
        const harness = harnessOf(input.harness);
        const name = String(input.name ?? '');
        const marketplace = String(input.marketplace ?? '');
        if (!PLUGIN_NAME_RE.test(name) || (marketplace && !PLUGIN_NAME_RE.test(marketplace))) throw new HttpError(400, '插件名或市场名不合法');
        const on = Boolean(input.on);
        const p = await currentPaths();
        const view = await this.pluginView(p);
        const row = view.plugins.find(item => item.name === name && (!marketplace || item.marketplace === marketplace || !item.marketplace));
        const marketplaceRow = view.marketplaces.find(item => item.name === marketplace);
        const installed = Boolean(row?.harnesses[harness]);
        if (on === installed) return done(`「${name}」在 ${label(harness)} ${on ? '已安装' : '未安装'}，无需操作`);
        let localDir = row?.harnesses['claude-code']?.installPath || row?.harnesses.codex?.installPath || '';
        if (on && !localDir && marketplace && harness === 'antigravity') {
          localDir = (await listMarketplacePlugins(p, marketplace).catch(() => [])).find(item => item.name === name)?.localDir || '';
        }
        const reason = pluginBlockReason({ harness, marketplace, marketplaceRow, localDir, installed });
        if (reason) throw new HttpError(400, reason);
        const argv = pluginArgv({
          harness,
          action: on ? 'install' : 'uninstall',
          name,
          marketplace,
          localDir,
          agyBuiltin: Boolean(marketplaceRow?.harnesses.antigravity?.builtin),
          claudeCommand: p['claude-code'].command,
          codexCommand: p.codex.command,
        });
        const step = await this.runStep(p, harness, argv);
        if (step.status !== 'ok') return done(`「${name}」在 ${label(harness)} ${on ? '安装' : '卸载'}失败`, [step], false);
        // 状态以各端记录为准：命令返回成功但记录没变时如实提示，不翻转开关
        const after = (await this.pluginView(p)).plugins.find(item => item.name === name && (!marketplace || item.marketplace === marketplace || !item.marketplace));
        const changed = Boolean(after?.harnesses[harness]) === on;
        return done(
          changed
            ? `已${on ? '在' : '从'} ${label(harness)} ${on ? '安装' : '卸载'}「${name}」`
            : `命令执行成功，但 ${label(harness)} 的插件记录没有变化，请查看执行记录`,
          [step],
          changed,
        );
      }

      case 'plugin.update': {
        const p = await currentPaths();
        const view = await this.pluginView(p);
        const row = view.plugins.find(item => item.id === input.id);
        if (!row?.harnesses['claude-code']) throw new HttpError(400, '只有已装在 Claude Code 的插件支持原生更新；Codex 与 Antigravity 请刷新市场后重新安装');
        const step = await this.runStep(p, 'claude-code', pluginArgv({ harness: 'claude-code', action: 'update', name: row.name, marketplace: row.marketplace, claudeCommand: p['claude-code'].command }));
        return done(step.status === 'ok' ? `已更新 Claude Code 的「${row.name}」` : `更新「${row.name}」失败`, [step], step.status === 'ok');
      }

      case 'marketplace.toggle': {
        const harness = harnessOf(input.harness);
        if (harness !== 'claude-code' && harness !== 'codex') throw new HttpError(400, `${label(harness)} 不支持添加或移除市场`);
        const on = Boolean(input.on);
        const p = await currentPaths();
        const { marketplaces } = await listPlugins(p);
        const row = marketplaces.find(item => item.name === input.name);
        if (!row) throw new HttpError(404, `没有名为「${input.name}」的市场`);
        if (on === Boolean(row.harnesses[harness])) return done(`${label(harness)} ${on ? '已添加' : '未添加'}市场「${row.name}」，无需操作`);
        if (on && !row.source) throw new HttpError(400, `不知道市场「${row.name}」的来源，请用「添加市场」填写`);
        const step = await this.runStep(p, harness, marketplaceArgv({ harness, action: on ? 'add' : 'remove', name: row.name, source: row.source, claudeCommand: p['claude-code'].command, codexCommand: p.codex.command }));
        if (step.status !== 'ok') return done(`市场「${row.name}」在 ${label(harness)} ${on ? '添加' : '移除'}失败`, [step], false);
        const after = (await listPlugins(p)).marketplaces.find(item => item.name === row.name);
        const changed = Boolean(after?.harnesses[harness]) === on;
        return done(changed ? `已${on ? '在' : '从'} ${label(harness)} ${on ? '添加' : '移除'}市场「${row.name}」` : `命令执行成功，但 ${label(harness)} 的市场记录没有变化，请查看执行记录`, [step], changed);
      }

      case 'marketplace.add': {
        const source = String(input.source ?? '').trim();
        if (!MARKETPLACE_SOURCE_RE.test(source)) throw new HttpError(400, '市场来源请填写 owner/repo、Git 地址或本地绝对路径');
        const targets = (Array.isArray(input.harnesses) ? input.harnesses : []).filter(h => h === 'claude-code' || h === 'codex');
        if (!targets.length) throw new HttpError(400, '至少选择 Claude Code 或 Codex 中的一端');
        const p = await currentPaths();
        const steps = [];
        for (const harness of targets) {
          steps.push(await this.runStep(p, harness, marketplaceArgv({ harness, action: 'add', source, claudeCommand: p['claude-code'].command, codexCommand: p.codex.command })));
        }
        const failed = steps.filter(step => step.status !== 'ok');
        return done(failed.length ? `添加市场 ${source}：${failed.length} 端失败，请查看执行记录` : `已添加市场 ${source}`, steps, !failed.length);
      }

      case 'marketplace.refresh': {
        const p = await currentPaths();
        const row = (await listPlugins(p)).marketplaces.find(item => item.name === input.name);
        if (!row) throw new HttpError(404, `没有名为「${input.name}」的市场`);
        const steps = [];
        for (const harness of ['claude-code', 'codex'].filter(h => row.harnesses[h])) {
          steps.push(await this.runStep(p, harness, marketplaceArgv({ harness, action: 'refresh', name: row.name, claudeCommand: p['claude-code'].command, codexCommand: p.codex.command })));
        }
        if (!steps.length) throw new HttpError(400, `市场「${row.name}」是 Antigravity 内置市场，由 Antigravity 自行更新`);
        const failed = steps.filter(step => step.status !== 'ok');
        return done(failed.length ? `刷新市场「${row.name}」：${failed.length} 端失败` : `已刷新市场「${row.name}」`, steps, !failed.length);
      }

      case 'marketplace.plugins': {
        const p = await currentPaths();
        try {
          return { plugins: await listMarketplacePlugins(p, String(input.name ?? '')) };
        } catch (error) {
          throw new HttpError(404, error.message);
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
