export const ENDPOINT = '/api/dsh-agent-packages';
export const HEADER_KEY = 'x-agent-pkg-key';
export const PLUGIN_ID = 'dsh-agent-packages';

export const HARNESS_IDS = ['codex', 'claude-code', 'antigravity', 'dsh'];
export const PACKAGE_KINDS = ['skills-repo', 'mcp', 'installer'];

export const KIND_LABELS = {
  'skills-repo': 'Skills 仓库',
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
