import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { HARNESS_IDS, HARNESS_META } from './constants.mjs';
import { composeSnippets, normalizeLineEndings } from './shared.mjs';
import { isPlainObject, writeFileAtomic } from './store.mjs';

function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

function defaultHarnessConfig() {
  return {
    enabled: true,
    lastSyncedAt: null,
    lastSyncedHash: '',
  };
}

function normalizeConfig(input) {
  const rawHarnesses = isPlainObject(input?.harnesses) ? input.harnesses : {};
  const harnesses = {};
  for (const harnessId of HARNESS_IDS) {
    const entry = isPlainObject(rawHarnesses[harnessId]) ? rawHarnesses[harnessId] : {};
    harnesses[harnessId] = {
      enabled: typeof entry.enabled === 'boolean' ? entry.enabled : true,
      lastSyncedAt: typeof entry.lastSyncedAt === 'string' && entry.lastSyncedAt ? entry.lastSyncedAt : null,
      lastSyncedHash: typeof entry.lastSyncedHash === 'string' ? entry.lastSyncedHash : '',
    };
  }
  return {
    version: 1,
    updatedAt: typeof input?.updatedAt === 'string' ? input.updatedAt : null,
    harnesses,
  };
}

// 规则片段：{ id, title, content, harnesses }，各端文件 = 该端开启的片段按顺序拼接
export function normalizeSnippets(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).filter(isPlainObject).map((snippet, index) => {
    const baseId = String(snippet.id ?? '').trim().replace(/[^\w.-]/g, '') || `snippet-${index + 1}`;
    let id = baseId;
    for (let n = 2; seen.has(id); n++) id = `${baseId}-${n}`;
    seen.add(id);
    return {
      id,
      title: String(snippet.title ?? '').trim() || `片段 ${index + 1}`,
      content: normalizeLineEndings(String(snippet.content ?? '')),
      harnesses: HARNESS_IDS.filter(h => Array.isArray(snippet.harnesses) && snippet.harnesses.includes(h)),
    };
  });
}

async function readTextIfExists(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

export async function inspectTargetInstructionFile(targetFile) {
  let stat;
  try {
    stat = await lstat(targetFile);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        exists: false,
        isSymlink: false,
        symlinkTarget: '',
        brokenSymlink: false,
        rawContent: '',
        readError: '',
      };
    }
    return {
      exists: false,
      isSymlink: false,
      symlinkTarget: '',
      brokenSymlink: false,
      rawContent: '',
      readError: error.message,
    };
  }

  const isSymlink = stat.isSymbolicLink();
  let symlinkTarget = '';
  if (isSymlink) {
    try {
      const rawLink = await readlink(targetFile);
      symlinkTarget = resolve(dirname(targetFile), rawLink);
    } catch {
      symlinkTarget = '';
    }
  }

  try {
    const rawContent = normalizeLineEndings(await readFile(targetFile, 'utf8'));
    return {
      exists: true,
      isSymlink,
      symlinkTarget,
      brokenSymlink: false,
      rawContent,
      readError: '',
    };
  } catch (error) {
    if (isSymlink && error?.code === 'ENOENT') {
      return {
        exists: false,
        isSymlink: true,
        symlinkTarget,
        brokenSymlink: true,
        rawContent: '',
        readError: '',
      };
    }
    return {
      exists: true,
      isSymlink,
      symlinkTarget,
      brokenSymlink: false,
      rawContent: '',
      readError: error.message,
    };
  }
}

