import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { HARNESS_META } from './shared.mjs';

export const PLUGIN_HARNESSES = ['codex', 'claude-code', 'antigravity'];
// Codex 随应用自带的市场，插件归入单独的折叠组
export const BUILTIN_MARKETPLACES = ['openai-bundled', 'openai-primary-runtime'];
export const PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

function sourceString(source) {
  if (!source) return '';
  if (typeof source === 'string') return source;
  return source.repo || source.url || source.path || '';
}

function splitId(id) {
  const at = id.lastIndexOf('@');
  return at > 0 ? [id.slice(0, at), id.slice(at + 1)] : [id, ''];
}

function agyMarketplaceDirs(home) {
  return [join(home, '.gemini', 'antigravity-cli', 'cache', 'marketplaces'), join(home, '.gemini', 'antigravity', 'cache', 'marketplaces')];
}

// 只读文件识别三端的市场与已装插件，不调用任何 CLI（Codex 的 plugin list 会在线拉取，可能挂起很久）
export async function readPluginState(harnessPaths) {
  const state = {};

  const claudeDir = harnessPaths['claude-code'].pluginsDir;
  const known = await readJsonQuiet(join(claudeDir, 'known_marketplaces.json')) ?? {};
  const claudeInstalled = await readJsonQuiet(join(claudeDir, 'installed_plugins.json'));
  state['claude-code'] = {
    marketplaces: Object.fromEntries(Object.entries(known).map(([name, meta]) => [name, {
      source: sourceString(meta?.source),
      root: meta?.installLocation || join(claudeDir, 'marketplaces', name),
    }])),
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
  const codexMarketplaces = {};
  for (const m of toml.matchAll(/^\[marketplaces\.(?:"([^"]+)"|([A-Za-z0-9._-]+))\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/gm)) {
    const name = m[1] || m[2];
    const type = /^\s*source_type\s*=\s*"([^"]*)"/m.exec(m[3])?.[1] || '';
    const source = /^\s*source\s*=\s*"([^"]*)"/m.exec(m[3])?.[1] || '';
    codexMarketplaces[name] = {
      source,
      root: type === 'local' && source ? source : join(codexHome, '.tmp', 'marketplaces', name),
    };
  }
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
  state.codex = { marketplaces: codexMarketplaces, plugins: codexPlugins };

  const agyPlugins = [];
  try {
    for (const entry of await readdir(harnessPaths.antigravity.pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = join(harnessPaths.antigravity.pluginsDir, entry.name);
      agyPlugins.push({ name: entry.name, marketplace: '', version: await manifestVersion(dir), installPath: dir });
    }
  } catch { /* 目录不存在即没有插件 */ }
  const agyMarketplaces = {};
  for (const dir of agyMarketplaceDirs(harnessPaths.home)) {
    try {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !agyMarketplaces[entry.name]) agyMarketplaces[entry.name] = { source: '', root: join(dir, entry.name), builtin: true };
      }
    } catch { /* 没有缓存 */ }
  }
  state.antigravity = { marketplaces: agyMarketplaces, plugins: agyPlugins };
  return state;
}

async function pluginMcpKeys(dir) {
  const keys = [];
  const mcpFile = await readJsonQuiet(join(dir, '.mcp.json'));
  if (mcpFile) keys.push(...Object.keys(mcpFile.mcpServers ?? mcpFile));
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
  const marketplaces = new Map();
  for (const harnessId of PLUGIN_HARNESSES) {
    for (const [name, meta] of Object.entries(state[harnessId].marketplaces)) {
      if (!marketplaces.has(name)) marketplaces.set(name, { name, source: '', harnesses: {} });
      const row = marketplaces.get(name);
      row.harnesses[harnessId] = meta;
      if (!row.source && meta.source) row.source = meta.source;
    }
  }
  const sortBy = key => (a, b) => a[key].localeCompare(b[key]);
  return {
    plugins: [...rows.values()].map(row => ({ ...row, builtin: BUILTIN_MARKETPLACES.includes(row.marketplace) })).sort(sortBy('id')),
    marketplaces: [...marketplaces.values()].map(row => ({ ...row, builtin: BUILTIN_MARKETPLACES.includes(row.name) || Boolean(row.harnesses.antigravity?.builtin) })).sort(sortBy('name')),
    provides: await pluginProvides(state),
  };
}

