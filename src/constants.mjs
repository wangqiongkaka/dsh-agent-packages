import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
export { ENDPOINT, HEADER_KEY, PLUGIN_ID, HARNESS_IDS, PACKAGE_KINDS, KIND_LABELS, HARNESS_META } from './shared.mjs';

export function resolveHarnessPaths(options = {}) {
  const home = resolve(options.homeDir || process.env.HOME || homedir());
  const dshHome = resolve(options.dshHome || process.env.DSH_HOME || join(home, '.dsh'));
  const codexHome = resolve(options.codexHome || process.env.CODEX_HOME || join(home, '.codex'));
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
    'claude-code': {
      skillsDir: join(home, '.claude', 'skills'),
      mcpFile: join(home, '.claude.json'),
      mcpFormat: 'json-claude',
    },
    antigravity: {
      skillsDir: join(home, '.gemini', 'config', 'skills'),
      legacySkillsDir: join(home, '.gemini', 'skills'),
      mcpFile: join(home, '.gemini', 'config', 'mcp_config.json'),
      legacyMcpFile: join(home, '.gemini', 'settings.json'),
      mcpFormat: 'json-antigravity',
    },
    dsh: {
      skillsDir: join(dshHome, 'skills'),
      mcpFile: null,
      mcpFormat: 'none',
    },
  };
}
