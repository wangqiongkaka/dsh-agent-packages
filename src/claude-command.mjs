import { realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';

// dsh-harness-provider 在 DSH 设置中的命名空间（profile 条目 id），统一配置 Claude Code 命令（claudeCommand）与配置目录（claudeConfigDir）。
export const HARNESS_PROVIDER_SETTINGS = 'harness-plugin';

function readHarnessProviderSetting(getSettings, key) {
  try {
    const value = getSettings()?.describe?.().find(row => row?.ns === HARNESS_PROVIDER_SETTINGS)?.value?.[key];
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

// 读取 harness-provider 当前配置的 claudeCommand；设置服务缺失、未配置或格式不符时返回空串，回落到 claude。
export function readHarnessClaudeCommand(getSettings) {
  return readHarnessProviderSetting(getSettings, 'claudeCommand');
}

// 读取 harness-provider 当前配置的 claudeConfigDir（对应 CLAUDE_CONFIG_DIR）；未配置或格式不符时返回空串。
export function readHarnessClaudeConfigDir(getSettings) {
  return readHarnessProviderSetting(getSettings, 'claudeConfigDir');
}

const isReclaudeName = name => ['reclaude', 'rec'].includes(basename(name).replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase());

export async function isReclaudeCommand(command) {
  if (isReclaudeName(command)) return true;
  if (!command.includes('/') && !command.includes('\\')) return false;
  try { return isReclaudeName(await realpath(command)); } catch { return false; }
}

// reclaude 为每个绑定账号隔离 Claude Code 配置：<data_dir>/claude/accounts/<device_id>/config。
// 探测失败返回 null，调用方保持默认配置目录。
export async function reclaudeConfigDir(command, execImpl) {
  try {
    const { stdout } = await execImpl(command, ['status', '--json'], { timeout: 5_000 });
    const status = JSON.parse(stdout);
    const dataDir = typeof status?.global?.data_dir === 'string' ? status.global.data_dir.trim() : '';
    const raw = status?.claude?.current?.device_id;
    const account = Number.isSafeInteger(raw) && raw >= 0 ? String(raw)
      : typeof raw === 'string' && /^[A-Za-z0-9._-]+$/.test(raw) && raw !== '.' && raw !== '..' ? raw : '';
    return dataDir && account ? join(dataDir, 'claude', 'accounts', account, 'config') : null;
  } catch {
    return null;
  }
}
