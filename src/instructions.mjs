import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { HARNESS_IDS, HARNESS_META } from './constants.mjs';
import { composeInstructionContent, extractExternalBlocks, normalizeLineEndings } from './shared.mjs';
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
        externalBlocks: [],
        readError: '',
      };
    }
    return {
      exists: false,
      isSymlink: false,
      symlinkTarget: '',
      brokenSymlink: false,
      rawContent: '',
      externalBlocks: [],
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
    const { blocks } = extractExternalBlocks(rawContent);
    return {
      exists: true,
      isSymlink,
      symlinkTarget,
      brokenSymlink: false,
      rawContent,
      externalBlocks: blocks,
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
        externalBlocks: [],
        readError: '',
      };
    }
    return {
      exists: true,
      isSymlink,
      symlinkTarget,
      brokenSymlink: false,
      rawContent: '',
      externalBlocks: [],
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

  async saveAll({ shared, harnesses }) {
    const current = await this.readAll();
    const nextShared = typeof shared === 'string' ? normalizeLineEndings(shared) : current.shared;
    const nextConfig = normalizeConfig(current.config);
    const nextPrivate = { ...current.privateByHarness };

    if (isPlainObject(harnesses)) {
      for (const harnessId of HARNESS_IDS) {
        const entry = harnesses[harnessId];
        if (!isPlainObject(entry)) continue;
        if (typeof entry.enabled === 'boolean') {
          nextConfig.harnesses[harnessId].enabled = entry.enabled;
        }
        if (typeof entry.privateContent === 'string') {
          nextPrivate[harnessId] = normalizeLineEndings(entry.privateContent);
        }
      }
    }

    await writeFileAtomic(this.sharedFile, nextShared);
    for (const harnessId of HARNESS_IDS) {
      await writeFileAtomic(this.privateFileFor(harnessId), nextPrivate[harnessId]);
    }
    const writtenConfig = await this.writeConfig(nextConfig);
    return {
      config: writtenConfig,
      shared: nextShared,
      privateByHarness: nextPrivate,
    };
  }
}

function resolveHarnessDraft(stored, draft) {
  const shared = typeof draft?.shared === 'string' ? normalizeLineEndings(draft.shared) : stored.shared;
  const harnesses = {};
  for (const harnessId of HARNESS_IDS) {
    const draftEntry = isPlainObject(draft?.harnesses?.[harnessId]) ? draft.harnesses[harnessId] : null;
    harnesses[harnessId] = {
      enabled: typeof draftEntry?.enabled === 'boolean' ? draftEntry.enabled : stored.config.harnesses[harnessId].enabled,
      privateContent: typeof draftEntry?.privateContent === 'string'
        ? normalizeLineEndings(draftEntry.privateContent)
        : stored.privateByHarness[harnessId],
      lastSyncedAt: stored.config.harnesses[harnessId].lastSyncedAt,
    };
  }
  return { shared, harnesses };
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
  const stored = await store.readAll();
  const harnesses = {};
  const summary = {
    enabled: 0,
    synced: 0,
    pending: 0,
    symlink: 0,
  };

  for (const harnessId of HARNESS_IDS) {
    const targetFile = harnessPaths[harnessId].instructionsFile;
    const cfg = stored.config.harnesses[harnessId];
    const privateContent = stored.privateByHarness[harnessId];
    const fileInfo = await inspectTargetInstructionFile(targetFile);
    const hasSourceContent = Boolean(stored.shared.trim() || privateContent.trim());
    const composedContent = hasSourceContent
      ? composeInstructionContent({
          shared: stored.shared,
          privateContent,
          externalBlocks: fileInfo.externalBlocks,
        })
      : '';
    const status = computeStatus({
      enabled: cfg.enabled,
      hasSourceContent,
      fileInfo,
      composedContent,
    });

    if (cfg.enabled) {
      summary.enabled++;
      if (status === 'synced') summary.synced++;
      else if (status === 'symlink') {
        summary.symlink++;
        summary.pending++;
      } else if (status === 'modified' || status === 'missing' || status === 'error') {
        summary.pending++;
      }
    }

    harnesses[harnessId] = {
      id: harnessId,
      label: HARNESS_META[harnessId].label,
      fileName: HARNESS_META[harnessId].instructionsFileName,
      targetFile,
      privateFile: store.privateFileFor(harnessId),
      enabled: cfg.enabled,
      privateContent,
      exists: fileInfo.exists,
      isSymlink: fileInfo.isSymlink,
      symlinkTarget: fileInfo.symlinkTarget,
      brokenSymlink: fileInfo.brokenSymlink,
      externalBlocks: fileInfo.externalBlocks,
      currentLength: fileInfo.rawContent.length,
      composedContent,
      hasSourceContent,
      status,
      lastSyncedAt: cfg.lastSyncedAt,
      readError: fileInfo.readError,
    };
  }

  return {
    dir: store.dir,
    configFile: store.configFile,
    sharedFile: store.sharedFile,
    shared: stored.shared,
    summary,
    harnesses,
  };
}

