import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, lstat, mkdir, readdir, readlink, rm, symlink } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { HARNESS_IDS, HARNESS_META } from './constants.mjs';
import {
  interpolateTemplate,
  removeCodexMcpServer,
  removeJsonMcpServer,
  renderMcpConfigForHarness,
  upsertCodexMcpServer,
  upsertJsonMcpServer,
} from './config-editors.mjs';
import { readInstalledPlugins } from './scanner.mjs';
import { parseGitHubSlug } from './store.mjs';

const execFileAsync = promisify(execFile);

export function buildUserEnv(extra = {}) {
  const basePath = process.env.PATH || '';
  const extraDirs = ['/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME || ''}/.local/bin`];
  const merged = [...new Set([...basePath.split(':').filter(Boolean), ...extraDirs])].join(':');
  return { ...process.env, PATH: merged, ...extra };
}

export async function defaultExecFile(file, args, options = {}) {
  return execFileAsync(file, args, {
    timeout: options.timeout ?? 120_000,
    maxBuffer: 4 * 1024 * 1024,
    cwd: options.cwd,
    env: options.env ?? buildUserEnv(),
  });
}

export async function defaultRunShell(command, options = {}) {
  const shell = process.env.SHELL || '/bin/sh';
  return execFileAsync(shell, ['-lc', command], {
    timeout: options.timeout ?? 120_000,
    maxBuffer: 4 * 1024 * 1024,
    cwd: options.cwd,
    env: options.env ?? buildUserEnv(),
  });
}

export async function discoverSkillsInDir(repoDir) {
  const found = [];
  async function walk(dir, depth) {
    if (depth > 5) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    const hasSkillMd = entries.some(entry => entry.isFile() && entry.name === 'SKILL.md');
    if (hasSkillMd) {
      const rel = relative(repoDir, dir);
      const name = rel ? rel.split('/').pop() : dir.split('/').pop();
      found.push({ name, dir, rel: rel || '.' });
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (['.git', 'node_modules', 'dist', 'lib', '.cache', '.github'].includes(entry.name)) continue;
      await walk(join(dir, entry.name), depth + 1);
    }
  }
  await walk(repoDir, 0);
  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}

export async function syncGitRepo(repoUrl, targetDir, ref, { execImpl = defaultExecFile, dryRun = false } = {}) {
  if (!repoUrl) throw new Error('缺少 GitHub 仓库地址');
  let exists = false;
  try {
    await lstat(join(targetDir, '.git'));
    exists = true;
  } catch { exists = false; }

  if (dryRun) {
    return {
      dir: targetDir,
      commit: null,
      ref: ref || 'HEAD',
      action: exists ? `git fetch & checkout ${ref || 'HEAD'}` : `git clone ${repoUrl} (${ref || '默认分支'})`,
    };
  }

  await mkdir(dirname(targetDir), { recursive: true });
  if (!exists) {
    await execImpl('git', ['clone', '--quiet', repoUrl, targetDir]);
  } else {
    await execImpl('git', ['-C', targetDir, 'fetch', '--all', '--tags', '--prune', '--quiet']);
  }

  if (ref) {
    try {
      await execImpl('git', ['-C', targetDir, 'checkout', '--quiet', ref]);
    } catch {
      await execImpl('git', ['-C', targetDir, 'checkout', '--quiet', `origin/${ref}`]);
    }
    // 如果 checkout 的是本地分支名，尽量快进到远端同名分支
    await execImpl('git', ['-C', targetDir, 'pull', '--ff-only', '--quiet']).catch(() => {});
  } else {
    await execImpl('git', ['-C', targetDir, 'pull', '--ff-only', '--quiet']).catch(() => {});
  }

  const { stdout } = await execImpl('git', ['-C', targetDir, 'rev-parse', 'HEAD']);
  return { dir: targetDir, commit: stdout.trim(), ref: ref || 'HEAD', action: exists ? 'updated' : 'cloned' };
}

function summarizeOutput(stdout, stderr) {
  const combined = [stdout?.trim(), stderr?.trim()].filter(Boolean).join('\n');
  if (combined.length <= 2000) return combined;
  return combined.slice(0, 2000) + '\n…（输出已截断）';
}

function templateVars(pkg, harnessId, repoDir) {
  return {
    id: pkg.id,
    name: pkg.name,
    repo: pkg.repo,
    ref: pkg.ref || '',
    version: pkg.version || pkg.ref.replace(/^v/, '') || '',
    npmPackage: pkg.npmPackage || '',
    harness: harnessId,
    dir: repoDir || '',
  };
}

async function safeRemoveManagedSkillPath(targetPath, allowedSourceRoot, dryRun) {
  let stats;
  try { stats = await lstat(targetPath); } catch { return { removed: false, reason: 'not-found' }; }
  if (stats.isSymbolicLink()) {
    const linkTarget = await readlink(targetPath);
    const resolvedTarget = resolve(dirname(targetPath), linkTarget);
    if (allowedSourceRoot && !resolvedTarget.startsWith(resolve(allowedSourceRoot))) {
      return { removed: false, reason: 'external-symlink' };
    }
    if (!dryRun) await rm(targetPath, { force: true });
    return { removed: true, reason: 'symlink' };
  }
  if (!dryRun) await rm(targetPath, { recursive: true, force: true });
  return { removed: true, reason: 'managed-copy' };
}

async function installSkillsToHarness(pkg, harnessId, harnessPaths, repoDir, prevHarnessLock, options) {
  const skillsDir = harnessPaths[harnessId]?.skillsDir;
  if (!skillsDir) throw new Error(`未知 Harness：${harnessId}`);
  const mode = pkg.skills?.mode === 'copy' ? 'copy' : 'symlink';
  const prevManaged = Array.isArray(prevHarnessLock?.managedPaths) ? prevHarnessLock.managedPaths : [];

  if (options.dryRun) {
    let discovered = [];
    try { discovered = await discoverSkillsInDir(repoDir); } catch { discovered = []; }
    const selected = pkg.skills?.include?.length
      ? discovered.filter(s => pkg.skills.include.includes(s.name))
      : discovered;
    return {
      harness: harnessId,
      action: options.action,
      method: 'adapter',
      status: 'preview',
      detail: selected.length
        ? `将以 ${mode} 方式同步 ${selected.length} 个 Skill 到 ${skillsDir}：${selected.map(s => s.name).join(', ')}`
        : `拉取仓库后将以 ${mode} 方式同步发现的 SKILL.md 到 ${skillsDir}`,
      managedPaths: selected.map(s => join(skillsDir, s.name)),
      warnings: [],
    };
  }

  const discovered = await discoverSkillsInDir(repoDir);
  if (!discovered.length) {
    throw new Error(`仓库中未发现任何 SKILL.md（${repoDir}）`);
  }
  const selected = pkg.skills?.include?.length
    ? discovered.filter(s => pkg.skills.include.includes(s.name))
    : discovered;
  if (!selected.length) {
    throw new Error(`仓库中未匹配到指定 Skills：${pkg.skills.include.join(', ')}`);
  }

  await mkdir(skillsDir, { recursive: true });
  const managedPaths = [];
  const warnings = [];
  const written = [];

  for (const skill of selected) {
    const dest = join(skillsDir, skill.name);
    let existing = null;
    try { existing = await lstat(dest); } catch { existing = null; }
    if (existing) {
      const wasManaged = prevManaged.includes(dest);
      if (existing.isSymbolicLink() || wasManaged) {
        await rm(dest, { recursive: true, force: true });
      } else {
        warnings.push(`跳过已存在的非受管目录：${dest}`);
        continue;
      }
    }
    if (mode === 'copy') {
      await cp(skill.dir, dest, { recursive: true });
    } else {
      await symlink(skill.dir, dest, 'dir');
    }
    managedPaths.push(dest);
    written.push(skill.name);
  }

  // 清理上次受管但本次已移除的 skill
  for (const oldPath of prevManaged) {
    if (!managedPaths.includes(oldPath)) {
      await safeRemoveManagedSkillPath(oldPath, repoDir, false);
    }
  }

  return {
    harness: harnessId,
    action: options.action,
    method: 'adapter',
    status: 'ok',
    detail: `已通过 ${mode} 同步 ${written.length} 个 Skill 到 ${skillsDir}`,
    managedPaths,
    warnings,
  };
}

async function installMcpToHarness(pkg, harnessId, harnessPaths, vars, prevHarnessLock, options) {
  const target = harnessPaths[harnessId];
  if (!target?.mcpFile) {
    return {
      harness: harnessId,
      action: options.action,
      method: 'adapter',
      status: 'skipped',
      detail: `${HARNESS_META[harnessId]?.label ?? harnessId} 无原生本地 MCP 配置文件；如需接入请为其配置自定义安装命令`,
      warnings: [],
    };
  }
  const serverKey = pkg.mcp?.serverName || pkg.id;
  const { config, warnings } = renderMcpConfigForHarness(harnessId, pkg.mcp, vars);

  // 如果之前用过不同的 serverKey，先清理旧键
  const prevKey = prevHarnessLock?.managedServerKey;
  if (prevKey && prevKey !== serverKey && !options.dryRun) {
    if (target.mcpFormat === 'toml') await removeCodexMcpServer(target.mcpFile, prevKey);
    else await removeJsonMcpServer(target.mcpFile, prevKey);
  }

  const result = target.mcpFormat === 'toml'
    ? await upsertCodexMcpServer(target.mcpFile, serverKey, config, { dryRun: options.dryRun })
    : await upsertJsonMcpServer(target.mcpFile, serverKey, config, { dryRun: options.dryRun });

  return {
    harness: harnessId,
    action: options.action,
    method: 'adapter',
    status: options.dryRun ? 'preview' : 'ok',
    detail: `${result.action === 'add' ? '新增' : result.action === 'update' ? '更新' : '无变更'} ${target.mcpFile} → ${serverKey}`,
    managedServerKey: serverKey,
    warnings,
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// 简单命令名原样输出，含空格等字符的路径加引号
const shellWord = value => (/^[A-Za-z0-9._\/~-]+$/.test(value) ? value : shellQuote(value));

// 插件交给各 Harness 自己的插件 CLI 安装：hooks、命令、Skills 由 Harness 注册与清理，本插件不直接改写 hooks 配置。
// claudeCommand 是用户启动 Claude Code 的命令（如 reclaude），插件命令经它执行才能装进对应的配置目录。
// 返回 { command, warnings }；该 Harness 无插件机制时返回 null。
export function buildPluginCommand(pkg, harnessId, action, installed = {}, claudeCommand = 'claude') {
  const { name, marketplace } = pkg.plugin;
  const id = `${name}@${marketplace}`;
  const gh = parseGitHubSlug(pkg.repo);
  const source = gh ? gh.slug : pkg.repo;
  const marketplaceKnown = Object.hasOwn(installed[harnessId]?.marketplaces ?? {}, marketplace);
  // 各端插件命令都从仓库默认分支安装，锁定的 ref 只用于检查更新
  const refWarning = pkg.ref ? [`插件从仓库默认分支安装，锁定的 ${pkg.ref} 仅用于检查更新`] : [];
  if (action !== 'uninstall' && !source) throw new Error('插件类型需要填写 GitHub 仓库地址（插件市场来源）');

  if (harnessId === 'claude-code') {
    const claude = shellWord(claudeCommand || 'claude');
    if (action === 'uninstall') return { command: `${claude} plugin uninstall ${id}`, warnings: [] };
    const refresh = marketplaceKnown
      ? `${claude} plugin marketplace update ${marketplace}`
      : `${claude} plugin marketplace add ${shellQuote(source)}`;
    const verb = action === 'upgrade' && marketplaceKnown ? 'update' : 'install';
    return {
      command: `${refresh} && ${claude} plugin ${verb} ${id}`,
      warnings: ['插件 hooks 由 Claude Code 注册，新开会话后生效', ...refWarning],
    };
  }
  if (harnessId === 'codex') {
    if (action === 'uninstall') return { command: `codex plugin remove ${id}`, warnings: [] };
    const refresh = marketplaceKnown
      ? `codex plugin marketplace upgrade ${marketplace}`
      : `codex plugin marketplace add ${shellQuote(source)}`;
    return {
      command: `${refresh} && codex plugin add ${id}`,
      warnings: ['插件 hooks 需在 Codex 中打开 /hooks 审核并信任后才会运行，新建会话后生效', ...refWarning],
    };
  }
  if (harnessId === 'antigravity') {
    if (action === 'uninstall') return { command: `agy plugin uninstall ${name}`, warnings: [] };
    const target = shellQuote(gh ? gh.url : pkg.repo);
    const reinstall = action === 'upgrade' && (installed.antigravity?.plugins ?? []).some(p => p.name === name);
    return {
      command: reinstall ? `agy plugin uninstall ${name} && agy plugin install ${target}` : `agy plugin install ${target}`,
      warnings: refWarning,
    };
  }
  return null;
}

function findInstalledPlugin(installed, pkg, harnessId) {
  return (installed[harnessId]?.plugins ?? []).find(p => p.name === pkg.plugin.name && (harnessId === 'antigravity' || p.marketplace === pkg.plugin.marketplace));
}

// 幂等安装：插件已装在该端时“安装/全部同步”不重复执行任何命令（含自定义命令），更新走升级
async function installedPluginStep(pkg, harnessId, harnessPaths, dryRun) {
  const existing = findInstalledPlugin(await readInstalledPlugins(harnessPaths), pkg, harnessId);
  if (!existing) return null;
  return {
    harness: harnessId,
    action: 'install',
    method: 'adapter',
    status: dryRun ? 'preview' : 'ok',
    detail: `已安装${existing.version ? ` ${existing.version}` : ''}，无需重复安装；如需更新请使用升级`,
    installedVersion: existing.version || undefined,
    warnings: [],
  };
}

async function applyPluginToHarness(pkg, harnessId, action, harnessPaths, options) {
  const installed = await readInstalledPlugins(harnessPaths);
  const built = buildPluginCommand(pkg, harnessId, action, installed, harnessPaths['claude-code']?.command);
  if (!built) {
    return {
      harness: harnessId,
      action,
      method: 'adapter',
      status: 'skipped',
      detail: `${HARNESS_META[harnessId]?.label ?? harnessId} 暂无插件机制，未安装；如只需其中的 Skills，可另建「Skills 仓库」类型的包`,
      warnings: [],
    };
  }
  const step = await runCustomCommand(pkg, harnessId, action, built.command, '', { ...options, repoSynced: false });
  const result = { ...step, method: 'adapter', warnings: built.warnings };
  if (!options.dryRun && action !== 'uninstall') {
    const match = findInstalledPlugin(await readInstalledPlugins(harnessPaths), pkg, harnessId);
    if (match?.version) result.installedVersion = match.version;
    if (action === 'upgrade' && pkg.version && match?.version && match.version !== pkg.version) {
      result.warnings = [...result.warnings, `读回的安装版本 ${match.version} 与目标版本 ${pkg.version} 不一致，可能需等待插件市场更新`];
    }
  }
  return result;
}

async function runCustomCommand(pkg, harnessId, action, commandTemplate, repoDir, options) {
  const vars = templateVars(pkg, harnessId, repoDir);
  const rendered = interpolateTemplate(commandTemplate, vars).trim();
  if (!rendered) {
    return {
      harness: harnessId,
      action,
      method: 'command',
      status: 'skipped',
      detail: `未配置 ${HARNESS_META[harnessId]?.label ?? harnessId} 的 ${action} 命令`,
      warnings: [],
    };
  }
  if (options.dryRun) {
    return {
      harness: harnessId,
      action,
      method: 'command',
      status: 'preview',
      command: rendered,
      detail: `将执行命令：${rendered}`,
      warnings: [],
    };
  }
  const runShell = options.runShell ?? defaultRunShell;
  const { stdout, stderr } = await runShell(rendered, {
    cwd: repoDir && options.repoSynced ? repoDir : options.rootDir,
    env: buildUserEnv({
      AGENT_PKG_ID: pkg.id,
      AGENT_PKG_REPO: pkg.repo || '',
      AGENT_PKG_REF: pkg.ref || '',
      AGENT_PKG_VERSION: vars.version,
      AGENT_PKG_HARNESS: harnessId,
      AGENT_PKG_DIR: repoDir || '',
    }),
  });
  return {
    harness: harnessId,
    action,
    method: 'command',
    status: 'ok',
    command: rendered,
    detail: `命令执行成功`,
    output: summarizeOutput(stdout, stderr),
    warnings: [],
  };
}

export async function applyPackageAction({
  pkg,
  action = 'install',
  harnesses,
  lockEntry = {},
  harnessPaths,
  reposDir,
  rootDir,
  dryRun = false,
  execImpl = defaultExecFile,
  runShell = defaultRunShell,
}) {
  const targetHarnesses = (harnesses?.length ? harnesses : pkg.targets).filter(h => HARNESS_IDS.includes(h));
  const repoDir = join(reposDir, pkg.id);
  const steps = [];
  const nextLock = {
    ...lockEntry,
    harnesses: { ...(lockEntry.harnesses ?? {}) },
  };

  if (action === 'uninstall') {
    const toUninstall = targetHarnesses.length
      ? targetHarnesses
      : Object.keys(nextLock.harnesses).filter(h => nextLock.harnesses[h]?.status === 'installed');

    for (const harnessId of toUninstall) {
      const prev = nextLock.harnesses[harnessId] ?? {};
      const customUninstall = pkg.commands?.[harnessId]?.uninstall;
      try {
        let step;
        if (customUninstall) {
          step = await runCustomCommand(pkg, harnessId, 'uninstall', customUninstall, repoDir, { dryRun, runShell, rootDir, repoSynced: false });
        } else if (pkg.kind === 'plugin') {
          step = await applyPluginToHarness(pkg, harnessId, 'uninstall', harnessPaths, { dryRun, runShell, rootDir });
        } else if (pkg.kind === 'skills-repo') {
          const paths = Array.isArray(prev.managedPaths) ? prev.managedPaths : [];
          let removed = 0;
          for (const p of paths) {
            const res = await safeRemoveManagedSkillPath(p, repoDir, dryRun);
            if (res.removed) removed++;
          }
          step = {
            harness: harnessId,
            action: 'uninstall',
            method: 'adapter',
            status: dryRun ? 'preview' : 'ok',
            detail: paths.length ? `${dryRun ? '将移除' : '已移除'} ${removed} 个受管 Skill` : '无受管 Skill 需要清理',
            warnings: [],
          };
        } else if (pkg.kind === 'mcp') {
          const target = harnessPaths[harnessId];
          const serverKey = prev.managedServerKey || pkg.mcp?.serverName || pkg.id;
          if (!target?.mcpFile) {
            step = { harness: harnessId, action: 'uninstall', method: 'adapter', status: 'skipped', detail: '无原生 MCP 配置文件', warnings: [] };
          } else {
            const res = target.mcpFormat === 'toml'
              ? await removeCodexMcpServer(target.mcpFile, serverKey, { dryRun })
              : await removeJsonMcpServer(target.mcpFile, serverKey, { dryRun });
            step = {
              harness: harnessId,
              action: 'uninstall',
              method: 'adapter',
              status: dryRun ? 'preview' : 'ok',
              detail: res.changed ? `${dryRun ? '将从' : '已从'} ${target.mcpFile} 移除 ${serverKey}` : `${target.mcpFile} 中未找到 ${serverKey}`,
              warnings: [],
            };
          }
        } else {
          step = {
            harness: harnessId,
            action: 'uninstall',
            method: 'command',
            status: 'skipped',
            detail: `未配置 ${HARNESS_META[harnessId]?.label ?? harnessId} 的卸载命令，请手工确认或补充 uninstall 命令`,
            warnings: [],
          };
        }
        steps.push(step);
        if (!dryRun && step.status === 'ok') {
          nextLock.harnesses[harnessId] = {
            ...prev,
            status: 'uninstalled',
            managedPaths: [],
            managedServerKey: null,
            lastError: '',
          };
        }
      } catch (error) {
        steps.push({ harness: harnessId, action: 'uninstall', method: customUninstall ? 'command' : 'adapter', status: 'error', detail: error.message, warnings: [] });
        if (!dryRun) {
          nextLock.harnesses[harnessId] = { ...prev, status: 'failed', lastError: error.message };
        }
      }
    }
    return { steps, lockEntry: nextLock };
  }

  // install / upgrade
  let repoSynced = false;
  const needsRepoClone = Boolean(pkg.repo) && (
    pkg.kind === 'skills-repo' ||
    targetHarnesses.some(h => {
      const cmd = action === 'upgrade'
        ? (pkg.commands?.[h]?.upgrade || pkg.commands?.[h]?.install || '')
        : (pkg.commands?.[h]?.install || '');
      return cmd.includes('{{dir}}');
    })
  );

  if (needsRepoClone) {
    try {
      const gitResult = await syncGitRepo(pkg.repo, repoDir, pkg.ref, { execImpl, dryRun });
      repoSynced = !dryRun;
      steps.push({
        harness: 'repo',
        action: 'git-sync',
        method: 'git',
        status: dryRun ? 'preview' : 'ok',
        detail: dryRun ? gitResult.action : `已检出 ${pkg.ref || '默认分支'}（${gitResult.commit.slice(0, 7)}）`,
        warnings: [],
      });
      if (!dryRun && gitResult.commit) {
        nextLock.resolvedCommit = gitResult.commit;
        nextLock.resolvedRef = pkg.ref || 'HEAD';
      }
    } catch (error) {
      steps.push({ harness: 'repo', action: 'git-sync', method: 'git', status: 'error', detail: `拉取仓库失败：${error.message}`, warnings: [] });
      return { steps, lockEntry: nextLock };
    }
  }

  for (const harnessId of targetHarnesses) {
    const prev = nextLock.harnesses[harnessId] ?? {};
    const customCmd = action === 'upgrade'
      ? (pkg.commands?.[harnessId]?.upgrade || pkg.commands?.[harnessId]?.install)
      : pkg.commands?.[harnessId]?.install;
    const vars = templateVars(pkg, harnessId, repoDir);

    try {
      let step = pkg.kind === 'plugin' && action === 'install'
        ? await installedPluginStep(pkg, harnessId, harnessPaths, dryRun)
        : null;
      if (step) {
        // 已安装，跳过
      } else if (customCmd) {
        step = await runCustomCommand(pkg, harnessId, action, customCmd, repoDir, { dryRun, runShell, rootDir, repoSynced });
      } else if (pkg.kind === 'plugin') {
        step = await applyPluginToHarness(pkg, harnessId, action, harnessPaths, { dryRun, runShell, rootDir });
      } else if (pkg.kind === 'skills-repo') {
        step = await installSkillsToHarness(pkg, harnessId, harnessPaths, repoDir, prev, { dryRun, action });
      } else if (pkg.kind === 'mcp') {
        step = await installMcpToHarness(pkg, harnessId, harnessPaths, vars, prev, { dryRun, action });
      } else {
        step = {
          harness: harnessId,
          action,
          method: 'command',
          status: 'skipped',
          detail: `未配置 ${HARNESS_META[harnessId]?.label ?? harnessId} 的安装命令`,
          warnings: [],
        };
      }
      steps.push(step);

      if (!dryRun && step.status === 'ok') {
        nextLock.resolvedVersion = pkg.version || pkg.ref.replace(/^v/, '') || nextLock.resolvedVersion || '';
        nextLock.harnesses[harnessId] = {
          status: 'installed',
          method: step.method,
          installedVersion: step.installedVersion || nextLock.resolvedVersion || '',
          installedCommit: nextLock.resolvedCommit || '',
          installedAt: new Date().toISOString(),
          managedPaths: step.managedPaths ?? prev.managedPaths ?? [],
          managedServerKey: step.managedServerKey ?? prev.managedServerKey ?? null,
          lastCommand: step.command ?? '',
          lastError: '',
        };
      }
    } catch (error) {
      steps.push({
        harness: harnessId,
        action,
        method: customCmd ? 'command' : 'adapter',
        status: 'error',
        detail: error.message,
        warnings: [],
      });
      if (!dryRun) {
        nextLock.harnesses[harnessId] = {
          ...prev,
          status: 'failed',
          lastError: error.message,
        };
      }
    }
  }

  return { steps, lockEntry: nextLock };
}