async function readMarketplaceManifest(root) {
  for (const rel of ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json', 'marketplace.json']) {
    const manifest = await readJsonQuiet(join(root, rel));
    if (Array.isArray(manifest?.plugins)) return manifest;
  }
  return null;
}

// 某个市场里可装的插件（来自本地 marketplace.json）；相对路径来源可得到本地目录，供 Antigravity 安装
export async function listMarketplacePlugins(harnessPaths, name) {
  const { marketplaces } = await listPlugins(harnessPaths);
  const marketplace = marketplaces.find(item => item.name === name);
  if (!marketplace) throw new Error(`没有名为「${name}」的市场`);
  for (const meta of Object.values(marketplace.harnesses)) {
    const manifest = await readMarketplaceManifest(meta.root);
    if (!manifest) continue;
    return manifest.plugins.filter(p => typeof p?.name === 'string').map(p => ({
      name: p.name,
      description: typeof p.description === 'string' ? p.description : '',
      version: typeof p.version === 'string' ? p.version : '',
      localDir: typeof p.source === 'string' ? resolve(meta.root, p.source) : '',
    }));
  }
  return [];
}

// 某端此刻不能安装 / 卸载的原因；可以时返回空串
export function pluginBlockReason({ harness, marketplace, marketplaceRow, localDir, installed }) {
  const label = HARNESS_META[harness]?.label ?? harness;
  if (harness === 'dsh') return 'DSH 原生没有插件机制';
  if (installed) return '';
  if (harness === 'antigravity') {
    if (marketplaceRow?.harnesses.antigravity) return '';
    return localDir ? '' : '插件源不在本地，先在 Claude Code 或 Codex 安装一次';
  }
  if (!marketplace) return `${label} 需要知道插件所属的市场`;
  return marketplaceRow?.harnesses[harness] ? '' : `${label} 未添加市场 ${marketplace}，先在「市场」组开启`;
}

export function pluginArgv({ harness, action, name, marketplace, localDir, agyBuiltin, claudeCommand = 'claude', codexCommand = 'codex' }) {
  const id = `${name}@${marketplace}`;
  if (harness === 'claude-code') {
    return { install: [claudeCommand, 'plugin', 'install', id], uninstall: [claudeCommand, 'plugin', 'uninstall', id], update: [claudeCommand, 'plugin', 'update', id] }[action];
  }
  if (harness === 'codex') {
    return { install: [codexCommand, 'plugin', 'add', id], uninstall: [codexCommand, 'plugin', 'remove', id], update: [codexCommand, 'plugin', 'add', id] }[action];
  }
  if (harness === 'antigravity') {
    if (action === 'uninstall') return ['agy', 'plugin', 'uninstall', name];
    // agy 没有「添加市场」：内置市场用 名称@市场，其他市场用本地插件目录（agy 会转换 Claude Code 格式）
    return ['agy', 'plugin', 'install', agyBuiltin ? id : localDir];
  }
  throw new Error(`${HARNESS_META[harness]?.label ?? harness} 没有插件机制`);
}

export function marketplaceArgv({ harness, action, name, source, claudeCommand = 'claude', codexCommand = 'codex' }) {
  const base = harness === 'claude-code' ? [claudeCommand, 'plugin', 'marketplace'] : harness === 'codex' ? [codexCommand, 'plugin', 'marketplace'] : null;
  if (!base) throw new Error(`${HARNESS_META[harness]?.label ?? harness} 不支持添加市场`);
  if (action === 'add') return [...base, 'add', source];
  if (action === 'remove') return [...base, 'remove', name];
  return [...base, harness === 'claude-code' ? 'update' : 'upgrade', name];
}
