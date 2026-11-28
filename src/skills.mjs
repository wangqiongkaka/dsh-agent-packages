import { readdir, readlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { HARNESS_IDS } from './shared.mjs';

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
