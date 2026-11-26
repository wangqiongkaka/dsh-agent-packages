import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HARNESS_IDS } from './constants.mjs';
import { normalizeVersion } from './shared.mjs';
import { parseGitHubSlug, slugifyId } from './store.mjs';

const execFileAsync = promisify(execFile);

async function resolveGitHubToken(execCommand = execFileAsync) {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  try {
    const { stdout } = await execCommand('gh', ['auth', 'token'], { timeout: 3000 });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function fetchJson(url, { fetchImpl = fetch, headers = {} } = {}) {
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-agent-packages/0.1.0',
      ...headers,
    },
  });
  if (!response.ok) {
    const error = new Error(`请求 ${url} 失败（HTTP ${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function fetchText(url, { fetchImpl = fetch, headers = {} } = {}) {
  const response = await fetchImpl(url, {
    headers: {
      'user-agent': 'dsh-agent-packages/0.1.0',
      ...headers,
    },
  });
  if (!response.ok) return null;
  return response.text();
}

function detectHarnessFromContext(text) {
  const lower = text.toLowerCase();
  const hits = new Set();
  if (/\bcodex\b/.test(lower)) hits.add('codex');
  if (/\bclaude\b|\bclaude[\s-]code\b/.test(lower)) hits.add('claude-code');
  if (/\bantigravity\b|\bagy\b|\bgemini\b/.test(lower)) hits.add('antigravity');
  if (/\bdsh\b|deepseek[\s-]harness/.test(lower)) hits.add('dsh');
  return [...hits];
}

export function extractInstallCommandsFromReadme(readmeText) {
  if (!readmeText) return { perHarness: {}, generic: [] };
  const perHarness = {};
  const generic = [];
  const blockRegex = /(^|\n)(#{1,6}\s+[^\n]+)?[\s\S]{0,180}?```(?:sh|bash|zsh|shell|console)?\n([\s\S]*?)```/gi;
  let match;
  while ((match = blockRegex.exec(readmeText)) !== null) {
    const heading = match[2] ?? '';
    const block = match[3] ?? '';
    const headingHarnesses = detectHarnessFromContext(heading);
    const lines = block
      .split(/\r?\n/)
      .map(line => line.trim().replace(/^\$\s+/, ''))
      .filter(line => line && !line.startsWith('#'));

    for (const line of lines) {
      if (!/^(npx|npm|pnpm|uvx|pip|pipx|brew|curl|git|claude|codex|agy|dsh)\b/.test(line)) continue;
      if (/^claude\s+(mcp|plugin)\s+/i.test(line)) {
        perHarness['claude-code'] ??= line;
        continue;
      }
      if (/^codex\s+(mcp|plugin)\s+/i.test(line)) {
        perHarness.codex ??= line;
        continue;
      }
      if (/^agy\s+/i.test(line)) {
        perHarness.antigravity ??= line;
        continue;
      }
      if (/^dsh\s+/i.test(line)) {
        perHarness.dsh ??= line;
        continue;
      }
      const lineHarnesses = detectHarnessFromContext(line);
      const targets = lineHarnesses.length ? lineHarnesses : headingHarnesses;
      if (targets.length === 1) {
        perHarness[targets[0]] ??= line;
      } else if (/(install|add|setup|init|skills|mcp)/i.test(line)) {
        if (!generic.includes(line)) generic.push(line);
      }
    }
  }
  return { perHarness, generic };
}

function parsePyprojectPackage(tomlText) {
  if (!tomlText) return null;
  const nameMatch = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(tomlText);
  const versionMatch = /^\s*version\s*=\s*["']([^"']+)["']/m.exec(tomlText);
  const hasMcp = /mcp|fastmcp/i.test(tomlText);
  return {
    name: nameMatch?.[1] ?? '',
    version: versionMatch?.[1] ?? '',
    hasMcp,
  };
}

export const PLUGIN_MANIFEST_PATHS = [
  '.claude-plugin/marketplace.json',
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
  '.agents/plugins/marketplace.json',
];

function hookRefs(manifest) {
  const refs = manifest?.hooks;
  if (typeof refs === 'string') return [refs];
  if (Array.isArray(refs)) return refs.filter(item => typeof item === 'string');
  return [];
}

// 插件清单里引用的 hooks 文件（相对仓库根目录），Claude Code 还会自动加载 hooks/hooks.json。
export function pluginHookPaths(manifests = {}, treePaths = []) {
  const paths = [
    ...hookRefs(manifests['.claude-plugin/plugin.json']),
    ...hookRefs(manifests['.codex-plugin/plugin.json']),
  ].map(ref => ref.replace(/^\.\//, ''));
  if (treePaths.includes('hooks/hooks.json')) paths.push('hooks/hooks.json');
  return [...new Set(paths)].filter(path => treePaths.includes(path));
}

export function detectPlugin({ slug, manifests = {}, hookFiles = {} }) {
  const claudeMarketplace = manifests['.claude-plugin/marketplace.json'];
  const claudePlugin = manifests['.claude-plugin/plugin.json'];
  const codexPlugin = manifests['.codex-plugin/plugin.json'];
  const agentsMarketplace = manifests['.agents/plugins/marketplace.json'];
  if (!claudeMarketplace && !claudePlugin && !codexPlugin && !agentsMarketplace) return null;

  const listed = [...(claudeMarketplace?.plugins ?? []), ...(agentsMarketplace?.plugins ?? [])]
    .map(item => item?.name)
    .filter(name => typeof name === 'string' && name);
  const name = slugifyId(claudePlugin?.name || codexPlugin?.name || listed[0] || slug.repo);
  const marketplace = slugifyId(claudeMarketplace?.name || agentsMarketplace?.name || slug.repo);

  const hookSources = [claudePlugin?.hooks, codexPlugin?.hooks].filter(h => h && typeof h === 'object' && !Array.isArray(h));
  hookSources.push(...Object.values(hookFiles));
  const hookEvents = new Set();
  for (const source of hookSources) {
    const events = source?.hooks && typeof source.hooks === 'object' ? source.hooks : source;
    for (const [event, entries] of Object.entries(events ?? {})) {
      if (Array.isArray(entries) && entries.length) hookEvents.add(event);
    }
  }

  const harnesses = [];
  if (codexPlugin || agentsMarketplace) harnesses.push('codex');
  if (claudeMarketplace || claudePlugin) harnesses.push('claude-code', 'antigravity');
  return {
    name,
    marketplace,
    version: String(claudePlugin?.version || codexPlugin?.version || ''),
    harnesses: HARNESS_IDS.filter(id => harnesses.includes(id)),
    hookEvents: [...hookEvents],
    listedPlugins: [...new Set(listed)],
  };
}

export function inferPackageFromRepoMeta({
  slug,
  repoUrl,
  repoInfo = {},
  latestRelease = null,
  latestCommit = null,
  treePaths = [],
  packageJson = null,
  pyprojectToml = null,
  readme = '',
  pluginManifests = {},
  hookFiles = {},
}) {
  const plugin = detectPlugin({ slug, manifests: pluginManifests, hookFiles });
  const skillNames = [];
  for (const filePath of treePaths) {
    if (filePath === 'SKILL.md') {
      skillNames.push(slugifyId(slug.repo));
    } else if (/\/SKILL\.md$/.test(filePath)) {
      const segments = filePath.split('/');
      const skillDir = segments[segments.length - 2];
      if (skillDir && !skillDir.startsWith('.') && !skillNames.includes(skillDir)) {
        skillNames.push(skillDir);
      }
    }
  }

  const pkgDeps = {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {}),
    ...(packageJson?.peerDependencies ?? {}),
  };
  const npmName = typeof packageJson?.name === 'string' ? packageJson.name : '';
  const npmVersion = typeof packageJson?.version === 'string' ? packageJson.version : '';
  const hasNpmMcp = Boolean(
    pkgDeps['@modelcontextprotocol/sdk'] ||
    pkgDeps['fastmcp'] ||
    (npmName && /mcp/i.test(npmName) && (packageJson?.bin || /mcp/i.test(packageJson?.description ?? '')))
  );
  const pyInfo = parsePyprojectPackage(pyprojectToml);
  const hasPyMcp = Boolean(pyInfo?.name && pyInfo.hasMcp);
  const extracted = extractInstallCommandsFromReadme(readme);
  const hasPerHarnessInstaller = Object.keys(extracted.perHarness).length > 0;

  let kind = 'installer';
  if (plugin) {
    // 插件仓库优先：安装时还要注册 hooks 等组件，只同步 SKILL.md 会漏掉它们
    kind = 'plugin';
  } else if (skillNames.length > 0 && !hasNpmMcp && !hasPyMcp) {
    kind = 'skills-repo';
  } else if (hasNpmMcp || hasPyMcp) {
    kind = 'mcp';
  } else if (skillNames.length > 0) {
    kind = 'skills-repo';
  } else {
    kind = 'installer';
  }

  const releaseTag = latestRelease?.tag_name || '';
  const commitSha = latestCommit?.sha || '';
  const defaultBranch = repoInfo?.default_branch || 'main';
  const version = plugin
    ? (plugin.version || releaseTag.replace(/^v/, ''))
    : (hasNpmMcp && npmVersion)
    ? npmVersion
    : (hasPyMcp && pyInfo.version)
      ? pyInfo.version
      : releaseTag.replace(/^v/, '');

  const commands = {};
  // 插件类型由内置适配器调用各端插件命令；README 里零散的单行命令不完整，不带入草稿
  for (const harnessId of plugin ? [] : HARNESS_IDS) {
    if (extracted.perHarness[harnessId]) {
      commands[harnessId] = { install: extracted.perHarness[harnessId] };
    }
  }
  if (kind === 'installer' && Object.keys(commands).length === 0 && extracted.generic.length > 0) {
    for (const harnessId of ['codex', 'claude-code', 'antigravity']) {
      commands[harnessId] = { install: extracted.generic[0] };
    }
  }

  let mcp = {
    serverName: slugifyId(slug.repo),
    transport: 'stdio',
    command: '',
    args: [],
    url: '',
    envRefs: [],
    headers: {},
    overrides: {},
  };
  if (hasNpmMcp && npmName) {
    mcp = {
      ...mcp,
      command: 'npx',
      args: ['-y', version ? `${npmName}@{{version}}` : npmName],
    };
  } else if (hasPyMcp && pyInfo.name) {
    mcp = {
      ...mcp,
      command: 'uvx',
      args: [version ? `${pyInfo.name}=={{version}}` : pyInfo.name],
    };
  }

  const targets = plugin
    ? plugin.harnesses
    : kind === 'mcp'
      ? ['codex', 'claude-code', 'antigravity']
      : ['codex', 'claude-code', 'antigravity', 'dsh'];

  return {
    draft: {
      id: slugifyId(slug.repo),
      name: repoInfo?.name || slug.repo,
      kind,
      repo: repoUrl,
      description: String(repoInfo?.description || packageJson?.description || '').trim(),
      ref: releaseTag || defaultBranch,
      version,
      npmPackage: hasNpmMcp ? npmName : '',
      targets,
      skills: {
        include: [],
        mode: 'symlink',
      },
      mcp,
      ...(plugin ? { plugin: { name: plugin.name, marketplace: plugin.marketplace, harnesses: plugin.harnesses } } : {}),
      commands,
    },
    evidence: {
      plugin,
      defaultBranch,
      latestRelease: releaseTag || null,
      latestCommit: commitSha || null,
      discoveredSkills: skillNames,
      npmPackage: hasNpmMcp ? npmName : null,
      pythonPackage: hasPyMcp ? pyInfo.name : null,
      readmeCommands: extracted,
    },
  };
}

export async function inspectGitHubRepo(rawRepoUrl, options = {}) {
  const parsed = parseGitHubSlug(rawRepoUrl);
  if (!parsed) throw new Error('请输入有效的 GitHub 仓库地址（例如 owner/repo 或 https://github.com/owner/repo）');
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = options.token ?? await resolveGitHubToken(options.execCommand);
  const authHeaders = token ? { authorization: `Bearer ${token}` } : {};
  const apiBase = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;

  const repoInfo = await fetchJson(apiBase, { fetchImpl, headers: authHeaders });
  const defaultBranch = repoInfo.default_branch || 'main';

  const [latestRelease, latestCommit, treeData] = await Promise.all([
    fetchJson(`${apiBase}/releases/latest`, { fetchImpl, headers: authHeaders }).catch(() => null),
    fetchJson(`${apiBase}/commits/${encodeURIComponent(defaultBranch)}`, { fetchImpl, headers: authHeaders }).catch(() => null),
    fetchJson(`${apiBase}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`, { fetchImpl, headers: authHeaders }).catch(() => null),
  ]);

  const treePaths = Array.isArray(treeData?.tree)
    ? treeData.tree.filter(item => item?.type === 'blob' && typeof item.path === 'string').map(item => item.path)
    : [];

  const rawBase = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${encodeURIComponent(defaultBranch)}`;
  const hasPkgJson = treePaths.includes('package.json');
  const hasPyproject = treePaths.includes('pyproject.toml');
  const readmePath = treePaths.find(p => /^readme(\.md)?$/i.test(p)) || 'README.md';

  const [pkgText, pyprojectToml, readme] = await Promise.all([
    hasPkgJson ? fetchText(`${rawBase}/package.json`, { fetchImpl }) : Promise.resolve(null),
    hasPyproject ? fetchText(`${rawBase}/pyproject.toml`, { fetchImpl }) : Promise.resolve(null),
    fetchText(`${rawBase}/${readmePath}`, { fetchImpl }),
  ]);

  let packageJson = null;
  if (pkgText) {
    try { packageJson = JSON.parse(pkgText); } catch { packageJson = null; }
  }

  const fetchJsonFiles = async paths => Object.fromEntries((await Promise.all(paths.map(async path => {
    const text = await fetchText(`${rawBase}/${path}`, { fetchImpl });
    try { return [path, JSON.parse(text)]; } catch { return null; }
  }))).filter(Boolean));
  const pluginManifests = await fetchJsonFiles(PLUGIN_MANIFEST_PATHS.filter(path => treePaths.includes(path)));
  const hookFiles = await fetchJsonFiles(pluginHookPaths(pluginManifests, treePaths));

  return inferPackageFromRepoMeta({
    slug: parsed,
    repoUrl: parsed.url,
    repoInfo,
    latestRelease,
    latestCommit,
    treePaths,
    packageJson,
    pyprojectToml,
    readme: readme || '',
    pluginManifests,
    hookFiles,
  });
}

export async function checkPackageUpdate(pkg, lockEntry = {}, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const checkedAt = new Date().toISOString();
  const result = {
    checkedAt,
    latestRef: null,
    latestCommit: null,
    latestVersion: null,
    updateAvailable: false,
    source: '',
    error: '',
  };

  try {
    if (pkg.npmPackage) {
      const npmData = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(pkg.npmPackage)}/latest`, {
        fetchImpl,
        headers: { accept: 'application/json' },
      });
      if (typeof npmData?.version === 'string' && npmData.version) {
        result.latestVersion = npmData.version;
        result.source = 'npm';
        const currentVersion = pkg.version || lockEntry?.resolvedVersion || '';
        result.updateAvailable = Boolean(currentVersion && currentVersion !== npmData.version);
      }
    }

    const parsed = parseGitHubSlug(pkg.repo);
    if (parsed) {
      const token = options.token ?? await resolveGitHubToken(options.execCommand);
      const authHeaders = token ? { authorization: `Bearer ${token}` } : {};
      const apiBase = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;
      const repoInfo = await fetchJson(apiBase, { fetchImpl, headers: authHeaders });
      const defaultBranch = repoInfo.default_branch || 'main';
      const [release, commit] = await Promise.all([
        fetchJson(`${apiBase}/releases/latest`, { fetchImpl, headers: authHeaders }).catch(() => null),
        fetchJson(`${apiBase}/commits/${encodeURIComponent(defaultBranch)}`, { fetchImpl, headers: authHeaders }).catch(() => null),
      ]);
      const latestTag = release?.tag_name || null;
      const latestSha = commit?.sha || null;
      result.latestRef = latestTag || defaultBranch;
      result.latestCommit = latestSha;
      if (!result.latestVersion && latestTag) {
        result.latestVersion = latestTag.replace(/^v/, '');
      }
      if (!result.latestVersion && pkg.kind === 'plugin') {
        const rawBase = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${encodeURIComponent(defaultBranch)}`;
        for (const manifestPath of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
          const text = await fetchText(`${rawBase}/${manifestPath}`, { fetchImpl });
          if (!text) continue;
          try {
            const parsedManifest = JSON.parse(text);
            if (typeof parsedManifest?.version === 'string' && parsedManifest.version.trim()) {
              result.latestVersion = parsedManifest.version.trim();
              break;
            }
          } catch { /* ignore invalid json */ }
        }
      }
      result.source = result.source ? `${result.source}+github` : 'github';

      if (!result.updateAvailable) {
        const currentVer = pkg.version || lockEntry?.resolvedVersion || '';
        if (result.latestVersion && currentVer && normalizeVersion(currentVer) !== normalizeVersion(result.latestVersion)) {
          result.updateAvailable = true;
        } else if (latestTag && pkg.ref && pkg.ref !== defaultBranch && normalizeVersion(pkg.ref) !== normalizeVersion(latestTag)) {
          result.updateAvailable = true;
        } else if (latestSha && lockEntry?.resolvedCommit && lockEntry.resolvedCommit !== latestSha) {
          result.updateAvailable = true;
        }
      }
    }
  } catch (error) {
    result.error = error.message;
  }

  return result;
}
