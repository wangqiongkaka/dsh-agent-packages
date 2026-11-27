import { HARNESS_IDS, HARNESS_META, resolveClaudeCodePaths, resolveHarnessPaths } from './constants.mjs';
import { composeSnippets, normalizeVersion, unsupportedReason } from './shared.mjs';
import { access, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { PackageStore, normalizePackage, normalizeRepoUrl, normalizeSettings, slugifyId } from './store.mjs';
import { readCodexMcpServers, readJsonMcpServers, renderMcpConfigForHarness } from './config-editors.mjs';
import { checkPackageUpdate, inspectGitHubRepo } from './github-inspector.mjs';
import {
  applyPackageAction,
  defaultExecFile,
  defaultRunShell,
  discoverPackageSkills,
  probeSharedCliVersion,
  selectedSkillNames,
  syncGitRepo,
} from './installer.mjs';
import { analyzeRepoWithHarness, defaultSpawnWithInput, listAnalyzerModels } from './repo-analyzer.mjs';
import { readInstalledPlugins, scanLocalEnvironment } from './scanner.mjs';
import {
  InstructionsStore,
  buildInstructionsState,
  importInstructionFromHarness,
  syncInstructions,
} from './instructions.mjs';
import { HttpError } from './http.mjs';
import { isReclaudeCommand, reclaudeConfigDir } from './claude-command.mjs';

function sameSource(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'plugin') return a.plugin.name === b.plugin.name && a.plugin.marketplace === b.plugin.marketplace;
  return Boolean(a.repo) && a.repo === b.repo;
}

function findLivePlugin(livePlugins, pkg, harnessId) {
  if (pkg.kind !== 'plugin') return null;
  return (livePlugins[harnessId]?.plugins ?? []).find(
    p => p.name === pkg.plugin.name && (harnessId === 'antigravity' || p.marketplace === pkg.plugin.marketplace)
  ) ?? null;
}

const LOCAL_SKILLS_ID = 'local-skills';
// 本项目 MCP 模型已覆盖的字段；纳管时其余字段存进 overrides，重写配置时原样保留
const MCP_MODELED_KEYS = ['command', 'args', 'env', 'env_vars', 'url', 'headers', 'http_headers'];

function uniquePackageId(packages, base) {
  const root = slugifyId(base) || 'item';
  let id = root;
  for (let n = 2; packages.some(p => p.id === id); n++) id = `${root}-${n}`;
  return id;
}

async function pathExists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function readRawMcpServer(harnessPaths, harnessId, serverName) {
  const target = harnessPaths[harnessId];
  if (!target?.mcpFile) return null;
  const servers = target.mcpFormat === 'toml'
    ? await readCodexMcpServers(target.mcpFile)
    : await readJsonMcpServers(target.mcpFile);
  return servers?.[serverName] ?? null;
}

// 把某端原始 MCP 配置还原成本项目的 mcp 定义；"${KEY}" 形式的值视为宿主机环境变量引用
function mcpSpecFromRaw(serverName, raw) {
  const env = {};
  const envRefs = Array.isArray(raw.env_vars) ? raw.env_vars.map(String) : [];
  if (raw.env && typeof raw.env === 'object') {
    for (const [key, value] of Object.entries(raw.env)) {
      const ref = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(String(value));
      if (ref && ref[1] === key) envRefs.push(key);
      else if (typeof value === 'string' && value !== '') env[key] = value;
    }
  }
  return {
    serverName,
    transport: raw.url ? 'http' : 'stdio',
    command: typeof raw.command === 'string' ? raw.command : '',
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    url: typeof raw.url === 'string' ? raw.url : '',
    env,
    envRefs: [...new Set(envRefs)],
    headers: { ...(raw.headers ?? {}), ...(raw.http_headers ?? {}) },
  };
}

function mcpOverrideFromRaw(raw) {
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !MCP_MODELED_KEYS.includes(key)));
}

// Skills 视图：每个 Skill × 每个端的启用与安装状态
function buildSkillItems(pkg, availableNames, lockEntry, harnessPaths, scan) {
  const names = availableNames.length
    ? availableNames
    : [...new Set([
        ...pkg.skills.include,
        ...HARNESS_IDS.flatMap(h => (lockEntry?.harnesses?.[h]?.managedPaths ?? []).map(p => p.split('/').pop())),
      ])].sort((a, b) => a.localeCompare(b));
  const selectedByHarness = Object.fromEntries(HARNESS_IDS.map(h => [
    h,
    pkg.targets.includes(h) ? selectedSkillNames(pkg, h, names) : [],
  ]));
  return names.map(name => {
    const harnesses = {};
    for (const h of HARNESS_IDS) {
      const hLock = lockEntry?.harnesses?.[h];
      const managedPath = join(harnessPaths[h].skillsDir, name);
      const onDisk = (scan?.harnesses?.[h]?.skills ?? []).some(item => item.name === name && !item.broken);
      const installed = (hLock?.managedPaths ?? []).includes(managedPath) && onDisk;
      const enabled = selectedByHarness[h].includes(name);
      harnesses[h] = {
        enabled,
        status: enabled && hLock?.status === 'failed' ? 'failed'
          : installed ? 'installed'
            : enabled ? 'not-installed'
              : 'unselected',
        lastError: enabled ? (hLock?.lastError || '') : '',
      };
    }
    return { name, harnesses };
  });
}

