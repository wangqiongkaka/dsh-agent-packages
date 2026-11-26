import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HARNESS_IDS, PACKAGE_KINDS } from './constants.mjs';

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function writeFileAtomic(filePath, content, mode) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(tempPath, content, { encoding: 'utf8', ...(mode ? { mode } : {}) });
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

export function normalizeRepoUrl(raw) {
  const input = String(raw ?? '').trim();
  if (!input) return '';
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(input)) {
    return `https://github.com/${input.replace(/\.git$/, '')}`;
  }
  const sshMatch = /^git@github\.com:([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?$/.exec(input);
  if (sshMatch) return `https://github.com/${sshMatch[1]}`;
  try {
    const parsed = new URL(input);
    if (parsed.hostname === 'github.com' || parsed.hostname === 'www.github.com') {
      const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
      if (parts.length >= 2) {
        return `https://github.com/${parts[0]}/${parts[1].replace(/\.git$/, '')}`;
      }
    }
    return input.replace(/\/+$/, '');
  } catch {
    return input;
  }
}

export function parseGitHubSlug(repoUrl) {
  const normalized = normalizeRepoUrl(repoUrl);
  const match = /^https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/.exec(normalized);
  if (!match) return null;
  return { owner: match[1], repo: match[2], slug: `${match[1]}/${match[2]}`, url: normalized };
}

export function slugifyId(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function normalizePackage(input, existing) {
  if (!isPlainObject(input)) throw new Error('包定义必须是对象');
  const repo = normalizeRepoUrl(input.repo ?? existing?.repo ?? '');
  const gh = parseGitHubSlug(repo);
  // 包 ID 留空时按名称生成（名称无法转成 ID 时用仓库名），重命名即可避开冲突
  const rawId = input.id || existing?.id || slugifyId(input.name) || gh?.repo || '';
  const id = slugifyId(rawId);
  if (!id || !/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    throw new Error('包 ID 仅允许小写字母、数字、点、下划线和短横线，且以字母或数字开头');
  }
  const kind = input.kind ?? existing?.kind ?? 'skills-repo';
  if (!PACKAGE_KINDS.includes(kind)) {
    throw new Error(`不支持的包类型：${kind}`);
  }
  const targetsRaw = Array.isArray(input.targets) ? input.targets : (existing?.targets ?? ['codex', 'claude-code', 'antigravity']);
  const targets = [...new Set(targetsRaw.filter(item => HARNESS_IDS.includes(item)))];

  const commandsInput = isPlainObject(input.commands) ? input.commands : (existing?.commands ?? {});
  const commands = {};
  if (isPlainObject(commandsInput.shared)) {
    const shared = commandsInput.shared;
    const install = typeof shared.install === 'string' ? shared.install.trim() : '';
    const upgrade = typeof shared.upgrade === 'string' ? shared.upgrade.trim() : '';
    const uninstall = typeof shared.uninstall === 'string' ? shared.uninstall.trim() : '';
    const version = typeof shared.version === 'string' ? shared.version.trim() : '';
    if (install || upgrade || uninstall || version) {
      commands.shared = {
        ...(install ? { install } : {}),
        ...(upgrade ? { upgrade } : {}),
        ...(uninstall ? { uninstall } : {}),
        ...(version ? { version } : {}),
      };
    }
  }
  for (const harnessId of HARNESS_IDS) {
    const entry = commandsInput[harnessId];
    if (!isPlainObject(entry)) continue;
    const install = typeof entry.install === 'string' ? entry.install.trim() : '';
    const upgrade = typeof entry.upgrade === 'string' ? entry.upgrade.trim() : '';
    const uninstall = typeof entry.uninstall === 'string' ? entry.uninstall.trim() : '';
    if (install || upgrade || uninstall) {
      commands[harnessId] = {
        ...(install ? { install } : {}),
        ...(upgrade ? { upgrade } : {}),
        ...(uninstall ? { uninstall } : {}),
      };
    }
  }

  const skillsInput = isPlainObject(input.skills) ? input.skills : (existing?.skills ?? {});
  const includeSkills = Array.isArray(skillsInput.include)
    ? [...new Set(skillsInput.include.map(s => String(s).trim()).filter(Boolean))]
    : [];
  const skillsMode = skillsInput.mode === 'copy' ? 'copy' : 'symlink';

  const mcpInput = isPlainObject(input.mcp) ? input.mcp : (existing?.mcp ?? {});
  const transport = mcpInput.transport === 'http' ? 'http' : 'stdio';
  const serverName = slugifyId(mcpInput.serverName || id) || id;
  const args = Array.isArray(mcpInput.args)
    ? mcpInput.args.map(item => String(item))
    : typeof mcpInput.args === 'string'
      ? mcpInput.args.split(/\s+/).filter(Boolean)
      : [];
  const envRefs = Array.isArray(mcpInput.envRefs)
    ? [...new Set(mcpInput.envRefs.map(item => String(item).trim()).filter(Boolean))]
    : [];
  const headers = {};
  if (isPlainObject(mcpInput.headers)) {
    for (const [k, v] of Object.entries(mcpInput.headers)) {
      if (typeof v === 'string' && k.trim()) headers[k.trim()] = v;
    }
  }
  const overrides = {};
  if (isPlainObject(mcpInput.overrides)) {
    for (const harnessId of HARNESS_IDS) {
      if (isPlainObject(mcpInput.overrides[harnessId])) {
        overrides[harnessId] = mcpInput.overrides[harnessId];
      }
    }
  }

  const pluginInput = isPlainObject(input.plugin) ? input.plugin : (existing?.plugin ?? {});
  const pluginName = slugifyId(pluginInput.name || id) || id;
  const pluginMarketplace = slugifyId(pluginInput.marketplace || pluginName) || pluginName;
  // 插件清单声明可装的 Harness（解析仓库得到）；旧条目没有该字段时为空，不做限制
  const pluginHarnesses = Array.isArray(pluginInput.harnesses)
    ? HARNESS_IDS.filter(h => pluginInput.harnesses.includes(h))
    : [];

  const now = new Date().toISOString();
  return {
    id,
    name: String(input.name ?? existing?.name ?? gh?.repo ?? id).trim() || id,
    kind,
    repo,
    description: String(input.description ?? existing?.description ?? '').trim(),
    ref: String(input.ref ?? existing?.ref ?? '').trim(),
    version: String(input.version ?? existing?.version ?? '').trim(),
    npmPackage: String(input.npmPackage ?? existing?.npmPackage ?? '').trim(),
    targets,
    skills: {
      include: includeSkills,
      mode: skillsMode,
    },
    mcp: {
      serverName,
      transport,
      command: String(mcpInput.command ?? '').trim(),
      args,
      url: String(mcpInput.url ?? '').trim(),
      envRefs,
      headers,
      overrides,
    },
    plugin: {
      name: pluginName,
      marketplace: pluginMarketplace,
      harnesses: pluginHarnesses,
    },
    commands,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export class PackageStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.manifestFile = join(rootDir, 'packages.json');
    this.lockFile = join(rootDir, 'packages.lock.json');
    this.reposDir = join(rootDir, 'repos');
  }

  async init() {
    await mkdir(this.rootDir, { recursive: true });
    await mkdir(this.reposDir, { recursive: true });
  }

  async readManifest() {
    try {
      const raw = await readFile(this.manifestFile, 'utf8');
      const data = JSON.parse(raw);
      if (!isPlainObject(data) || !Array.isArray(data.packages)) {
        throw new Error('packages.json 格式无效：缺少 packages 数组');
      }
      return {
        version: 1,
        packages: data.packages.map(pkg => normalizePackage(pkg, pkg)),
      };
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { version: 1, packages: [] };
      }
      throw new Error(`读取包清单失败（${this.manifestFile}）：${error.message}`);
    }
  }

  async writeManifest(manifest) {
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      packages: manifest.packages,
    };
    await writeFileAtomic(this.manifestFile, JSON.stringify(payload, null, 2) + '\n');
    return payload;
  }

  async readLock() {
    try {
      const raw = await readFile(this.lockFile, 'utf8');
      const data = JSON.parse(raw);
      if (!isPlainObject(data) || !isPlainObject(data.packages)) {
        throw new Error('packages.lock.json 格式无效');
      }
      return { version: 1, updatedAt: data.updatedAt ?? null, packages: data.packages };
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { version: 1, updatedAt: null, packages: {} };
      }
      throw new Error(`读取锁文件失败（${this.lockFile}）：${error.message}`);
    }
  }

  async writeLock(lock) {
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      packages: lock.packages ?? {},
    };
    await writeFileAtomic(this.lockFile, JSON.stringify(payload, null, 2) + '\n');
    return payload;
  }
}
