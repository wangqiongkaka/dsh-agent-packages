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
  if (/\bantigravity\b|\bagy\b/.test(lower)) hits.add('antigravity');
  if (/\bdsh\b|deepseek[\s-]harness/.test(lower)) hits.add('dsh');
  return [...hits];
}

const GENERIC_CLI_COMMANDS = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'uv', 'uvx', 'pip', 'pipx', 'brew',
  'curl', 'wget', 'git', 'claude', 'codex', 'agy', 'dsh', 'sh', 'bash', 'zsh',
  'sudo', 'irm', 'iex', 'cd', 'mkdir', 'rm', 'cp', 'mv', 'ls', 'cat', 'echo', 'export',
]);

const INTERNAL_SKILL_DIR_RE = /^\.(?:claude|cursor|codex|gemini|github|vscode|windsurf|kiro)\//i;

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripShellComment(line) {
  return line.replace(/\s+#(?:\s.*)?$/, '').trim();
}

function detectCliBin(packageJson, readmeText = '') {
  const bin = packageJson?.bin;
  if (typeof bin === 'string' && bin.trim()) {
    const rawName = String(packageJson?.name ?? '').replace(/^@[^/]+\//, '').trim();
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(rawName)) return rawName;
  } else if (bin && typeof bin === 'object' && !Array.isArray(bin)) {
    for (const key of Object.keys(bin)) {
      if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) return key;
    }
  }
  // 无 package.json bin 时，从 README 代码块里找同时出现 install / upgrade / uninstall 的自有 CLI
  if (!readmeText) return '';
  const counts = new Map();
  const re = /^\s*(?:\$\s+)?([A-Za-z][A-Za-z0-9._-]*)\s+(install|upgrade|uninstall)\b/gm;
  let m;
  while ((m = re.exec(readmeText)) !== null) {
    const cmd = m[1].toLowerCase();
    if (GENERIC_CLI_COMMANDS.has(cmd)) continue;
    const set = counts.get(cmd) ?? new Set();
    set.add(m[2].toLowerCase());
    counts.set(cmd, set);
  }
  for (const [cmd, verbs] of counts.entries()) {
    if (verbs.size >= 2) return cmd;
  }
  return '';
}