export class InstructionsStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.configFile = join(rootDir, 'instructions.json');
    this.dir = join(rootDir, 'instructions');
    this.sharedFile = join(this.dir, 'shared.md');
    this.privateDir = join(this.dir, 'private');
    this.snippetsFile = join(this.dir, 'snippets.json');
  }

  privateFileFor(harnessId) {
    return join(this.privateDir, `${harnessId}.md`);
  }

  async init() {
    await mkdir(this.privateDir, { recursive: true });
  }

  async readConfig() {
    try {
      const raw = await readFile(this.configFile, 'utf8');
      const data = JSON.parse(raw);
      if (!isPlainObject(data)) {
        throw new Error('instructions.json 格式无效：根节点必须是对象');
      }
      return normalizeConfig(data);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        const harnesses = {};
        for (const id of HARNESS_IDS) harnesses[id] = defaultHarnessConfig();
        return { version: 1, updatedAt: null, harnesses };
      }
      throw new Error(`读取指令配置失败（${this.configFile}）：${error.message}`);
    }
  }

  async writeConfig(config) {
    const normalized = normalizeConfig(config);
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      harnesses: normalized.harnesses,
    };
    await writeFileAtomic(this.configFile, JSON.stringify(payload, null, 2) + '\n');
    return payload;
  }

  async readAll() {
    const [config, shared, ...privates] = await Promise.all([
      this.readConfig(),
      readTextIfExists(this.sharedFile),
      ...HARNESS_IDS.map(id => readTextIfExists(this.privateFileFor(id))),
    ]);
    const privateByHarness = {};
    HARNESS_IDS.forEach((id, idx) => {
      privateByHarness[id] = normalizeLineEndings(privates[idx]);
    });
    return {
      config,
      shared: normalizeLineEndings(shared),
      privateByHarness,
    };
  }

  // 还没有 snippets.json 时由旧的「公共 + 各端私有」迁移：公共内容为全端片段，私有内容为单端片段，
  // 拼接结果与迁移前逐字节一致；旧文件保留不删，首次保存时才写出 snippets.json
  async readSnippets() {
    let raw;
    try {
      raw = await readFile(this.snippetsFile, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const { shared, privateByHarness } = await this.readAll();
      const snippets = [];
      if (shared.trim()) snippets.push({ id: 'shared', title: '公共内容', content: shared, harnesses: [...HARNESS_IDS] });
      for (const harnessId of HARNESS_IDS) {
        if (privateByHarness[harnessId].trim()) {
          snippets.push({
            id: `private-${harnessId}`,
            title: `${HARNESS_META[harnessId].label} 私有`,
            content: privateByHarness[harnessId],
            harnesses: [harnessId],
          });
        }
      }
      return { snippets, migrated: true };
    }
    try {
      const data = JSON.parse(raw);
      if (!isPlainObject(data) || !Array.isArray(data.snippets)) throw new Error('缺少 snippets 数组');
      return { snippets: normalizeSnippets(data.snippets), migrated: false };
    } catch (error) {
      throw new Error(`读取规则片段失败（${this.snippetsFile}）：${error.message}`);
    }
  }

  async writeSnippets(list) {
    const snippets = normalizeSnippets(list);
    await mkdir(this.dir, { recursive: true });
    await writeFileAtomic(this.snippetsFile, JSON.stringify({ version: 2, updatedAt: new Date().toISOString(), snippets }, null, 2) + '\n');
    return snippets;
  }
}

function computeStatus({ enabled, hasSourceContent, fileInfo, composedContent }) {
  if (!enabled) return 'disabled';
  if (!hasSourceContent) return 'empty';
  if (fileInfo.readError) return 'error';
  if (fileInfo.isSymlink) return 'symlink';
  if (!fileInfo.exists) return 'missing';
  if (fileInfo.rawContent === composedContent) return 'synced';
  return 'modified';
}

export async function buildInstructionsState({ store, harnessPaths }) {
  // 先读配置：instructions.json 损坏时直接报错，避免后续写入覆盖它
  const config = await store.readConfig();
  const { snippets, migrated } = await store.readSnippets();
  const harnesses = {};
  const summary = { enabled: HARNESS_IDS.length, synced: 0, pending: 0, symlink: 0 };

  for (const harnessId of HARNESS_IDS) {
    const targetFile = harnessPaths[harnessId].instructionsFile;
    const fileInfo = await inspectTargetInstructionFile(targetFile);
    const composedContent = composeSnippets(snippets, harnessId);
    const hasSourceContent = Boolean(composedContent);
    const status = computeStatus({ enabled: true, hasSourceContent, fileInfo, composedContent });
    if (status === 'synced') summary.synced++;
    else if (status === 'symlink') {
      summary.symlink++;
      summary.pending++;
    } else if (status === 'modified' || status === 'missing' || status === 'error') {
      summary.pending++;
    }
    harnesses[harnessId] = {
      id: harnessId,
      label: HARNESS_META[harnessId].label,
      fileName: HARNESS_META[harnessId].instructionsFileName,
      targetFile,
      exists: fileInfo.exists,
      isSymlink: fileInfo.isSymlink,
      symlinkTarget: fileInfo.symlinkTarget,
      brokenSymlink: fileInfo.brokenSymlink,
      currentLength: fileInfo.rawContent.length,
      composedContent,
      hasSourceContent,
      status,
      lastSyncedAt: config.harnesses[harnessId].lastSyncedAt,
      readError: fileInfo.readError,
    };
  }

  return {
    dir: store.dir,
    snippetsFile: store.snippetsFile,
    migrated,
    snippets,
    summary,
    harnesses,
  };
}

