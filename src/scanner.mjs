import { lstat, readdir, readFile, readlink, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { HARNESS_IDS } from './constants.mjs';
import { readCodexMcpServers, readJsonMcpServers } from './config-editors.mjs';
import { normalizeRepoUrl } from './store.mjs';

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

async function readPluginManifestVersion(dir) {
  if (!dir) return '';
  for (const rel of [['.claude-plugin', 'plugin.json'], ['.codex-plugin', 'plugin.json'], ['plugin.json']]) {
    const manifest = await readJsonQuiet(join(dir, ...rel));
    if (typeof manifest?.version === 'string' && manifest.version.trim()) return manifest.version.trim();
  }
  return '';
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
    const plugins = await Promise.all(Object.entries(installed?.plugins ?? {}).map(async ([key, entries]) => {
      const [name, marketplace = ''] = key.split('@');
      const entry = Array.isArray(entries) ? (entries.find(e => e?.scope === 'user') ?? entries[0]) : entries;
      let version = typeof entry?.version === 'string' && entry.version !== 'unknown' ? entry.version.trim() : '';
      if (!version && entry?.installPath) version = await readPluginManifestVersion(entry.installPath);
      if (!version && typeof entry?.gitCommitSha === 'string') version = entry.gitCommitSha.trim();
      return { name, marketplace, version, repo: marketplaces[marketplace] || '' };
    }));
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
        const cacheRoot = join(dirname(harnessPaths.codex.mcpFile), 'plugins', 'cache', marketplace, name);
        const versions = (await readdir(cacheRoot)).filter(v => !v.startsWith('.')).sort();
        const latestDir = versions.pop() || '';
        if (latestDir) {
          version = await readPluginManifestVersion(join(cacheRoot, latestDir)) || (latestDir === 'local' ? '' : latestDir);
        }
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
      const version = await readPluginManifestVersion(dir);
      const gitUrl = /^\s*url\s*=\s*(\S+)/m.exec(await readTextQuiet(join(dir, '.git', 'config')))?.[1] || '';
      plugins.push({ name: entry.name, marketplace: '', version, repo: gitUrl ? normalizeRepoUrl(gitUrl) : '' });
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

  const agentsSkillLock = await readAgentsSkillLock(harnessPaths.agentsSkillLockFile);
  const warnings = [];
  const harnesses = {};

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

  return {
    scannedAt: new Date().toISOString(),
    harnesses,
    warnings,
  };
}
