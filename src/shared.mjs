export const ENDPOINT = '/api/dsh-agent-packages';
export const HEADER_KEY = 'x-agent-pkg-key';
export const PLUGIN_ID = 'dsh-agent-packages';

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const HARNESS_IDS = ['codex', 'claude-code', 'antigravity', 'dsh'];
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

export function normalizeLineEndings(raw) {
  return String(raw ?? '').replace(/\r\n?/g, '\n');
}

function trimBlankEdgeLines(text) {
  const normalized = normalizeLineEndings(text);
  const trimmed = normalized.replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '');
  return trimmed.trim() ? trimmed : '';
}

// 规则片段按顺序拼接出某端的最终文件内容：与 composeInstructionContent 同样去首尾空行、以空行分隔，
// 所以「公共 + 私有」迁移成两个片段后拼接结果逐字节不变。
export function composeSnippets(snippets = [], harnessId) {
  const sections = snippets
    .filter(snippet => Array.isArray(snippet?.harnesses) && snippet.harnesses.includes(harnessId))
    .map(snippet => trimBlankEdgeLines(snippet.content))
    .filter(Boolean);
  return sections.length ? `${sections.join('\n\n')}\n` : '';
}

// 由公共内容与单端私有内容合成最终完整文件内容。
export function composeInstructionContent({ shared = '', privateContent = '' } = {}) {
  const sections = [trimBlankEdgeLines(shared), trimBlankEdgeLines(privateContent)].filter(Boolean);
  return sections.length ? `${sections.join('\n\n')}\n` : '';
}