export async function syncInstructions({ store, harnessPaths, harnesses: requestedHarnesses, dryRun = false, snippets = null }) {
  const config = await store.readConfig();
  const list = snippets ? normalizeSnippets(snippets) : (await store.readSnippets()).snippets;
  const targets = Array.isArray(requestedHarnesses) && requestedHarnesses.length > 0
    ? [...new Set(requestedHarnesses.filter(id => HARNESS_IDS.includes(id)))]
    : [...HARNESS_IDS];

  const steps = [];
  const nextConfig = normalizeConfig(config);
  let configDirty = false;

  for (const harnessId of targets) {
    const targetFile = harnessPaths[harnessId].instructionsFile;
    const warnings = [];
    const composedContent = composeSnippets(list, harnessId);
    if (!composedContent) {
      steps.push({
        harness: harnessId,
        action: 'sync',
        status: 'skipped',
        detail: '该端没有开启的规则片段，已跳过写入以防误清空现有文件',
      });
      continue;
    }

    const fileInfo = await inspectTargetInstructionFile(targetFile);
    if (fileInfo.readError) {
      steps.push({
        harness: harnessId,
        action: 'sync',
        status: 'error',
        detail: `读取目标文件失败（${targetFile}）：${fileInfo.readError}`,
      });
      continue;
    }

    if (fileInfo.isSymlink) {
      warnings.push(
        fileInfo.brokenSymlink
          ? `原路径为失效软链（指向 ${fileInfo.symlinkTarget || '未知目标'}），同步后替换为独立文件`
          : `原路径为软链（指向 ${fileInfo.symlinkTarget}），同步后拆分为独立文件，不会修改原链接目标`
      );
    }

    if (!fileInfo.isSymlink && fileInfo.exists && fileInfo.rawContent === composedContent) {
      steps.push({
        harness: harnessId,
        action: 'sync',
        status: dryRun ? 'preview' : 'ok',
        detail: `已是最新，无需写入（${targetFile}）`,
      });
      continue;
    }

    const lineCount = composedContent.trimEnd().split('\n').length;
    const prevLineCount = fileInfo.rawContent ? fileInfo.rawContent.trimEnd().split('\n').length : 0;
    const actionVerb = fileInfo.isSymlink ? '解除软链并写入独立文件' : fileInfo.exists ? '更新文件' : '新建文件';
    const parts = list.filter(item => item.harnesses.includes(harnessId) && item.content.trim()).map(item => item.title);
    const summaryLines = [
      `目标路径：${targetFile}`,
      `内容组成：${parts.join(' + ')}`,
      `行数变化：${prevLineCount} 行 → ${lineCount} 行（${Buffer.byteLength(composedContent, 'utf8')} 字节）`,
    ];

    if (dryRun) {
      steps.push({
        harness: harnessId,
        action: 'sync',
        status: 'preview',
        detail: `将${actionVerb}（${HARNESS_META[harnessId].instructionsFileName}）`,
        output: summaryLines.join('\n'),
        warnings,
      });
      continue;
    }

    try {
      // POSIX rename 会原子地用临时普通文件替换软链本身，不会穿透覆盖软链所指向的原文件
      await writeFileAtomic(targetFile, composedContent);
      nextConfig.harnesses[harnessId] = {
        ...nextConfig.harnesses[harnessId],
        enabled: true,
        lastSyncedAt: new Date().toISOString(),
        lastSyncedHash: sha256(composedContent),
      };
      configDirty = true;
      steps.push({
        harness: harnessId,
        action: 'sync',
        status: 'ok',
        detail: `已${actionVerb}（${HARNESS_META[harnessId].instructionsFileName}）`,
        output: summaryLines.join('\n'),
        warnings,
      });
    } catch (error) {
      steps.push({
        harness: harnessId,
        action: 'sync',
        status: 'error',
        detail: `写入失败（${targetFile}）：${error.message}`,
        warnings,
      });
    }
  }

  if (!dryRun && configDirty) {
    await store.writeConfig(nextConfig);
  }

  return { steps };
}

export async function importInstructionFromHarness({ harnessId, harnessPaths }) {
  if (!HARNESS_IDS.includes(harnessId)) {
    throw new Error(`不支持的 Harness：${harnessId}`);
  }
  const targetFile = harnessPaths[harnessId].instructionsFile;
  const fileInfo = await inspectTargetInstructionFile(targetFile);
  if (fileInfo.readError) {
    throw new Error(`读取文件失败（${targetFile}）：${fileInfo.readError}`);
  }
  if (fileInfo.brokenSymlink) {
    throw new Error(`目标文件为失效软链（${targetFile} → ${fileInfo.symlinkTarget || '未知'}），无法导入`);
  }
  if (!fileInfo.exists) {
    throw new Error(`目标文件不存在：${targetFile}`);
  }
  return {
    harness: harnessId,
    sourceFile: targetFile,
    isSymlink: fileInfo.isSymlink,
    symlinkTarget: fileInfo.symlinkTarget,
    content: fileInfo.rawContent,
  };
}