export function extractInstallCommandsFromReadme(readmeText, options = {}) {
  const cliBin = typeof options.cliBin === 'string' ? options.cliBin.trim() : '';
  const empty = {
    perHarness: {},
    generic: [],
    cliInstall: '',
    cliUpgrade: '',
    agentSetup: '',
    agentUninstall: '',
    flags: { target: false, yes: false, keepCli: false },
    mentionedHarnesses: [],
  };
  if (!readmeText) return empty;
  const perHarness = {};
  const generic = [];
  const cliInstallCandidates = [];
  let cliUpgrade = '';
  let agentSetup = '';
  let agentUninstall = '';
  const cliPrefixRe = cliBin ? new RegExp(`^${escapeRegex(cliBin)}\\b`) : null;

  const blockRegex = /(^|\n)(#{1,6}\s+[^\n]+)?[\s\S]{0,220}?```(?:sh|bash|zsh|shell|console)?\n([\s\S]*?)```/gi;
  let match;
  while ((match = blockRegex.exec(readmeText)) !== null) {
    const heading = match[2] ?? '';
    const block = match[3] ?? '';
    const headingHarnesses = detectHarnessFromContext(heading);
    const lines = block
      .split(/\r?\n/)
      .map(line => stripShellComment(line.trim().replace(/^\$\s+/, '')))
      .filter(line => line && !line.startsWith('#'));

    for (const line of lines) {
      const isKnownStarter = /^(npx|npm|pnpm|bun|uvx|uv|pip|pipx|brew|curl|wget|git|claude|codex|agy|dsh)\b/.test(line);
      const isCliStarter = Boolean(cliPrefixRe && cliPrefixRe.test(line));
      if (!isKnownStarter && !isCliStarter) continue;

      if (isCliStarter) {
        const sub = line.slice(cliBin.length).trim();
        if (/^(install|setup)(?:\s|$)/i.test(sub) && !/--(help|print-config|check)\b/.test(sub) && !/<[^>]+>|\[[^\]]+\]/.test(sub)) {
          if (!agentSetup) agentSetup = line;
          continue;
        }
        if (/^(upgrade|update)(?:\s|$)/i.test(sub) && !/--(help|check)\b/.test(sub)) {
          if (!cliUpgrade) {
            if (/\[version\]|<version>/i.test(sub)) {
              cliUpgrade = `${cliBin} upgrade {{version}}`;
            } else if (!/<[^>]+>|\[[^\]]+\]/.test(sub)) {
              cliUpgrade = line;
            }
          }
          continue;
        }
        if (/^uninstall(?:\s|$)/i.test(sub) && !/--help\b/.test(sub) && !/<[^>]+>|\[[^\]]+\]/.test(sub)) {
          if (!agentUninstall) agentUninstall = line;
          continue;
        }
        continue;
      }

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

      // CLI 本体安装命令候选（官方脚本优先，其次 brew，其次 npm/pnpm/pipx/uv 全局安装）
      if (/^(?:curl|wget)\b[^|]+\|\s*(?:ba|z)?sh\b/i.test(line) && !/--uninstall\b/i.test(line)) {
        cliInstallCandidates.push({ priority: 1, cmd: line });
      } else if (/^brew\s+install\s+/i.test(line)) {
        cliInstallCandidates.push({ priority: 2, cmd: line });
      } else if (/^(?:npm\s+(?:i|install)\s+(?:-g|--global)|pnpm\s+(?:add|i)\s+-g|bun\s+(?:add|i)\s+-g|pipx\s+install|uv\s+tool\s+install)\b/i.test(line)) {
        cliInstallCandidates.push({ priority: 3, cmd: line });
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

  // README 内联文案中提到 `<cli> upgrade [version]` 或 `<cli> upgrade <version>` 时补充版本占位
  if (cliBin) {
    const esc = escapeRegex(cliBin);
    const acceptsVersion = new RegExp(`${esc}\\s+upgrade\\s+(?:\\[version\\]|<version>)`, 'i').test(readmeText);
    if (!cliUpgrade && new RegExp('`' + esc + '\\s+upgrade\\b', 'i').test(readmeText)) {
      cliUpgrade = acceptsVersion ? `${cliBin} upgrade {{version}}` : `${cliBin} upgrade`;
    } else if (cliUpgrade && acceptsVersion && !cliUpgrade.includes('{{version}}')) {
      cliUpgrade = `${cliUpgrade} {{version}}`;
    }
  }

  cliInstallCandidates.sort((a, b) => a.priority - b.priority);
  const cliInstall = cliInstallCandidates[0]?.cmd || '';

  const flags = {
    target: /(?:--target\b|-t,\s*--target\b)/.test(readmeText),
    yes: /(?:--yes\b|-y,\s*--yes\b)/.test(readmeText),
    keepCli: /--keep-cli\b/.test(readmeText),
  };

  // 从「Supported Agents」或安装说明段落提取支持的 Harness
  const agentsSectionMatch = /(^|\n)##\s+Supported\s+Agents[\s\S]*?(?=\n##\s+|$)/i.exec(readmeText);
  const mentionScope = agentsSectionMatch ? agentsSectionMatch[0] : readmeText;
  const mentionedHarnesses = HARNESS_IDS.filter(id => detectHarnessFromContext(mentionScope).includes(id));

  return {
    perHarness,
    generic,
    cliInstall,
    cliUpgrade,
    agentSetup,
    agentUninstall,
    flags,
    mentionedHarnesses,
  };
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
  '.antigravity-plugin/plugin.json',
  '.gemini-plugin/plugin.json',
  'plugin.json',
  'gemini-extension.json',
];

const BULK_PLUGIN_MANIFEST_RE = /^plugins\/[^/]+\/plugin\.json$/;

export function collectPluginManifestPaths(treePaths = []) {
  const matched = PLUGIN_MANIFEST_PATHS.filter(path => treePaths.includes(path));
  for (const path of treePaths) {
    if (BULK_PLUGIN_MANIFEST_RE.test(path)) matched.push(path);
  }
  return [...new Set(matched)];
}

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
  const agyRootPlugin = manifests['.antigravity-plugin/plugin.json']
    || manifests['.gemini-plugin/plugin.json']
    || manifests['plugin.json']
    || manifests['gemini-extension.json'];
  const bulkPlugins = Object.entries(manifests)
    .filter(([path]) => BULK_PLUGIN_MANIFEST_RE.test(path))
    .map(([, manifest]) => manifest)
    .filter(Boolean);
  const agyPlugin = agyRootPlugin || bulkPlugins[0];
  if (!claudeMarketplace && !claudePlugin && !codexPlugin && !agentsMarketplace && !agyPlugin) return null;

  const listed = [...(claudeMarketplace?.plugins ?? []), ...(agentsMarketplace?.plugins ?? []), ...bulkPlugins]
    .map(item => item?.name)
    .filter(name => typeof name === 'string' && name);
  const name = slugifyId(claudePlugin?.name || codexPlugin?.name || agyPlugin?.name || listed[0] || slug.repo);
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
  if (claudeMarketplace || claudePlugin) harnesses.push('claude-code');
  if (agyPlugin || claudeMarketplace || claudePlugin) harnesses.push('antigravity');
  return {
    name,
    marketplace,
    version: String(claudePlugin?.version || codexPlugin?.version || agyPlugin?.version || ''),
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
  const cliBin = detectCliBin(packageJson, readme);
  const hasInstallScript = treePaths.some(p => /^install\.(sh|bash)$/i.test(p));
  const hasPackageBin = Boolean(
    (typeof packageJson?.bin === 'string' && packageJson.bin.trim()) ||
    (packageJson?.bin && typeof packageJson.bin === 'object' && Object.keys(packageJson.bin).length > 0)
  );
  const hasCliProject = Boolean(cliBin || hasInstallScript || hasPackageBin);

  const publicSkillNames = [];
  const internalSkillNames = [];
  for (const filePath of treePaths) {
    let skillName = '';
    if (filePath === 'SKILL.md') {
      skillName = slugifyId(slug.repo);
    } else if (/\/SKILL\.md$/.test(filePath)) {
      const segments = filePath.split('/');
      const skillDir = segments[segments.length - 2];
      if (skillDir && !skillDir.startsWith('.')) skillName = skillDir;
    }
    if (!skillName) continue;
    const bucket = INTERNAL_SKILL_DIR_RE.test(filePath) ? internalSkillNames : publicSkillNames;
    if (!bucket.includes(skillName)) bucket.push(skillName);
  }
  // CLI 工具仓库中仅存在于 .claude/skills 等隐藏目录的 SKILL.md 属于项目自用开发技能，不作为对外分发 Skills
  const skillNames = publicSkillNames.length > 0
    ? publicSkillNames
    : (hasCliProject ? [] : internalSkillNames);

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
    (npmName && /mcp/i.test(npmName) && (hasPackageBin || /mcp/i.test(packageJson?.description ?? '')))
  );
  const publishableNpmName = npmName && !packageJson?.private && (hasNpmMcp || hasPackageBin) ? npmName : '';
  const pyInfo = parsePyprojectPackage(pyprojectToml);
  const hasPyMcp = Boolean(pyInfo?.name && pyInfo.hasMcp);
  const extracted = extractInstallCommandsFromReadme(readme, { cliBin });

  // 从仓库 installer/targets/<id> 文件精确识别各 Harness 的 target ID（如 claude vs claude-code）
  const repoTargetIds = {};
  for (const filePath of treePaths) {
    const m = /(?:^|\/)targets\/(codex|claude-code|claude|antigravity|dsh)\.[jt]sx?$/i.exec(filePath);
    if (!m) continue;
    const raw = m[1].toLowerCase();
    const harnessId = raw === 'claude' ? 'claude-code' : raw;
    repoTargetIds[harnessId] ??= raw;
  }

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
        : (releaseTag.replace(/^v/, '') || npmVersion);

  const commands = {};
  // 插件类型由内置适配器调用各端插件命令；README 里零散的单行命令不完整，不带入草稿
  for (const harnessId of plugin ? [] : HARNESS_IDS) {
    if (extracted.perHarness[harnessId]) {
      commands[harnessId] = { install: extracted.perHarness[harnessId] };
    }
  }

  const installerHarnesses = Object.keys(repoTargetIds).length > 0
    ? HARNESS_IDS.filter(id => id in repoTargetIds)
    : extracted.mentionedHarnesses.length > 0
      ? extracted.mentionedHarnesses
      : ['codex', 'claude-code', 'antigravity'];

  if (kind === 'installer' && Object.keys(commands).length === 0) {
    const fallbackCliInstall = extracted.cliInstall ||
      (publishableNpmName ? `npm install -g ${publishableNpmName}${version ? '@{{version}}' : ''}` : '');
    const cliVersionCmd = cliBin && (hasPackageBin || new RegExp(`\\b${escapeRegex(cliBin)}\\s+(?:--version|version)\\b`).test(readme))
      ? `${cliBin} --version`
      : '';
    const supportsPerTargetCli = Boolean(
      extracted.agentSetup &&
      extracted.flags.yes &&
      (extracted.flags.target || Object.keys(repoTargetIds).length > 0)
    );

    if (supportsPerTargetCli) {
      const defaultTargetMap = { codex: 'codex', 'claude-code': 'claude', antigravity: 'antigravity', dsh: 'dsh' };
      const shared = {};
      if (fallbackCliInstall) shared.install = fallbackCliInstall;
      if (extracted.cliUpgrade) shared.upgrade = extracted.cliUpgrade;
      if (extracted.agentUninstall) shared.uninstall = `${extracted.agentUninstall} --yes`;
      if (cliVersionCmd) shared.version = cliVersionCmd;
      if (Object.keys(shared).length > 0) commands.shared = shared;

      for (const harnessId of installerHarnesses) {
        const targetFlag = repoTargetIds[harnessId] || defaultTargetMap[harnessId] || harnessId;
        const entry = {
          install: `${extracted.agentSetup} --target ${targetFlag} --yes`,
        };
        if (extracted.agentUninstall) {
          entry.uninstall = `${extracted.agentUninstall} --target ${targetFlag} --yes${extracted.flags.keepCli ? ' --keep-cli' : ''}`;
        }
        commands[harnessId] = entry;
      }
    } else if (fallbackCliInstall || extracted.agentSetup) {
      const shared = {};
      const setupCmd = extracted.agentSetup
        ? `${extracted.agentSetup}${extracted.flags.yes ? ' --yes' : ''}`
        : '';
      if (fallbackCliInstall && setupCmd) {
        shared.install = `${fallbackCliInstall} && ${setupCmd}`;
      } else {
        shared.install = fallbackCliInstall || setupCmd;
      }
      if (extracted.cliUpgrade) shared.upgrade = extracted.cliUpgrade;
      if (extracted.agentUninstall) {
        shared.uninstall = `${extracted.agentUninstall}${extracted.flags.yes ? ' --yes' : ''}`;
      }
      if (cliVersionCmd) shared.version = cliVersionCmd;
      if (Object.keys(shared).length > 0) commands.shared = shared;
    } else if (extracted.generic.length > 0) {
      commands.shared = { install: extracted.generic[0] };
    }
  }

  let mcp = {
    serverName: slugifyId(slug.repo),
    transport: 'stdio',
    command: '',
    args: [],
    url: '',
    envRefs: [],
    env: {},
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
      : kind === 'installer'
        ? installerHarnesses
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
      npmPackage: publishableNpmName,
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
      cliBin: cliBin || null,
      defaultBranch,
      latestRelease: releaseTag || null,
      latestCommit: commitSha || null,
      discoveredSkills: skillNames,
      npmPackage: publishableNpmName || null,
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
  const pluginManifests = await fetchJsonFiles(collectPluginManifestPaths(treePaths));
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
