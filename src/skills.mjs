import { cp, lstat, mkdir, readdir, readlink, realpath, rename, rm, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { HARNESS_IDS, HARNESS_META } from './shared.mjs';

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@+-]*$/;

async function scanSkillsDir(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const items = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    const isSymlink = entry.isSymbolicLink();
    if (!isSymlink && !entry.isDirectory()) continue;
    let real = null;
    try { real = await realpath(path); } catch { real = null; }
    items.push({
      name: entry.name,
      path,
      isSymlink,
      linkTarget: isSymlink ? await readlink(path).catch(() => '') : '',
      real,
      broken: isSymlink && !real,
    });
  }
  return items;
}

// 行 = 4 端 Skills 目录里出现过的名称；consistent 表示各端指向同一份内容（真实路径相同）
export async function listSkills(harnessPaths) {
  const rows = new Map();
  const errors = {};
  for (const harnessId of HARNESS_IDS) {
    let items = [];
    try { items = await scanSkillsDir(harnessPaths[harnessId].skillsDir); } catch (error) {
      errors[harnessId] = error.message;
    }
    for (const item of items) {
      if (!rows.has(item.name)) rows.set(item.name, { name: item.name, harnesses: {} });
      rows.get(item.name).harnesses[harnessId] = item;
    }
  }
  const list = [...rows.values()].map(row => {
    const present = Object.values(row.harnesses).filter(item => !item.broken);
    const reals = new Set(present.map(item => item.real));
    return {
      ...row,
      consistent: reals.size <= 1,
      complete: HARNESS_IDS.every(h => row.harnesses[h] && !row.harnesses[h].broken),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { rows: list, errors };
}

async function moveToTrash(path, trashDir, harnessId, name) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(trashDir, stamp, harnessId, name);
  await mkdir(dirname(target), { recursive: true });
  try {
    await rename(path, target);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    await cp(path, target, { recursive: true, verbatimSymlinks: true });
    await rm(path, { recursive: true, force: true });
  }
  return target;
}

// 开启：在该端建软链指向已有内容（优先实体目录）；关闭：软链直接删，实体目录移入回收目录。
// 返回 { detail }；不能执行时抛错并写明原因。
export async function toggleSkill({ harnessPaths, name, harness, on, trashDir }) {
  if (!SKILL_NAME_RE.test(String(name ?? ''))) throw new Error(`Skill 名称不合法：${name}`);
  if (!HARNESS_IDS.includes(harness)) throw new Error(`不支持的 Harness：${harness}`);
  const label = HARNESS_META[harness].label;
  const { rows } = await listSkills(harnessPaths);
  const row = rows.find(item => item.name === name);
  if (!row) throw new Error(`本机没有名为「${name}」的 Skill`);
  const entry = row.harnesses[harness];
  const dest = join(harnessPaths[harness].skillsDir, name);

  if (on) {
    if (entry && !entry.broken) return { detail: `${label} 已有「${name}」，无需操作` };
    const candidates = Object.values(row.harnesses).filter(item => !item.broken);
    const source = candidates.find(item => !item.isSymlink)?.real || candidates[0]?.real;
    if (!source) throw new Error(`「${name}」在各端都是失效软链，没有可用的源目录`);
    if (entry?.broken) await rm(dest, { force: true });
    await mkdir(harnessPaths[harness].skillsDir, { recursive: true });
    await symlink(source, dest, 'dir');
    return { detail: `已在 ${label} 建立软链 ${dest} → ${source}` };
  }

  if (!entry) return { detail: `${label} 没有「${name}」，无需操作` };
  if (entry.isSymlink) {
    await rm(dest, { force: true });
    return { detail: `已删除 ${label} 的软链 ${dest}` };
  }
  const self = resolve(entry.real || dest);
  const dependents = HARNESS_IDS.filter(h => h !== harness && row.harnesses[h]?.isSymlink && row.harnesses[h].real === self);
  if (dependents.length) {
    throw new Error(`${dependents.map(h => HARNESS_META[h].label).join('、')} 的软链指向这个目录，先关闭这些端再关闭 ${label}`);
  }
  const moved = await moveToTrash(dest, trashDir, harness, name);
  return { detail: `已把 ${label} 的「${name}」移入回收目录 ${moved}` };
}
