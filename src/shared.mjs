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
