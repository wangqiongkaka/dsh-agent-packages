export const ENDPOINT = '/api/dsh-agent-packages';
export const HEADER_KEY = 'x-agent-pkg-key';
export const PLUGIN_ID = 'dsh-agent-packages';

export const HARNESS_IDS = ['codex', 'claude-code', 'antigravity', 'dsh'];
export const ANALYZER_HARNESS_IDS = ['codex', 'claude-code', 'antigravity'];
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
    instructionsFileName: 'AGENTS.md',
  },
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    supportsSkills: true,
    supportsMcp: true,
    mcpFormat: 'json-claude',
    instructionsFileName: 'CLAUDE.md',
  },
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity',
    supportsSkills: true,
    supportsMcp: true,
    mcpFormat: 'json-antigravity',
    instructionsFileName: 'AGENTS.md',
  },
  dsh: {
    id: 'dsh',
    label: 'DSH 原生',
    supportsSkills: true,
    supportsMcp: false,
    mcpFormat: 'none',
    instructionsFileName: 'AGENTS.md',
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

export function normalizeLineEndings(raw) {
  return String(raw ?? '').replace(/\r\n?/g, '\n');
}

function trimBlankEdgeLines(text) {
  const normalized = normalizeLineEndings(text);
  const trimmed = normalized.replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '');
  return trimmed.trim() ? trimmed : '';
}

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const START_MARKER_PATTERNS = [
  { style: 'underscore', re: /^\s*<!--\s*([A-Za-z0-9][A-Za-z0-9._-]*)_START\s*-->\s*$/i },
  { style: 'colon', re: /^\s*<!--\s*([A-Za-z0-9][A-Za-z0-9._-]*):START\s*-->\s*$/i },
  { style: 'begin', re: /^\s*<!--\s*BEGIN\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s*-->\s*$/i },
  { style: 'start', re: /^\s*<!--\s*START\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s*-->\s*$/i },
];

function parseBlockStart(line) {
  for (const { style, re } of START_MARKER_PATTERNS) {
    const match = re.exec(line);
    if (match) {
      return {
        style,
        tag: match[1],
        id: match[1].toUpperCase(),
        marker: line.trim(),
      };
    }
  }
  return null;
}

function isMatchingBlockEnd(line, opener) {
  const escaped = opener.tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let re;
  if (opener.style === 'underscore') {
    re = new RegExp(`^\\s*<!--\\s*${escaped}_END\\s*-->\\s*$`, 'i');
  } else if (opener.style === 'colon') {
    re = new RegExp(`^\\s*<!--\\s*${escaped}:END\\s*-->\\s*$`, 'i');
  } else {
    re = new RegExp(`^\\s*<!--\\s*END\\s+${escaped}\\s*-->\\s*$`, 'i');
  }
  return re.test(line);
}

function updateFenceState(line, fence) {
  const match = FENCE_RE.exec(line);
  if (!match) return fence;
  const marker = match[1];
  const ch = marker[0];
  if (!fence) return { ch, len: marker.length };
  if (fence.ch === ch && marker.length >= fence.len && /^\s*$/.test(line.slice(match[0].length))) {
    return null;
  }
  return fence;
}

// 提取文件中由外部工具注入的独立标记块（如 <!-- CODEGRAPH_START --> ... <!-- CODEGRAPH_END -->），
// 忽略 Markdown 代码围栏内的示例注释；未闭合的标记按普通正文保留。
export function extractExternalBlocks(rawText) {
  const lines = normalizeLineEndings(rawText).split('\n');
  const blocks = [];
  const bodyLines = [];
  let fence = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nextFence = updateFenceState(line, fence);
    if (fence || nextFence) {
      fence = nextFence;
      bodyLines.push(line);
      continue;
    }

    const opener = parseBlockStart(line);
    if (!opener) {
      bodyLines.push(line);
      continue;
    }

    let endIdx = -1;
    let innerFence = null;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j];
      const nextInnerFence = updateFenceState(candidate, innerFence);
      if (innerFence || nextInnerFence) {
        innerFence = nextInnerFence;
        continue;
      }
      if (isMatchingBlockEnd(candidate, opener)) {
        endIdx = j;
        break;
      }
    }

    if (endIdx < 0) {
      bodyLines.push(line);
      continue;
    }

    blocks.push({
      id: opener.id,
      startMarker: opener.marker,
      endMarker: lines[endIdx].trim(),
      content: trimBlankEdgeLines(lines.slice(i, endIdx + 1).join('\n')),
    });
    i = endIdx;
  }

  const collapsed = bodyLines.join('\n').replace(/\n{3,}/g, '\n\n');
  return {
    blocks,
    body: trimBlankEdgeLines(collapsed),
  };
}

// 由公共内容、单端私有内容以及需自动保留的外部工具标记块合成最终完整文件内容。
export function composeInstructionContent({ shared = '', privateContent = '', externalBlocks = [] } = {}) {
  const sharedBody = trimBlankEdgeLines(shared);
  const privateBody = trimBlankEdgeLines(privateContent);
  const sections = [];
  if (sharedBody) sections.push(sharedBody);
  if (privateBody) sections.push(privateBody);

  const manualLines = new Set(
    sections
      .join('\n')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
  );

  for (const block of externalBlocks) {
    const content = trimBlankEdgeLines(typeof block === 'string' ? block : block?.content);
    if (!content) continue;
    const startMarker = typeof block === 'string'
      ? content.split('\n')[0]?.trim()
      : String(block?.startMarker || '').trim();
    if (startMarker && manualLines.has(startMarker)) continue;
    sections.push(content);
  }

  return sections.length ? `${sections.join('\n\n')}\n` : '';
}