// 本机扫描结果按资源类型汇总：未纳管（可纳管）、由插件 / 安装器管理（只展示）
function summarizeLocal(scan) {
  const unmanaged = { skills: new Map(), mcp: new Map(), plugins: new Map() };
  const owned = { skills: new Map(), mcp: new Map(), plugins: new Map() };
  const builtinPlugins = new Set();
  const put = (map, key, base, harnessId, detail) => {
    if (!map.has(key)) map.set(key, { ...base, harnesses: {} });
    map.get(key).harnesses[harnessId] = detail;
  };
  for (const h of HARNESS_IDS) {
    const info = scan.harnesses[h];
    if (!info) continue;
    for (const skill of info.skills) {
      if (skill.broken || skill.managedBy) continue;
      const target = skill.ownedBy ? owned.skills : unmanaged.skills;
      put(target, skill.name, { name: skill.name, ownedBy: skill.ownedBy || null }, h, {
        path: skill.path,
        isSymlink: skill.isSymlink,
        sourceRepo: skill.sourceRepo || '',
      });
    }
    for (const server of info.mcpServers) {
      if (server.managedBy) continue;
      const target = server.ownedBy ? owned.mcp : unmanaged.mcp;
      put(target, server.serverName, { name: server.serverName, ownedBy: server.ownedBy || null }, h, { transport: server.transport });
    }
    for (const plugin of info.plugins ?? []) {
      if (plugin.managedBy) continue;
      if (plugin.builtin) { builtinPlugins.add(`${plugin.name}@${plugin.marketplace}`); continue; }
      const target = plugin.ownedBy ? owned.plugins : unmanaged.plugins;
      // 同名不同市场是不同的插件，分行列出；Antigravity 没有市场名，并入第一个同名行
      const key = plugin.marketplace
        ? `${plugin.name}@${plugin.marketplace}`
        : ([...target.keys()].find(k => k.startsWith(`${plugin.name}@`)) || `${plugin.name}@`);
      put(target, key, {
        key,
        name: plugin.name,
        marketplace: plugin.marketplace || target.get(key)?.marketplace || '',
        ownedBy: plugin.ownedBy || null,
      }, h, { version: plugin.version || '', repo: plugin.repo || '', marketplace: plugin.marketplace || '' });
    }
  }
  const list = map => [...map.values()].sort((a, b) => (a.key || a.name).localeCompare(b.key || b.name));
  return {
    scannedAt: scan.scannedAt,
    warnings: scan.warnings,
    harnesses: Object.fromEntries(HARNESS_IDS.map(h => [h, {
      skillsDir: scan.harnesses[h]?.skillsDir || '',
      mcpFile: scan.harnesses[h]?.mcpFile || '',
      instructionsFile: scan.harnesses[h]?.instructionsFile || '',
      mcpError: scan.harnesses[h]?.mcpError || '',
      skillsCount: scan.harnesses[h]?.skillsCount ?? 0,
    }])),
    unmanaged: { skills: list(unmanaged.skills), mcp: list(unmanaged.mcp), plugins: list(unmanaged.plugins) },
    owned: { skills: list(owned.skills), mcp: list(owned.mcp), plugins: list(owned.plugins) },
    builtinPluginCount: builtinPlugins.size,
  };
}

export class PackageManagerService {
  constructor(options = {}) {
    if (!options.root) throw new Error('必须提供配置保存目录 root');
    this.root = options.root;
    this.store = new PackageStore(this.root);
    this.instructionsStore = new InstructionsStore(this.root);
    const staticClaudeConfigDir = typeof options.claudeConfigDir === 'string' ? options.claudeConfigDir.trim() : '';
    this.harnessPaths = resolveHarnessPaths({
      homeDir: options.homeDir,
      dshHome: options.dshHome,
      codexHome: options.codexHome,
      claudeConfigDir: staticClaudeConfigDir,
    });
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.execImpl = options.execImpl ?? defaultExecFile;
    this.runShell = options.runShell ?? defaultRunShell;
    this.spawnImpl = options.spawnImpl ?? defaultSpawnWithInput;
    this.githubToken = options.githubToken;
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
    await this.store.init();
    await this.store.readManifest();
    await this.store.readLock();
    await this.instructionsStore.init();
    await this.instructionsStore.readConfig();
  }

