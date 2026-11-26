export const ENDPOINT = '/api/dsh-agent-packages';
export const HEADER_KEY = 'x-agent-pkg-key';
export const PLUGIN_ID = 'dsh-agent-packages';

export const HARNESS_IDS = ['codex', 'claude-code', 'antigravity', 'dsh'];
export const PACKAGE_KINDS = ['skills-repo', 'plugin', 'mcp', 'installer'];

export const KIND_LABELS = {
  'skills-repo': 'Skills 仓库',
  plugin: '插件（含 Hooks）',
  mcp: 'MCP Server',
  installer: '自定义安装器',
};

export const CARD_KIND_LABELS = {
  'skills-repo': 'Skills',
  plugin: '插件',
  mcp: 'MCP',
  installer: '安装器',
};

export const HARNESS_META = {
  codex: {
    id: 'codex',
    label: 'Codex',
    supportsSkills: true,
    supportsMcp: true,
    mcpFormat: 'toml',
  },
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    supportsSkills: true,
    supportsMcp: true,
    mcpFormat: 'json-claude',
  },
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity',
    supportsSkills: true,
    supportsMcp: true,
    mcpFormat: 'json-antigravity',
  },
  dsh: {
    id: 'dsh',
    label: 'DSH 原生',
    supportsSkills: true,
    supportsMcp: false,
    mcpFormat: 'none',
  },
};

// 添加前的 Harness 前置检查：返回不支持的原因，支持时返回空串。配了该端自定义安装命令即视为可装。
export function unsupportedReason(pkg, harnessId) {
  if (pkg.commands?.[harnessId]?.install) return '';
  if (pkg.kind === 'plugin') {
    if (harnessId === 'dsh') return '暂无插件机制';
    const declared = pkg.plugin?.harnesses ?? [];
    if (declared.length && !declared.includes(harnessId)) return '仓库没有该端可用的插件清单';
  }
  if (pkg.kind === 'mcp' && !HARNESS_META[harnessId]?.supportsMcp) return '没有可写入的 MCP 配置文件';
  return '';
}

const HEX_COMMIT_RE = /^[0-9a-f]{40}$/i;
const SEMVER_LIKE_RE = /^v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)$/;

export function normalizeVersion(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const m = SEMVER_LIKE_RE.exec(s);
  return m ? m[1] : s;
}

export function formatVersion(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (HEX_COMMIT_RE.test(s)) return s.slice(0, 7);
  if (/^\d+\.\d+/.test(s)) return `v${s}`;
  return s;
}

export function formatHarnessVersion(hs) {
  if (!hs || hs.status !== 'installed') return '';
  const ver = String(hs.installedVersion ?? '').trim();
  const commit = String(hs.installedCommit ?? '').trim();
  const shortCommit = commit ? commit.slice(0, 7) : '';
  if (ver) {
    const formatted = formatVersion(ver);
    // 分支名（非语义版本）附带短 commit 便于区分实际检出版本
    if (shortCommit && !SEMVER_LIKE_RE.test(ver) && !HEX_COMMIT_RE.test(ver) && ver !== shortCommit) {
      return `${formatted} (${shortCommit})`;
    }
    return formatted;
  }
  return shortCommit;
}

export function summarizePackageVersions(pkg) {
  const installedByKey = new Map();
  for (const harnessId of HARNESS_IDS) {
    const hs = pkg.harnessStatuses?.[harnessId];
    if (!hs || hs.status !== 'installed') continue;
    const label = formatHarnessVersion(hs);
    if (!label) continue;
    const key = normalizeVersion(hs.installedVersion || hs.installedCommit?.slice(0, 7) || label);
    if (!installedByKey.has(key)) installedByKey.set(key, label);
  }
  const installedVersions = [...installedByKey.values()];
  const mixedVersions = installedVersions.length > 1;

  const declaredRaw = pkg.version || pkg.ref || pkg.lock?.resolvedVersion || pkg.lock?.resolvedCommit || '';
  const resolvedCommit = pkg.lock?.resolvedCommit ? pkg.lock.resolvedCommit.slice(0, 7) : '';
  let declaredLabel = formatVersion(declaredRaw);
  if (declaredRaw && resolvedCommit && !SEMVER_LIKE_RE.test(declaredRaw) && !HEX_COMMIT_RE.test(declaredRaw) && declaredRaw !== resolvedCommit) {
    declaredLabel = `${declaredLabel} (${resolvedCommit})`;
  }

  const currentLabel = installedVersions.length > 0
    ? installedVersions.join(' / ')
    : declaredLabel;

  const latestRaw = pkg.lock?.latestVersion || pkg.lock?.latestRef || pkg.lock?.latestCommit || '';
  const latestLabel = formatVersion(latestRaw);
  const hasUpdate = Boolean(pkg.lock?.updateAvailable && latestLabel);
  const isUpToDate = Boolean(pkg.lock?.checkedAt && !pkg.lock?.updateAvailable && !pkg.lock?.checkError);

  return {
    currentLabel,
    latestLabel,
    installedVersions,
    mixedVersions,
    hasUpdate,
    isUpToDate,
  };
}
