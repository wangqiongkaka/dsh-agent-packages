import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
export { ENDPOINT, HEADER_KEY, PLUGIN_ID, HARNESS_IDS, ANALYZER_HARNESS_IDS, PACKAGE_KINDS, KIND_LABELS, HARNESS_META } from './shared.mjs';

function resolveConfigPath(raw, home) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return '';
  if (trimmed === '~') return home;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return resolve(home, trimmed.slice(2));
  return resolve(trimmed);
}

// 与 Claude Code 原生规则一致：未设 CLAUDE_CONFIG_DIR 时用 ~/.claude/* 与 ~/.claude.json；
// 显式指定配置目录后，skills、plugins 与 .claude.json 均落在该目录内。
export function resolveClaudeCodePaths(home, explicitConfigDir = '') {
  const resolvedHome = resolve(home);
  const explicit = resolveConfigPath(explicitConfigDir, resolvedHome);
  const configDir = explicit || join(resolvedHome, '.claude');
  return {
    configDir,
    explicitConfigDir: explicit,
    skillsDir: join(configDir, 'skills'),
    mcpFile: explicit ? join(configDir, '.claude.json') : join(resolvedHome, '.claude.json'),
    mcpFormat: 'json-claude',
    pluginsDir: join(configDir, 'plugins'),
  };
}

export function resolveHarnessPaths(options = {}) {
  const home = resolve(options.homeDir || process.env.HOME || homedir());
  const dshHome = resolve(options.dshHome || process.env.DSH_HOME || join(home, '.dsh'));
  const codexHome = resolve(options.codexHome || process.env.CODEX_HOME || join(home, '.codex'));
  const explicitClaudeConfigDir = resolveConfigPath(options.claudeConfigDir || process.env.CLAUDE_CONFIG_DIR, home);
  return {
    home,
    dshHome,
    agentsSkillsDir: join(home, '.agents', 'skills'),
    agentsSkillLockFile: join(home, '.agents', '.skill-lock.json'),
    codex: {
      skillsDir: join(codexHome, 'skills'),
      mcpFile: join(codexHome, 'config.toml'),
      mcpFormat: 'toml',
    },
    'claude-code': resolveClaudeCodePaths(home, explicitClaudeConfigDir),
    antigravity: {
      skillsDir: join(home, '.gemini', 'config', 'skills'),
      legacySkillsDir: join(home, '.gemini', 'skills'),
      mcpFile: join(home, '.gemini', 'config', 'mcp_config.json'),
      legacyMcpFile: join(home, '.gemini', 'settings.json'),
      mcpFormat: 'json-antigravity',
      pluginsDir: join(home, '.gemini', 'config', 'plugins'),
    },
    dsh: {
      skillsDir: join(dshHome, 'skills'),
      mcpFile: null,
      mcpFormat: 'none',
    },
  };
}