export async function syncInstructions({ store, harnessPaths, harnesses: requestedHarnesses, dryRun = false, draft = null }) {
  const stored = await store.readAll();
  const effective = resolveHarnessDraft(stored, draft);

  const explicit = Array.isArray(requestedHarnesses) && requestedHarnesses.length > 0
    ? [...new Set(requestedHarnesses.filter(id => HARNESS_IDS.includes(id)))]
    : null;
  const targets = explicit ?? HARNESS_IDS.filter(id => effective.harnesses[id].enabled);

  const steps = [];
  const nextConfig = normalizeConfig(stored.config);
  let configDirty = false;

  if (targets.length === 0) {
    steps.push({
      harness: 'instructions',
      action: 'sync',
      status: 'skipped',
      detail: '没有启用同步的目标 Harness',
    });
    return { steps };
  }

  for (const harnessId of targets) {
    const targetFile = harnessPaths[harnessId].instructionsFile;
    const entry = effective.harnesses[harnessId];
    const warnings = [];

    if (!explicit && !entry.enabled) {
      steps.push({
        harness: harnessId,
        action: 'sync',
        status: 'skipped',
        detail: '该端未启用同步，已跳过',
      });
      continue;
    }

    const hasSourceContent = Boolean(effective.shared.trim() || entry.privateContent.trim());
    if (!hasSourceContent) {
      steps.push({
        harness: harnessId,
        action: 'sync',
        status: 'skipped',
        detail: '公共与私有内容均为空，已跳过写入以防误清空现有文件',
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

    const composedContent = composeInstructionContent({
      shared: effective.shared,
      privateContent: entry.privateContent,
      externalBlocks: fileInfo.externalBlocks,
    });
    const preservedIds = fileInfo.externalBlocks.map(b => b.id);
    const preservedNote = preservedIds.length ? `；保留外部标记块：${preservedIds.join('、')}` : '';

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
        detail: `已是最新，无需写入（${targetFile}）${preservedNote}`,
      });
      continue;
    }

    const lineCount = composedContent ? composedContent.trimEnd().split('\n').length : 0;
    const prevLineCount = fileInfo.rawContent ? fileInfo.rawContent.trimEnd().split('\n').length : 0;
    const actionVerb = fileInfo.isSymlink
      ? '解除软链并写入独立文件'
      : fileInfo.exists
        ? '更新文件'
        : '新建文件';
    const summaryLines = [
      `目标路径：${targetFile}`,
      `内容组成：${[
        effective.shared.trim() ? '公共内容' : '',
        entry.privateContent.trim() ? '该端私有内容' : '',
        preservedIds.length ? `外部块(${preservedIds.join(', ')})` : '',
      ].filter(Boolean).join(' + ')}`,
      `行数变化：${prevLineCount} 行 → ${lineCount} 行（${Buffer.byteLength(composedContent, 'utf8')} 字节）`,
    ];

    if (dryRun) {
      steps.push({
        harness: harnessId,
        action: 'sync',
        status: 'preview',
        detail: `将${actionVerb}（${HARNESS_META[harnessId].instructionsFileName}）${preservedNote}`,
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
        lastSyncedAt: new Date().toISOString(),
        lastSyncedHash: sha256(composedContent),
      };
      configDirty = true;
      steps.push({
        harness: harnessId,
        action: 'sync',
        status: 'ok',
        detail: `已${actionVerb}（${HARNESS_META[harnessId].instructionsFileName}）${preservedNote}`,
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
  const { body, blocks } = extractExternalBlocks(fileInfo.rawContent);
  return {
    harness: harnessId,
    sourceFile: targetFile,
    isSymlink: fileInfo.isSymlink,
    symlinkTarget: fileInfo.symlinkTarget,
    content: body,
    strippedBlocks: blocks.map(b => b.id),
  };
}