  async state() {
    const [manifest, lock, harnessPaths] = await Promise.all([
      this.store.readManifest(),
      this.store.readLock(),
      this.currentHarnessPaths(),
    ]);
    const instructions = await buildInstructionsState({
      store: this.instructionsStore,
      harnessPaths,
    });
    const hasPlugins = manifest.packages.some(p => p.kind === 'plugin');
    const livePlugins = hasPlugins ? await readInstalledPlugins(harnessPaths) : {};
    let outdatedCount = 0;
    let failedCount = 0;
    let pendingInstallCount = 0;

    const packages = manifest.packages.map(pkg => {
      const lockEntry = lock.packages[pkg.id] ?? {};
      if (lockEntry.updateAvailable) outdatedCount++;
      const harnessStatuses = {};
      const observedVersions = new Set();
      for (const harnessId of HARNESS_IDS) {
        const selected = pkg.targets.includes(harnessId);
        const hLock = lockEntry.harnesses?.[harnessId];
        const status = hLock?.status || (selected ? 'not-installed' : 'unselected');
        if (status === 'failed') failedCount++;
        if (selected && status === 'not-installed') pendingInstallCount++;
        const live = status === 'installed' ? findLivePlugin(livePlugins, pkg, harnessId) : null;
        const installedVersion = live?.version || hLock?.installedVersion || '';
        if (status === 'installed' && installedVersion) observedVersions.add(installedVersion);
        harnessStatuses[harnessId] = {
          selected,
          status,
          method: hLock?.method || ((pkg.commands?.[harnessId]?.install || (pkg.kind === 'installer' && pkg.commands?.shared?.install)) ? 'command' : 'adapter'),
          installedVersion,
          installedCommit: hLock?.installedCommit || '',
          installedAt: hLock?.installedAt || null,
          managedPathsCount: Array.isArray(hLock?.managedPaths) ? hLock.managedPaths.length : 0,
          managedServerKey: hLock?.managedServerKey || null,
          lastError: hLock?.lastError || '',
        };
      }
      const fallbackResolved = observedVersions.size === 1 ? [...observedVersions][0] : '';
      return {
        ...pkg,
        lock: {
          resolvedRef: lockEntry.resolvedRef || '',
          resolvedCommit: lockEntry.resolvedCommit || '',
          resolvedVersion: lockEntry.resolvedVersion || fallbackResolved,
          latestRef: lockEntry.latestRef || '',
          latestCommit: lockEntry.latestCommit || '',
          latestVersion: lockEntry.latestVersion || '',
          updateAvailable: Boolean(lockEntry.updateAvailable),
          checkedAt: lockEntry.checkedAt || null,
          checkError: lockEntry.checkError || '',
        },
        harnessStatuses,
      };
    });

    // 本机扫描是只读的，随 state 一起返回，各视图据此列出未纳管项与诊断提示
    let scan;
    try {
      scan = await scanLocalEnvironment({ harnessPaths, manifest, lock });
    } catch (error) {
      // 扫描是只读辅助信息，失败时降级为空结果加提示，不阻断页面加载
      const warning = { harness: '本机', kind: 'scan-error', message: `本机扫描失败：${error.message}` };
      scan = {
        scannedAt: new Date().toISOString(),
        harnesses: {},
        warnings: [{ ...warning, area: 'skills' }, { ...warning, area: 'mcp' }, { ...warning, area: 'plugins' }],
      };
    }
    for (const pkg of packages) {
      if (pkg.kind !== 'skills-repo') continue;
      let available = [];
      try {
        available = (await discoverPackageSkills(pkg, join(this.store.reposDir, pkg.id))).map(skill => skill.name);
      } catch { available = []; }
      pkg.skillItems = buildSkillItems(pkg, available, lock.packages[pkg.id], harnessPaths, scan);
    }

    return {
      rootDir: this.root,
      manifestFile: this.store.manifestFile,
      lockFile: this.store.lockFile,
      settings: manifest.settings,
      harnesses: HARNESS_IDS.map(id => ({
        ...HARNESS_META[id],
        skillsDir: harnessPaths[id].skillsDir,
        mcpFile: harnessPaths[id].mcpFile,
        instructionsFile: harnessPaths[id].instructionsFile,
      })),
      summary: {
        total: packages.length,
        outdated: outdatedCount,
        failed: failedCount,
        pendingInstall: pendingInstallCount,
      },
      packages,
      instructions,
      local: summarizeLocal(scan),
    };
  }

