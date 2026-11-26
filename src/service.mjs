import { join } from 'node:path';
import { HARNESS_IDS, HARNESS_META, resolveHarnessPaths } from './constants.mjs';
import { normalizeVersion, unsupportedReason } from './shared.mjs';
import { PackageStore, normalizePackage } from './store.mjs';
import { checkPackageUpdate, inspectGitHubRepo } from './github-inspector.mjs';
import { applyPackageAction, defaultExecFile, defaultRunShell } from './installer.mjs';
import { readInstalledPlugins, scanLocalEnvironment } from './scanner.mjs';
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

export class PackageManagerService {
  constructor(options = {}) {
    if (!options.root) throw new Error('必须提供配置保存目录 root');
    this.root = options.root;
    this.store = new PackageStore(this.root);
    this.harnessPaths = resolveHarnessPaths({
      homeDir: options.homeDir,
      dshHome: options.dshHome,
      codexHome: options.codexHome,
      claudeConfigDir: options.claudeConfigDir,
    });
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.execImpl = options.execImpl ?? defaultExecFile;
    this.runShell = options.runShell ?? defaultRunShell;
    this.githubToken = options.githubToken;
    // Claude Code 启动命令（如 reclaude），可为取值函数以读到最新设置；空值回落到 claude
    this.claudeCommand = options.claudeCommand ?? '';
    this.explicitClaudeConfigDir = options.claudeConfigDir || process.env.CLAUDE_CONFIG_DIR || '';
  }

  // 每次操作读取最新的 Claude Code 命令；reclaude 时按其当前账号的配置目录识别插件，显式 CLAUDE_CONFIG_DIR 优先。
  async currentHarnessPaths() {
    const configured = typeof this.claudeCommand === 'function' ? this.claudeCommand() : this.claudeCommand;
    const command = (typeof configured === 'string' && configured.trim()) || 'claude';
    const claude = { ...this.harnessPaths['claude-code'], command };
    if (!this.explicitClaudeConfigDir && await isReclaudeCommand(command)) {
      const configDir = await reclaudeConfigDir(command, this.execImpl);
      if (configDir) claude.pluginsDir = join(configDir, 'plugins');
    }
    return { ...this.harnessPaths, 'claude-code': claude };
  }

  async init() {
    await this.store.init();
    await this.store.readManifest();
    await this.store.readLock();
  }

  async state() {
    const [manifest, lock] = await Promise.all([
      this.store.readManifest(),
      this.store.readLock(),
    ]);
    const hasPlugins = manifest.packages.some(p => p.kind === 'plugin');
    const livePlugins = hasPlugins ? await readInstalledPlugins(await this.currentHarnessPaths()) : {};
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
          method: hLock?.method || (pkg.commands?.[harnessId]?.install ? 'command' : 'adapter'),
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

    return {
      rootDir: this.root,
      manifestFile: this.store.manifestFile,
      lockFile: this.store.lockFile,
      harnesses: HARNESS_IDS.map(id => ({
        ...HARNESS_META[id],
        skillsDir: this.harnessPaths[id].skillsDir,
        mcpFile: this.harnessPaths[id].mcpFile,
      })),
      summary: {
        total: packages.length,
        outdated: outdatedCount,
        failed: failedCount,
        pendingInstall: pendingInstallCount,
      },
      packages,
    };
  }

  async action(input) {
    if (!input || typeof input.type !== 'string') {
      throw new HttpError(400, '缺少操作类型 type');
    }

    let paths;
    const currentPaths = async () => (paths ??= await this.currentHarnessPaths());

    switch (input.type) {
      case 'repo.inspect': {
        const inspected = await inspectGitHubRepo(input.repo, {
          fetchImpl: this.fetchImpl,
          execCommand: this.execImpl,
          token: this.githubToken,
        });
        return { message: '已解析 GitHub 仓库信息', ...inspected };
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
          const next = !existing ? rawPkg
            : originalId ? { ...rawPkg, id: existing.id }
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
        await this.store.writeManifest({ version: 1, packages: nextPackages });

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
          for (const harnessId of HARNESS_IDS) {
            const hLock = prev.harnesses?.[harnessId];
            if (hLock?.status !== 'installed') continue;
            const ver = findLivePlugin(livePlugins, pkg, harnessId)?.version || hLock.installedVersion || '';
            if (ver) observedVersions.push(ver);
          }
          const checkLock = prev.resolvedVersion || !observedVersions.length
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
            ...(checkLock.resolvedVersion && !prev.resolvedVersion ? { resolvedVersion: checkLock.resolvedVersion } : {}),
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
