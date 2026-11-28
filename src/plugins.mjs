import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const PLUGIN_HARNESSES = ['codex', 'claude-code', 'antigravity'];
// Codex 随应用自带的市场，插件归入单独的折叠组
export const BUILTIN_MARKETPLACES = ['openai-bundled', 'openai-primary-runtime'];

async function readJsonQuiet(filePath) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); } catch { return null; }
}

async function readTextQuiet(filePath) {
  try { return await readFile(filePath, 'utf8'); } catch { return ''; }
}

async function manifestVersion(dir) {
  if (!dir) return '';
  for (const rel of [['.claude-plugin', 'plugin.json'], ['.codex-plugin', 'plugin.json'], ['plugin.json']]) {
    const manifest = await readJsonQuiet(join(dir, ...rel));
    if (typeof manifest?.version === 'string' && manifest.version.trim()) return manifest.version.trim();
  }
  return '';
}

function splitId(id) {
  const at = id.lastIndexOf('@');
  return at > 0 ? [id.slice(0, at), id.slice(at + 1)] : [id, ''];
}

// 只读文件识别三端已装的插件，不调用任何 CLI（Codex 的 plugin list 会在线拉取，可能挂起很久）
export async function readPluginState(harnessPaths) {
  const state = {};

  const claudeDir = harnessPaths['claude-code'].pluginsDir;
  const claudeInstalled = await readJsonQuiet(join(claudeDir, 'installed_plugins.json'));
  state['claude-code'] = {
    plugins: await Promise.all(Object.entries(claudeInstalled?.plugins ?? {}).map(async ([id, entries]) => {
      const [name, marketplace] = splitId(id);
      const entry = Array.isArray(entries) ? (entries.find(e => e?.scope === 'user') ?? entries[0]) : entries;
      let version = typeof entry?.version === 'string' && entry.version !== 'unknown' ? entry.version.trim() : '';
      if (!version) version = await manifestVersion(entry?.installPath);
      if (!version && typeof entry?.gitCommitSha === 'string') version = entry.gitCommitSha.slice(0, 7);
      return { name, marketplace, version, installPath: entry?.installPath || '' };
    })),
  };

  const codexHome = dirname(harnessPaths.codex.mcpFile);
  const toml = await readTextQuiet(harnessPaths.codex.mcpFile);
  const codexPlugins = [];
  for (const m of toml.matchAll(/^\[plugins\."([^"]+)"\]/gm)) {
    const [name, marketplace] = splitId(m[1]);
    let installPath = '';
    let version = '';
    try {
      const cacheRoot = join(codexHome, 'plugins', 'cache', marketplace, name);
      const latest = (await readdir(cacheRoot)).filter(v => !v.startsWith('.')).sort().pop() || '';
      if (latest) {
        installPath = join(cacheRoot, latest);
        version = await manifestVersion(installPath) || (latest === 'local' ? '' : latest);
      }
    } catch { /* 没有缓存目录时版本留空 */ }
    codexPlugins.push({ name, marketplace, version, installPath });
  }
  state.codex = { plugins: codexPlugins };

  const agyPlugins = [];
  try {
    for (const entry of await readdir(harnessPaths.antigravity.pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = join(harnessPaths.antigravity.pluginsDir, entry.name);
      agyPlugins.push({ name: entry.name, marketplace: '', version: await manifestVersion(dir), installPath: dir });
    }
  } catch { /* 目录不存在即没有插件 */ }
  state.antigravity = { plugins: agyPlugins };
  return state;
}

// 插件自带的 MCP key：Claude Code 的 .mcp.json、Agent Plugins 规范的 mcp.json、agy 的 mcp_config.json，以及各清单声明的 mcpServers
async function pluginMcpKeys(dir) {
  const keys = [];
  for (const file of ['.mcp.json', 'mcp.json', 'mcp_config.json']) {
    const mcpFile = await readJsonQuiet(join(dir, file));
    if (mcpFile) keys.push(...Object.keys(mcpFile.mcpServers ?? mcpFile).filter(key => key !== '$schema'));
  }
  for (const rel of [['.claude-plugin', 'plugin.json'], ['.codex-plugin', 'plugin.json'], ['plugin.json']]) {
    const manifest = await readJsonQuiet(join(dir, ...rel));
    const declared = manifest?.mcpServers;
    if (declared && typeof declared === 'object') keys.push(...Object.keys(declared));
    if (typeof declared === 'string') {
      const linked = await readJsonQuiet(resolve(dir, declared));
      if (linked) keys.push(...Object.keys(linked.mcpServers ?? linked));
    }
  }
  return keys;
}

// 已装插件自带的 Skills 与 MCP：{ skills: { 名称: [插件名] }, mcp: { key: [插件名] } }
// 插件带来的条目由插件自己管理，矩阵里禁止单独同步
async function pluginProvides(state) {
  const provides = { skills: {}, mcp: {} };
  const add = (map, key, plugin) => {
    map[key] ??= [];
    if (!map[key].includes(plugin)) map[key].push(plugin);
  };
  for (const harnessId of PLUGIN_HARNESSES) {
    for (const plugin of state[harnessId].plugins) {
      if (!plugin.installPath) continue;
      try {
        for (const entry of await readdir(join(plugin.installPath, 'skills'), { withFileTypes: true })) {
          if (entry.isDirectory() || entry.isSymbolicLink()) add(provides.skills, entry.name, plugin.name);
        }
      } catch { /* 插件没有 skills 目录 */ }
      for (const key of await pluginMcpKeys(plugin.installPath)) add(provides.mcp, key, plugin.name);
    }
  }
  return provides;
}

// 已装插件按「名称@市场」合并；Antigravity 没有市场名，并入第一个同名行
export async function listPlugins(harnessPaths) {
  const state = await readPluginState(harnessPaths);
  const rows = new Map();
  for (const harnessId of ['codex', 'claude-code']) {
    for (const plugin of state[harnessId].plugins) {
      const id = `${plugin.name}@${plugin.marketplace}`;
      if (!rows.has(id)) rows.set(id, { id, name: plugin.name, marketplace: plugin.marketplace, harnesses: {} });
      rows.get(id).harnesses[harnessId] = { version: plugin.version, installPath: plugin.installPath };
    }
  }
  for (const plugin of state.antigravity.plugins) {
    const id = [...rows.keys()].find(key => rows.get(key).name === plugin.name) || `${plugin.name}@`;
    if (!rows.has(id)) rows.set(id, { id, name: plugin.name, marketplace: '', harnesses: {} });
    rows.get(id).harnesses.antigravity = { version: plugin.version, installPath: plugin.installPath };
  }
  const sortBy = key => (a, b) => a[key].localeCompare(b[key]);
  return {
    plugins: [...rows.values()].map(row => ({ ...row, builtin: BUILTIN_MARKETPLACES.includes(row.marketplace) })).sort(sortBy('id')),
    provides: await pluginProvides(state),
  };
}
