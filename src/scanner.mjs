import { lstat, readdir, readFile, readlink, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { HARNESS_IDS } from './constants.mjs';
import { readCodexMcpServers, readJsonMcpServers } from './config-editors.mjs';
import { normalizeRepoUrl, slugifyId } from './store.mjs';

async function scanSkillsDirectory(dirPath) {
  let entries;
  try { entries = await readdir(dirPath, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const items = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = join(dirPath, entry.name);
    let broken = false;
    let isSymlink = entry.isSymbolicLink();
    let linkTarget = null;
    if (isSymlink) {
      try {
        linkTarget = await readlink(fullPath);
        await stat(fullPath);
      } catch {
        broken = true;
      }
    } else if (!entry.isDirectory()) {
      continue;
    }
    items.push({
      name: entry.name,
      path: fullPath,
      isSymlink,
      linkTarget,
      resolvedTarget: linkTarget ? resolve(dirname(fullPath), linkTarget) : fullPath,
      broken,
    });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

async function readAgentsSkillLock(lockPath) {
  try {
    const raw = await readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.skills && typeof parsed.skills === 'object' ? parsed.skills : {};
  } catch {
    return {};
  }
}

async function readJsonQuiet(filePath) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); } catch { return null; }
}

async function readTextQuiet(filePath) {
  try { return await readFile(filePath, 'utf8'); } catch { return ''; }
}

function repoFromMarketplaceSource(source) {
  if (!source) return '';
  if (typeof source === 'string') return normalizeRepoUrl(source);
  return normalizeRepoUrl(source.repo || source.url || '');
}

// 只读文件识别各 Harness 已装插件，不调用任何 CLI。
// 返回 { [harnessId]: { marketplaces: { name: repo }, plugins: [{ name, marketplace, version, repo }] } }
export async function readInstalledPlugins(harnessPaths) {
  const result = {};

  const claudeDir = harnessPaths['claude-code']?.pluginsDir;
  if (claudeDir) {
    const installed = await readJsonQuiet(join(claudeDir, 'installed_plugins.json'));
    const known = await readJsonQuiet(join(claudeDir, 'known_marketplaces.json')) ?? {};
    const marketplaces = {};
    for (const [name, meta] of Object.entries(known)) marketplaces[name] = repoFromMarketplaceSource(meta?.source);
    const plugins = Object.entries(installed?.plugins ?? {}).map(([key, entries]) => {
      const [name, marketplace = ''] = key.split('@');
      const entry = Array.isArray(entries) ? (entries.find(e => e?.scope === 'user') ?? entries[0]) : entries;
      return { name, marketplace, version: entry?.version || '', repo: marketplaces[marketplace] || '' };
    });
    result['claude-code'] = { marketplaces, plugins };
  }

  const codexToml = harnessPaths.codex?.mcpFile ? await readTextQuiet(harnessPaths.codex.mcpFile) : '';
  if (harnessPaths.codex) {
    const marketplaces = {};
    for (const m of codexToml.matchAll(/^\[marketplaces\.(?:"([^"]+)"|([A-Za-z0-9._-]+))\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/gm)) {
      const source = /^\s*source\s*=\s*"([^"]*)"/m.exec(m[3])?.[1] || '';
      marketplaces[m[1] || m[2]] = /^(https?:|git@)/.test(source) ? normalizeRepoUrl(source) : '';
    }
    const plugins = [];
    for (const m of codexToml.matchAll(/^\[plugins\."([^"@]+)@([^"]+)"\]/gm)) {
      const [, name, marketplace] = m;
      let version = '';
      try {
        const versions = await readdir(join(dirname(harnessPaths.codex.mcpFile), 'plugins', 'cache', marketplace, name));
        version = versions.filter(v => !v.startsWith('.')).sort().pop() || '';
      } catch { version = ''; }
      plugins.push({ name, marketplace, version, repo: marketplaces[marketplace] || '' });
    }
    result.codex = { marketplaces, plugins };
  }

  const agyDir = harnessPaths.antigravity?.pluginsDir;
  if (agyDir) {
    const plugins = [];
    let entries = [];
    try { entries = await readdir(agyDir, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = join(agyDir, entry.name);
      const manifest = await readJsonQuiet(join(dir, '.claude-plugin', 'plugin.json')) ?? await readJsonQuiet(join(dir, 'plugin.json')) ?? {};
      const gitUrl = /^\s*url\s*=\s*(\S+)/m.exec(await readTextQuiet(join(dir, '.git', 'config')))?.[1] || '';
      plugins.push({ name: entry.name, marketplace: '', version: manifest.version || '', repo: gitUrl ? normalizeRepoUrl(gitUrl) : '' });
    }
    result.antigravity = { marketplaces: {}, plugins };
  }

  return result;
}

export async function scanLocalEnvironment({ harnessPaths, manifest, lock }) {
  const managedSkillPaths = new Map();
  const managedMcpKeys = new Map();
  for (const pkg of manifest.packages) {
    const lockEntry = lock.packages[pkg.id];
    for (const harnessId of HARNESS_IDS) {
      const hLock = lockEntry?.harnesses?.[harnessId];
      for (const p of hLock?.managedPaths ?? []) {
        managedSkillPaths.set(p, pkg.id);
      }
      if (hLock?.managedServerKey) {
        managedMcpKeys.set(`${harnessId}:${hLock.managedServerKey}`, pkg.id);
      }
      if (pkg.kind === 'mcp' && pkg.targets.includes(harnessId)) {
        const key = `${harnessId}:${pkg.mcp?.serverName || pkg.id}`;
        if (!managedMcpKeys.has(key)) managedMcpKeys.set(key, pkg.id);
      }
    }
  }

  const managedPlugins = new Map();
  for (const pkg of manifest.packages) {
    if (pkg.kind !== 'plugin') continue;
    for (const harnessId of pkg.targets) {
      const marketplace = harnessId === 'antigravity' ? '' : pkg.plugin.marketplace;
      managedPlugins.set(`${harnessId}:${pkg.plugin.name}@${marketplace}`, pkg.id);
    }
  }
  const installedPlugins = await readInstalledPlugins(harnessPaths);
  const unmanagedPluginGroups = new Map();

  const agentsSkillLock = await readAgentsSkillLock(harnessPaths.agentsSkillLockFile);
  const warnings = [];
  const harnesses = {};
  const unmanagedMcpGroups = new Map();
  const unmanagedSkillRepos = new Map();

  for (const harnessId of HARNESS_IDS) {
    const paths = harnessPaths[harnessId];
    const skills = await scanSkillsDirectory(paths.skillsDir);
    const enrichedSkills = skills.map(item => {
      const managedBy = managedSkillPaths.get(item.path) || null;
      const lockMeta = agentsSkillLock[item.name];
      const sourceRepo = lockMeta?.source ? normalizeRepoUrl(lockMeta.source) : '';
      if (item.broken) {
        warnings.push({ harness: harnessId, kind: 'broken-symlink', message: `失效软链接：${item.path} -> ${item.linkTarget}` });
      }
      if (!managedBy && sourceRepo) {
        const key = sourceRepo;
        const group = unmanagedSkillRepos.get(key) ?? {
          repo: sourceRepo,
          skills: new Set(),
          harnesses: new Set(),
        };
        group.skills.add(item.name);
        group.harnesses.add(harnessId);
        unmanagedSkillRepos.set(key, group);
      }
      return { ...item, managedBy, sourceRepo };
    });

    let mcpServers = {};
    let mcpError = '';
    if (paths.mcpFile) {
      try {
        mcpServers = paths.mcpFormat === 'toml'
          ? await readCodexMcpServers(paths.mcpFile)
          : await readJsonMcpServers(paths.mcpFile);
      } catch (error) {
        mcpError = error.message;
        warnings.push({ harness: harnessId, kind: 'config-error', message: error.message });
      }
    }

    const mcpList = Object.entries(mcpServers).map(([serverName, cfg]) => {
      const managedBy = managedMcpKeys.get(`${harnessId}:${serverName}`) || null;
      if (!managedBy) {
        const group = unmanagedMcpGroups.get(serverName) ?? {
          serverName,
          harnesses: new Set(),
          sampleConfig: cfg,
        };
        group.harnesses.add(harnessId);
        unmanagedMcpGroups.set(serverName, group);
      }
      return {
        serverName,
        transport: cfg?.url ? 'http' : 'stdio',
        command: cfg?.command || '',
        args: Array.isArray(cfg?.args) ? cfg.args : [],
        url: cfg?.url || '',
        managedBy,
      };
    }).sort((a, b) => a.serverName.localeCompare(b.serverName));

    // 检测漂移：lockfile 认为已装，但磁盘上缺失
    for (const pkg of manifest.packages) {
      const hLock = lock.packages[pkg.id]?.harnesses?.[harnessId];
      if (hLock?.status !== 'installed') continue;
      for (const p of hLock.managedPaths ?? []) {
        try { await lstat(p); }
        catch { warnings.push({ harness: harnessId, kind: 'drift', message: `包 ${pkg.id} 的受管 Skill 缺失：${p}` }); }
      }
      if (hLock.managedServerKey && paths.mcpFile && !(hLock.managedServerKey in mcpServers)) {
        warnings.push({ harness: harnessId, kind: 'drift', message: `包 ${pkg.id} 的受管 MCP（${hLock.managedServerKey}）在 ${paths.mcpFile} 中已丢失` });
      }
    }

    const pluginList = (installedPlugins[harnessId]?.plugins ?? []).map(plugin => {
      const managedBy = managedPlugins.get(`${harnessId}:${plugin.name}@${plugin.marketplace}`) || null;
      if (!managedBy && plugin.repo) {
        const key = `${plugin.repo}#${plugin.name}`;
        const group = unmanagedPluginGroups.get(key) ?? { ...plugin, harnesses: new Set() };
        if (!group.marketplace) group.marketplace = plugin.marketplace;
        group.harnesses.add(harnessId);
        unmanagedPluginGroups.set(key, group);
      }
      return { ...plugin, managedBy };
    }).sort((a, b) => a.name.localeCompare(b.name));

    harnesses[harnessId] = {
      pluginsCount: pluginList.length,
      plugins: pluginList,
      skillsDir: paths.skillsDir,
      mcpFile: paths.mcpFile,
      skillsCount: enrichedSkills.length,
      mcpCount: mcpList.length,
      skills: enrichedSkills,
      mcpServers: mcpList,
      mcpError,
    };
  }

  // 检测 Antigravity 旧路径分叉提示
  if (harnessPaths.antigravity.legacySkillsDir) {
    const legacySkills = await scanSkillsDirectory(harnessPaths.antigravity.legacySkillsDir);
    if (legacySkills.length > 0) {
      warnings.push({
        harness: 'antigravity',
        kind: 'legacy-dir',
        message: `检测到旧版目录 ${harnessPaths.antigravity.legacySkillsDir} 仍有 ${legacySkills.length} 个 Skills（新版 Antigravity 实际读取 ${harnessPaths.antigravity.skillsDir}）`,
      });
    }
  }
  if (harnessPaths.antigravity.legacyMcpFile) {
    try {
      const legacyMcp = await readJsonMcpServers(harnessPaths.antigravity.legacyMcpFile);
      const legacyKeys = Object.keys(legacyMcp);
      if (legacyKeys.length > 0) {
        warnings.push({
          harness: 'antigravity',
          kind: 'legacy-config',
          message: `检测到旧版配置 ${harnessPaths.antigravity.legacyMcpFile} 残留 MCP：${legacyKeys.join(', ')}（新版读取 ${harnessPaths.antigravity.mcpFile}）`,
        });
      }
    } catch { /* ignore legacy parse errors */ }
  }

  // 生成可一键导入的未纳管建议
  const importCandidates = [];
  for (const group of unmanagedSkillRepos.values()) {
    const repoName = group.repo.split('/').pop() || 'skills';
    importCandidates.push({
      candidateId: `skills:${group.repo}`,
      kind: 'skills-repo',
      label: `${repoName}（${group.skills.size} 个 Skills）`,
      harnesses: [...group.harnesses],
      draft: {
        id: slugifyId(repoName),
        name: repoName,
        kind: 'skills-repo',
        repo: group.repo,
        description: `从本机扫描导入，包含 ${group.skills.size} 个 Skills`,
        ref: '',
        version: '',
        targets: [...group.harnesses],
        skills: { include: [...group.skills].sort(), mode: 'symlink' },
      },
    });
  }

  for (const group of unmanagedPluginGroups.values()) {
    const id = slugifyId(group.name);
    importCandidates.push({
      candidateId: `plugin:${group.repo}#${group.name}`,
      kind: 'plugin',
      label: `${group.name}（插件${group.version ? ` ${group.version}` : ''}）`,
      harnesses: [...group.harnesses],
      draft: {
        id,
        name: group.name,
        kind: 'plugin',
        repo: group.repo,
        description: '从本机已安装插件导入，安装与卸载交由各 Harness 插件命令处理（含 Hooks）',
        ref: '',
        version: group.version,
        targets: [...group.harnesses],
        plugin: { name: group.name, marketplace: group.marketplace || id },
      },
    });
  }

  for (const group of unmanagedMcpGroups.values()) {
    const cfg = group.sampleConfig || {};
    const transport = cfg.url ? 'http' : 'stdio';
    const envRefs = Array.isArray(cfg.env_vars)
      ? cfg.env_vars
      : (cfg.env && typeof cfg.env === 'object' ? Object.keys(cfg.env) : []);
    importCandidates.push({
      candidateId: `mcp:${group.serverName}`,
      kind: 'mcp',
      label: `${group.serverName}（${transport.toUpperCase()} MCP）`,
      harnesses: [...group.harnesses],
      draft: {
        id: slugifyId(group.serverName),
        name: group.serverName,
        kind: 'mcp',
        repo: '',
        description: '从本机现有 MCP 配置导入，可补充 GitHub 地址以启用版本检查',
        ref: '',
        version: '',
        targets: [...group.harnesses],
        mcp: {
          serverName: group.serverName,
          transport,
          command: cfg.command || '',
          args: Array.isArray(cfg.args) ? cfg.args : [],
          url: cfg.url || '',
          envRefs,
          headers: {},
          overrides: {},
        },
      },
    });
  }

  return {
    scannedAt: new Date().toISOString(),
    harnesses,
    warnings,
    importCandidates,
  };
}