  async action(input) {
    if (!input || typeof input.type !== 'string') {
      throw new HttpError(400, '缺少操作类型 type');
    }

    let paths;
    const currentPaths = async () => (paths ??= await this.currentHarnessPaths());

    switch (input.type) {
      case 'settings.save': {
        const manifest = await this.store.readManifest();
        const nextSettings = normalizeSettings(
          input.settings ?? { analyzer: input.analyzer },
          manifest.settings
        );
        await this.store.writeManifest({ ...manifest, settings: nextSettings });
        const harnessLabel = nextSettings.analyzer.harness
          ? `${HARNESS_META[nextSettings.analyzer.harness]?.label || nextSettings.analyzer.harness}${nextSettings.analyzer.model ? ` · ${nextSettings.analyzer.model}` : '（默认模型）'}`
          : '静态规则';
        return {
          message: `已保存全局解析配置：${harnessLabel}`,
          settings: nextSettings,
          state: await this.state(),
        };
      }

      case 'analyzer.models': {
        const harness = typeof input.harness === 'string' ? input.harness.trim() : '';
        try {
          const result = await listAnalyzerModels(harness, await currentPaths(), { execImpl: this.execImpl });
          return {
            message: result.error || `已加载 ${HARNESS_META[harness]?.label || harness} 可用模型（${result.models.length}）`,
            ...result,
          };
        } catch (error) {
          throw new HttpError(400, error.message);
        }
      }

      case 'repo.inspect': {
        const manifest = await this.store.readManifest();
        const configured = manifest.settings?.analyzer ?? { harness: '', model: '' };
        const useStaticOnly = input.mode === 'static';
        const analyzerHarness = useStaticOnly
          ? ''
          : (typeof input.harness === 'string' && input.harness.trim()) || configured.harness || '';
        const analyzerModel = useStaticOnly
          ? ''
          : (typeof input.model === 'string' ? input.model.trim() : configured.model || '');

        let inspected = null;
        let staticError = '';
        try {
          inspected = await inspectGitHubRepo(input.repo, {
            fetchImpl: this.fetchImpl,
            execCommand: this.execImpl,
            token: this.githubToken,
          });
        } catch (error) {
          if (!analyzerHarness) throw error;
          staticError = error.message;
        }

        if (!analyzerHarness) {
          return { message: '已解析 GitHub 仓库信息', ...inspected };
        }

        const repoUrl = inspected?.draft?.repo || normalizeRepoUrl(input.repo);
        const analyzed = await analyzeRepoWithHarness({
          repoUrl,
          harness: analyzerHarness,
          model: analyzerModel,
          baseInspection: inspected,
          harnessPaths: await currentPaths(),
          execImpl: this.execImpl,
          spawnImpl: this.spawnImpl,
        });
        if (staticError && analyzed.evidence?.ai) {
          analyzed.evidence.ai.warnings = [
            ...analyzed.evidence.ai.warnings,
            `GitHub API 元信息获取失败，已直接基于克隆源码完成分析（${staticError}）`,
          ];
        }
        const label = `${HARNESS_META[analyzerHarness]?.label || analyzerHarness}${analyzerModel ? ` · ${analyzerModel}` : ''}`;
        return { message: `已通过 ${label} 深度分析仓库`, ...analyzed };
      }

      case 'package.save': {
        const manifest = await this.store.readManifest();
        const rawPkg = input.package;
        if (!rawPkg || typeof rawPkg !== 'object') throw new HttpError(400, '缺少 package 对象');
        const originalId = typeof input.originalId === 'string' ? input.originalId.trim() : '';
        let normalized;
        let existingIndex;
        try {
          if (originalId) {
            existingIndex = manifest.packages.findIndex(p => p.id === originalId);
          } else {
            // 添加幂等：同一来源（插件按 名@市场，其他按仓库）再次添加时更新原条目，不新增重复项
            const probe = normalizePackage(rawPkg);
            existingIndex = manifest.packages.findIndex(p => sameSource(p, probe));
          }
          const existing = existingIndex >= 0 ? manifest.packages[existingIndex] : undefined;
          // 重复添加只采用新名称与目标端；锁定版本、自定义命令等沿用原条目，版本变化走「升级」
          // 编辑面板不提交逐 Skill 目标端、本机 Skill 源目录与纳管 MCP 的额外字段，保存时从原条目继承
          const withPreserved = pkg => (!existing ? pkg : {
            ...pkg,
            skills: {
              ...(pkg.skills ?? existing.skills),
              perHarness: pkg.skills?.perHarness ?? existing.skills.perHarness,
              sources: pkg.skills?.sources ?? existing.skills.sources,
            },
            mcp: { ...(pkg.mcp ?? existing.mcp), overrides: pkg.mcp?.overrides ?? existing.mcp.overrides },
          });
          const next = !existing ? rawPkg
            : originalId ? withPreserved({ ...rawPkg, id: existing.id })
              : { ...existing, name: rawPkg.name || existing.name, targets: rawPkg.targets ?? existing.targets };
          normalized = normalizePackage(next, existing);
        } catch (error) {
          throw new HttpError(400, error.message);
        }
        const duplicate = manifest.packages.find((p, i) => p.id === normalized.id && i !== existingIndex);
        if (duplicate) throw new HttpError(409, `包 ID「${normalized.id}」已被「${duplicate.name}」使用，请重命名或修改包 ID`);
        const blocked = normalized.targets
          .map(h => [h, unsupportedReason(normalized, h)])
          .filter(([, reason]) => reason);
        if (blocked.length) {
          throw new HttpError(400, `前置检查未通过：${blocked.map(([h, reason]) => `${HARNESS_META[h].label}${reason}`).join('；')}。请取消勾选，或为该端填写自定义安装命令后再保存`);
        }
        const reAdded = !originalId && existingIndex >= 0;

        const nextPackages = [...manifest.packages];
        if (existingIndex >= 0) nextPackages[existingIndex] = normalized;
        else nextPackages.push(normalized);
        await this.store.writeManifest({ ...manifest, version: 1, packages: nextPackages });

        let steps = [];
        if (input.installNow) {
          const lock = await this.store.readLock();
          const result = await applyPackageAction({
            pkg: normalized,
            action: 'install',
            lockEntry: lock.packages[normalized.id],
            harnessPaths: await currentPaths(),
            reposDir: this.store.reposDir,
            rootDir: this.root,
            dryRun: Boolean(input.dryRun),
            execImpl: this.execImpl,
            runShell: this.runShell,
          });
          steps = result.steps;
          if (!input.dryRun) {
            lock.packages[normalized.id] = result.lockEntry;
            await this.store.writeLock(lock);
          }
        }
        return {
          message: (reAdded ? `「${normalized.name}」已在清单中，已更新原条目；` : '') + (input.installNow
            ? (input.dryRun ? `已保存「${normalized.name}」并生成安装预览` : `已保存并执行「${normalized.name}」安装`)
            : `已保存包配置「${normalized.name}」`),
          package: normalized,
          steps,
          state: await this.state(),
        };
      }

      case 'package.delete': {
        const manifest = await this.store.readManifest();
        const lock = await this.store.readLock();
        const index = manifest.packages.findIndex(p => p.id === input.id);
        if (index < 0) throw new HttpError(404, `未找到包「${input.id}」`);
        const pkg = manifest.packages[index];
        let steps = [];
        if (input.uninstallFirst) {
          const result = await applyPackageAction({
            pkg,
            action: 'uninstall',
            lockEntry: lock.packages[pkg.id],
            harnessPaths: await currentPaths(),
            reposDir: this.store.reposDir,
            rootDir: this.root,
            dryRun: false,
            execImpl: this.execImpl,
            runShell: this.runShell,
          });
          steps = result.steps;
        }
        manifest.packages.splice(index, 1);
        await this.store.writeManifest(manifest);
        delete lock.packages[pkg.id];
        await this.store.writeLock(lock);
        return {
          message: input.uninstallFirst ? `已卸载并从清单移除「${pkg.name}」` : `已从清单移除「${pkg.name}」`,
          steps,
          state: await this.state(),
        };
      }

      case 'package.install':
      case 'package.uninstall': {
        const manifest = await this.store.readManifest();
        const lock = await this.store.readLock();
        const pkg = manifest.packages.find(p => p.id === input.id);
        if (!pkg) throw new HttpError(404, `未找到包「${input.id}」`);
        const action = input.type === 'package.uninstall' ? 'uninstall' : 'install';
        const dryRun = Boolean(input.dryRun);
        const result = await applyPackageAction({
          pkg,
          action,
          harnesses: Array.isArray(input.harnesses) ? input.harnesses : undefined,
          lockEntry: lock.packages[pkg.id],
          harnessPaths: await currentPaths(),
          reposDir: this.store.reposDir,
          rootDir: this.root,
          dryRun,
          execImpl: this.execImpl,
          runShell: this.runShell,
        });
        if (!dryRun) {
          lock.packages[pkg.id] = result.lockEntry;
          await this.store.writeLock(lock);
        }
        const hasError = result.steps.some(s => s.status === 'error');
        return {
          message: dryRun
            ? `已生成「${pkg.name}」的${action === 'uninstall' ? '卸载' : '安装'}预览`
            : hasError
              ? `「${pkg.name}」部分目标执行失败，请查看下方日志`
              : `「${pkg.name}」${action === 'uninstall' ? '卸载' : '安装'}完成`,
          dryRun,
          steps: result.steps,
          state: await this.state(),
        };
      }

      case 'package.upgrade': {
        const manifest = await this.store.readManifest();
        const lock = await this.store.readLock();
        const index = manifest.packages.findIndex(p => p.id === input.id);
        if (index < 0) throw new HttpError(404, `未找到包「${input.id}」`);
        const current = manifest.packages[index];
        const prevLock = lock.packages[current.id] ?? {};
        const nextRef = typeof input.ref === 'string' && input.ref.trim()
          ? input.ref.trim()
          : (prevLock.latestRef || current.ref);
        const nextVersion = typeof input.version === 'string' && input.version.trim()
          ? input.version.trim()
          : (prevLock.latestVersion || current.version);
        const updatedPkg = normalizePackage({ ...current, ref: nextRef, version: nextVersion }, current);
        const dryRun = Boolean(input.dryRun);

        const result = await applyPackageAction({
          pkg: updatedPkg,
          action: 'upgrade',
          harnesses: Array.isArray(input.harnesses) ? input.harnesses : undefined,
          lockEntry: prevLock,
          harnessPaths: await currentPaths(),
          reposDir: this.store.reposDir,
          rootDir: this.root,
          dryRun,
          execImpl: this.execImpl,
          runShell: this.runShell,
        });

        const hasError = result.steps.some(s => s.status === 'error');
        if (!dryRun && !hasError) {
          manifest.packages[index] = updatedPkg;
          await this.store.writeManifest(manifest);
          lock.packages[updatedPkg.id] = {
            ...result.lockEntry,
            updateAvailable: false,
          };
          await this.store.writeLock(lock);
        } else if (!dryRun) {
          lock.packages[updatedPkg.id] = result.lockEntry;
          await this.store.writeLock(lock);
        }
        return {
          message: dryRun
            ? `已生成「${updatedPkg.name}」升级预览（目标：${nextVersion || nextRef || '最新'}）`
            : hasError
              ? `「${updatedPkg.name}」升级存在失败步骤，未更新版本锁`
              : `已升级「${updatedPkg.name}」至 ${nextVersion || nextRef || '最新版本'}`,
          dryRun,
          steps: result.steps,
          state: await this.state(),
        };
      }

      case 'packages.checkUpdates': {
        const manifest = await this.store.readManifest();
        const lock = await this.store.readLock();
        const targetIds = Array.isArray(input.ids) && input.ids.length ? new Set(input.ids) : null;
        const targets = targetIds ? manifest.packages.filter(p => targetIds.has(p.id)) : manifest.packages;
        const livePlugins = targets.some(p => p.kind === 'plugin')
          ? await readInstalledPlugins(await currentPaths())
          : {};
        let updatedCount = 0;
        let errorCount = 0;
        for (const pkg of targets) {
          const prev = lock.packages[pkg.id] ?? {};
          const observedVersions = [];
          const hasInstalledHarness = HARNESS_IDS.some(h => prev.harnesses?.[h]?.status === 'installed');
          const liveCliVersion = pkg.commands?.shared?.version && hasInstalledHarness
            ? await probeSharedCliVersion(pkg, { runShell: this.runShell, rootDir: this.root })
            : '';
          if (liveCliVersion) observedVersions.push(liveCliVersion);
          const nextHarnesses = liveCliVersion ? { ...(prev.harnesses ?? {}) } : null;
          for (const harnessId of HARNESS_IDS) {
            const hLock = prev.harnesses?.[harnessId];
            if (hLock?.status !== 'installed') continue;
            if (nextHarnesses && liveCliVersion) {
              nextHarnesses[harnessId] = { ...hLock, installedVersion: liveCliVersion };
            }
            const ver = liveCliVersion || findLivePlugin(livePlugins, pkg, harnessId)?.version || hLock.installedVersion || '';
            if (ver) observedVersions.push(ver);
          }
          const checkLock = liveCliVersion
            ? { ...prev, resolvedVersion: liveCliVersion }
            : prev.resolvedVersion || !observedVersions.length
              ? prev
              : { ...prev, resolvedVersion: observedVersions[0] };
          const check = await checkPackageUpdate(pkg, checkLock, {
            fetchImpl: this.fetchImpl,
            execCommand: this.execImpl,
            token: this.githubToken,
          });
          // 若任一已装端版本落后于远端最新版本，也标记为可升级以便同步对齐
          if (!check.updateAvailable && check.latestVersion && observedVersions.some(v => normalizeVersion(v) !== normalizeVersion(check.latestVersion))) {
            check.updateAvailable = true;
          }
          if (check.error) errorCount++;
          if (check.updateAvailable) updatedCount++;
          lock.packages[pkg.id] = {
            ...prev,
            ...(nextHarnesses ? { harnesses: nextHarnesses } : {}),
            ...(liveCliVersion ? { resolvedVersion: liveCliVersion } : checkLock.resolvedVersion && !prev.resolvedVersion ? { resolvedVersion: checkLock.resolvedVersion } : {}),
            latestRef: check.latestRef ?? prev.latestRef ?? '',
            latestCommit: check.latestCommit ?? prev.latestCommit ?? '',
            latestVersion: check.latestVersion ?? prev.latestVersion ?? '',
            updateAvailable: check.updateAvailable,
            checkedAt: check.checkedAt,
            checkError: check.error,
          };
        }
        await this.store.writeLock(lock);
        return {
          message: `已检查 ${targets.length} 个包：${updatedCount} 个可升级${errorCount ? `，${errorCount} 个检查失败` : ''}`,
          state: await this.state(),
        };
      }

      case 'packages.syncAll': {
        const manifest = await this.store.readManifest();
        const lock = await this.store.readLock();
        const dryRun = Boolean(input.dryRun);
        const allSteps = [];
        for (const pkg of manifest.packages) {
          const result = await applyPackageAction({
            pkg,
            action: 'install',
            lockEntry: lock.packages[pkg.id],
            harnessPaths: await currentPaths(),
            reposDir: this.store.reposDir,
            rootDir: this.root,
            dryRun,
            execImpl: this.execImpl,
            runShell: this.runShell,
          });
          for (const step of result.steps) {
            allSteps.push({ packageId: pkg.id, packageName: pkg.name, ...step });
          }
          if (!dryRun) lock.packages[pkg.id] = result.lockEntry;
        }
        if (!dryRun) await this.store.writeLock(lock);
        const errorCount = allSteps.filter(s => s.status === 'error').length;
        return {
          message: dryRun
            ? `预览完成：涉及 ${manifest.packages.length} 个包、${allSteps.length} 条变更步骤`
            : errorCount
              ? `全部同步结束：共 ${allSteps.length} 步，其中 ${errorCount} 步失败`
              : `全部同步完成：已同步 ${manifest.packages.length} 个包`,
          dryRun,
          steps: allSteps,
          state: await this.state(),
        };
      }

      case 'packages.upgradeAll': {
        const manifest = await this.store.readManifest();
        const lock = await this.store.readLock();
        const dryRun = Boolean(input.dryRun);
        const allSteps = [];
        let upgraded = 0;
        for (let i = 0; i < manifest.packages.length; i++) {
          const pkg = manifest.packages[i];
          const prev = lock.packages[pkg.id];
          if (!prev?.updateAvailable) continue;
          const updatedPkg = normalizePackage({
            ...pkg,
            ref: prev.latestRef || pkg.ref,
            version: prev.latestVersion || pkg.version,
          }, pkg);
          const result = await applyPackageAction({
            pkg: updatedPkg,
            action: 'upgrade',
            lockEntry: prev,
            harnessPaths: await currentPaths(),
            reposDir: this.store.reposDir,
            rootDir: this.root,
            dryRun,
            execImpl: this.execImpl,
            runShell: this.runShell,
          });
          for (const step of result.steps) {
            allSteps.push({ packageId: pkg.id, packageName: pkg.name, ...step });
          }
          const hasError = result.steps.some(s => s.status === 'error');
          if (!dryRun && !hasError) {
            manifest.packages[i] = updatedPkg;
            lock.packages[pkg.id] = { ...result.lockEntry, updateAvailable: false };
            upgraded++;
          } else if (!dryRun) {
            lock.packages[pkg.id] = result.lockEntry;
          }
        }
        if (!dryRun) {
          await this.store.writeManifest(manifest);
          await this.store.writeLock(lock);
        }
        return {
          message: dryRun
            ? `已生成可升级包的变更预览（${allSteps.length} 步）`
            : `批量升级完成：已成功升级 ${upgraded} 个包`,
          dryRun,
          steps: allSteps,
          state: await this.state(),
        };
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
        return {
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

      case 'package.toggleHarness': {
        const harnessId = input.harness;
        if (!HARNESS_IDS.includes(harnessId)) throw new HttpError(400, `不支持的 Harness：${harnessId}`);
        const enabled = Boolean(input.enabled);
        const manifest = await this.store.readManifest();
        const lock = await this.store.readLock();
        const index = manifest.packages.findIndex(p => p.id === input.id);
        if (index < 0) throw new HttpError(404, `未找到包「${input.id}」`);
        const pkg = manifest.packages[index];
        const label = HARNESS_META[harnessId].label;
        if (enabled) {
          const reason = unsupportedReason(pkg, harnessId);
          if (reason) throw new HttpError(400, `${label}${reason}`);
        }
        const workPkg = enabled
          ? normalizePackage({ ...pkg, targets: [...new Set([...pkg.targets, harnessId])] }, pkg)
          : pkg;
        const result = await applyPackageAction({
          pkg: workPkg,
          action: enabled ? 'install' : 'uninstall',
          harnesses: [harnessId],
          syncRepo: false,
          lockEntry: lock.packages[pkg.id] ?? {},
          harnessPaths: await currentPaths(),
          reposDir: this.store.reposDir,
          rootDir: this.root,
          dryRun: false,
          execImpl: this.execImpl,
          runShell: this.runShell,
        });
        const step = result.steps.find(item => item.harness === harnessId);
        const failed = result.steps.some(item => item.status === 'error');
        // 只有该端步骤成功才翻转开关；跳过（未配置命令等）保持原状，失败则记录以便重试
        const ok = step?.status === 'ok' && !failed;
        const nextLock = result.lockEntry;
        if (ok && !enabled) {
          delete nextLock.harnesses[harnessId];
        }
        if (ok || (enabled && failed)) {
          const targets = enabled
            ? [...new Set([...pkg.targets, harnessId])]
            : pkg.targets.filter(h => h !== harnessId);
          manifest.packages[index] = normalizePackage({ ...pkg, targets }, pkg);
          await this.store.writeManifest(manifest);
        }
        lock.packages[pkg.id] = nextLock;
        await this.store.writeLock(lock);
        return {
          ok,
          message: ok
            ? `已${enabled ? '在' : '从'} ${label} ${enabled ? '启用' : '移除'}「${pkg.name}」`
            : failed
              ? `「${pkg.name}」在 ${label} ${enabled ? '安装' : '卸载'}失败，请查看执行记录`
              : `「${pkg.name}」在 ${label} 未变更：${step?.detail || '没有可执行的步骤'}`,
          steps: result.steps,
          state: await this.state(),
        };
      }

      case 'skill.toggle': {
        const harnessId = input.harness;
        if (!HARNESS_IDS.includes(harnessId)) throw new HttpError(400, `不支持的 Harness：${harnessId}`);
        const enabled = Boolean(input.enabled);
        const manifest = await this.store.readManifest();
        const lock = await this.store.readLock();
        const index = manifest.packages.findIndex(p => p.id === input.id);
        if (index < 0) throw new HttpError(404, `未找到包「${input.id}」`);
        const pkg = manifest.packages[index];
        if (pkg.kind !== 'skills-repo') throw new HttpError(400, `「${pkg.name}」不是 Skills 来源`);
        const repoDir = join(this.store.reposDir, pkg.id);
        if (pkg.repo && !(await pathExists(repoDir))) {
          await syncGitRepo(pkg.repo, repoDir, pkg.ref, { execImpl: this.execImpl });
        }
        const available = (await discoverPackageSkills(pkg, repoDir)).map(item => item.name);
        const fullSet = pkg.skills.include.length ? available.filter(n => pkg.skills.include.includes(n)) : available;
        const names = input.skill ? [String(input.skill)] : (enabled ? fullSet : available);
        const unknown = names.filter(name => !available.includes(name));
        if (unknown.length) throw new HttpError(404, `「${pkg.name}」中没有 Skill：${unknown.join('、')}`);
        const current = pkg.targets.includes(harnessId) ? selectedSkillNames(pkg, harnessId, available) : [];
        const next = enabled
          ? available.filter(name => current.includes(name) || names.includes(name))
          : current.filter(name => !names.includes(name));
        const perHarness = { ...pkg.skills.perHarness };
        // 选中全部且没有 include 过滤时不写逐端列表，上游新增的 Skill 会自动跟上
        if (pkg.repo && !pkg.skills.include.length && next.length === available.length) delete perHarness[harnessId];
        else perHarness[harnessId] = next;
        if (!next.length) delete perHarness[harnessId];
        const targets = next.length
          ? [...new Set([...pkg.targets, harnessId])]
          : pkg.targets.filter(h => h !== harnessId);
        const nextPkg = normalizePackage({ ...pkg, targets, skills: { ...pkg.skills, perHarness } }, pkg);
        const result = await applyPackageAction({
          pkg: next.length ? nextPkg : pkg,
          action: next.length ? 'install' : 'uninstall',
          harnesses: [harnessId],
          syncRepo: false,
          lockEntry: lock.packages[pkg.id] ?? {},
          harnessPaths: await currentPaths(),
          reposDir: this.store.reposDir,
          rootDir: this.root,
          dryRun: false,
          execImpl: this.execImpl,
          runShell: this.runShell,
        });
        const step = result.steps.find(item => item.harness === harnessId);
        const ok = step?.status === 'ok' && !result.steps.some(item => item.status === 'error');
        const nextLock = result.lockEntry;
        if (ok) {
          if (!next.length) delete nextLock.harnesses[harnessId];
          manifest.packages[index] = nextPkg;
          if (!pkg.repo) {
            // 本机 Skills 组：任何端都不再启用的 Skill 已随最后一个端删除，从组内移除；组空了就整组移除
            const stillUsed = new Set(Object.values(nextPkg.skills.perHarness).flat());
            const sources = Object.fromEntries(Object.entries(nextPkg.skills.sources).filter(([n]) => stillUsed.has(n)));
            manifest.packages[index] = normalizePackage({ ...nextPkg, skills: { ...nextPkg.skills, sources } }, nextPkg);
            if (!Object.keys(sources).length) {
              manifest.packages.splice(index, 1);
              delete lock.packages[pkg.id];
            }
          }
          await this.store.writeManifest(manifest);
        }
        if (manifest.packages.some(p => p.id === pkg.id)) lock.packages[pkg.id] = nextLock;
        await this.store.writeLock(lock);
        const what = input.skill ? `「${input.skill}」` : `「${pkg.name}」的全部 Skill`;
        const label = HARNESS_META[harnessId].label;
        return {
          ok,
          message: ok
            ? `已${enabled ? '在' : '从'} ${label} ${enabled ? '启用' : '移除'}${what}`
            : `${what}在 ${label} ${enabled ? '启用' : '移除'}失败：${step?.detail || '请查看执行记录'}`,
          steps: result.steps,
          state: await this.state(),
        };
      }

      case 'local.adopt': {
        const area = input.area;
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (!name) throw new HttpError(400, '缺少要纳管的名称');
        const harnessPaths = await currentPaths();
        const manifest = await this.store.readManifest();
        const lock = await this.store.readLock();
        const local = summarizeLocal(await scanLocalEnvironment({ harnessPaths, manifest, lock }));
        const now = new Date().toISOString();

        if (area === 'mcp') {
          const entry = local.unmanaged.mcp.find(item => item.name === name);
          if (!entry) throw new HttpError(404, `本机没有未纳管的 MCP「${name}」`);
          const present = HARNESS_IDS.filter(h => entry.harnesses[h]);
          const raws = {};
          for (const h of present) raws[h] = await readRawMcpServer(harnessPaths, h, name);
          const base = raws[present.find(h => raws[h])];
          if (!base) throw new HttpError(404, `读取 MCP「${name}」配置失败`);
          const spec = mcpSpecFromRaw(name, base);
          const overrides = {};
          for (const h of present) {
            if (!raws[h]) continue;
            let rendered = null;
            try { rendered = renderMcpConfigForHarness(h, spec).config; } catch { rendered = null; }
            const extra = rendered
              ? Object.fromEntries(Object.entries(raws[h]).filter(([key, value]) => JSON.stringify(rendered[key]) !== JSON.stringify(value)))
              : mcpOverrideFromRaw(raws[h]);
            if (Object.keys(extra).length) overrides[h] = extra;
          }
          const pkg = normalizePackage({
            id: uniquePackageId(manifest.packages, name),
            name,
            kind: 'mcp',
            repo: '',
            targets: present,
            mcp: { ...spec, overrides },
          });
          manifest.packages.push(pkg);
          lock.packages[pkg.id] = {
            harnesses: Object.fromEntries(present.map(h => [h, {
              status: 'installed', method: 'adapter', managedServerKey: name, installedAt: now, lastError: '',
            }])),
          };
          await this.store.writeManifest(manifest);
          await this.store.writeLock(lock);
          return { message: `已纳管 MCP「${name}」，未改动本机配置`, state: await this.state() };
        }

        if (area === 'skill') {
          const entry = local.unmanaged.skills.find(item => item.name === name);
          if (!entry) throw new HttpError(404, `本机没有未纳管的 Skill「${name}」`);
          const present = HARNESS_IDS.filter(h => entry.harnesses[h]);
          let index = manifest.packages.findIndex(p => p.id === LOCAL_SKILLS_ID);
          const existing = index >= 0 ? manifest.packages[index] : null;
          if (existing?.skills.sources[name]) throw new HttpError(409, `「本机 Skills」中已有同名 Skill「${name}」`);
          const source = await realpath(entry.harnesses[present[0]].path);
          const perHarness = { ...(existing?.skills.perHarness ?? {}) };
          for (const h of present) perHarness[h] = [...new Set([...(perHarness[h] ?? []), name])];
          const pkg = normalizePackage({
            ...(existing ?? { id: LOCAL_SKILLS_ID, name: '本机 Skills', kind: 'skills-repo', repo: '', targets: [] }),
            targets: [...new Set([...(existing?.targets ?? []), ...present])],
            skills: {
              include: [],
              mode: 'symlink',
              perHarness,
              sources: { ...(existing?.skills.sources ?? {}), [name]: source },
            },
          }, existing ?? undefined);
          if (index >= 0) manifest.packages[index] = pkg;
          else manifest.packages.push(pkg);
          const prevLock = lock.packages[pkg.id] ?? { harnesses: {} };
          const harnesses = { ...(prevLock.harnesses ?? {}) };
          for (const h of present) {
            const prev = harnesses[h] ?? {};
            harnesses[h] = {
              ...prev,
              status: 'installed',
              method: 'adapter',
              managedPaths: [...new Set([...(prev.managedPaths ?? []), entry.harnesses[h].path])],
              installedAt: prev.installedAt || now,
              lastError: '',
            };
          }
          lock.packages[pkg.id] = { ...prevLock, harnesses };
          await this.store.writeManifest(manifest);
          await this.store.writeLock(lock);
          return { message: `已纳管 Skill「${name}」，未改动本机文件`, state: await this.state() };
        }

        if (area === 'plugin') {
          const entry = local.unmanaged.plugins.find(item => item.key === name)
            ?? local.unmanaged.plugins.find(item => item.name === name);
          if (!entry) throw new HttpError(404, `本机没有未纳管的插件「${name}」`);
          const present = HARNESS_IDS.filter(h => entry.harnesses[h]);
          const repo = present.map(h => entry.harnesses[h].repo).find(Boolean) || '';
          const pkg = normalizePackage({
            id: uniquePackageId(manifest.packages, entry.name),
            name: entry.name,
            kind: 'plugin',
            repo,
            targets: present,
            plugin: { name: entry.name, marketplace: entry.marketplace || entry.name, harnesses: [] },
          });
          manifest.packages.push(pkg);
          lock.packages[pkg.id] = {
            harnesses: Object.fromEntries(present.map(h => [h, {
              status: 'installed', method: 'adapter', installedVersion: entry.harnesses[h].version || '', installedAt: now, lastError: '',
            }])),
          };
          await this.store.writeManifest(manifest);
          await this.store.writeLock(lock);
          return { message: `已纳管插件「${entry.name}」，未改动本机配置`, state: await this.state() };
        }

        throw new HttpError(400, `不支持纳管的类型：${area}`);
      }

      case 'local.scan': {
        const [manifest, lock] = await Promise.all([
          this.store.readManifest(),
          this.store.readLock(),
        ]);
        const report = await scanLocalEnvironment({
          harnessPaths: await currentPaths(),
          manifest,
          lock,
        });
        return {
          message: `本机扫描完成：${report.warnings.length} 条提示`,
          report,
        };
      }

      default:
        throw new HttpError(400, `不支持的操作类型：${input.type}`);
    }
  }
}
