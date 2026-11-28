import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeInstructionContent, composeSnippets } from '../src/shared.mjs';
import { InstructionsStore } from '../src/instructions.mjs';
import { PackageManagerService } from '../src/service.mjs';

delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;

const HARNESSES = ['codex', 'claude-code', 'antigravity', 'dsh'];

test('composeInstructionContent 只拼接公共与私有内容，标记块按普通文本原样保留', () => {
  const shared = '# 公共规则\n- 中文回复\n\n<!-- CODEGRAPH_START -->\n## CodeGraph\n<!-- CODEGRAPH_END -->';
  assert.equal(
    composeInstructionContent({ shared, privateContent: '\n## Codex 私有\n- 优先小步验证\n\n' }),
    `${shared}\n\n## Codex 私有\n- 优先小步验证\n`
  );
  assert.equal(composeInstructionContent({ shared: '# 仅公共', privateContent: '' }), '# 仅公共\n');
  assert.equal(composeInstructionContent({ shared: '  \n ', privateContent: '' }), '');
});

test('旧「公共 + 私有」迁移为规则片段：各端拼接结果逐字节不变（仅公共 / 仅私有 / 全空 / 历史停用端）', async t => {
  const cases = [
    { name: '公共 + 私有', shared: '\n# 公共\n- a\n\n', privates: { codex: '## Codex\n- b\n', dsh: '\n\n## DSH\n' } },
    { name: '仅公共', shared: '# 只有公共\r\n- 换行风格\r\n', privates: {} },
    { name: '仅私有', shared: '   \n', privates: { 'claude-code': '## 只给 Claude\n' } },
    { name: '全空', shared: '', privates: {} },
    { name: '历史停用端', shared: '# 公共\n', privates: { antigravity: '## Agy\n' }, disabled: ['antigravity'] },
  ];
  for (const item of cases) {
    const root = await mkdtemp(join(tmpdir(), 'ap-migrate-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new InstructionsStore(root);
    await store.init();
    await writeFile(store.sharedFile, item.shared);
    for (const [h, content] of Object.entries(item.privates)) await writeFile(store.privateFileFor(h), content);
    if (item.disabled) {
      await writeFile(store.configFile, JSON.stringify({ harnesses: Object.fromEntries(item.disabled.map(h => [h, { enabled: false }])) }));
    }
    const legacy = await store.readAll();
    const { snippets, migrated } = await store.readSnippets();
    assert.equal(migrated, true, item.name);
    for (const h of HARNESSES) {
      assert.equal(
        composeSnippets(snippets, h),
        composeInstructionContent({ shared: legacy.shared, privateContent: legacy.privateByHarness[h] }),
        `${item.name}：${h} 拼接结果应与迁移前一致`,
      );
    }
    // 写出后再读，结果不变；旧文件保留
    await store.writeSnippets(snippets);
    const reread = await store.readSnippets();
    assert.equal(reread.migrated, false);
    for (const h of HARNESSES) assert.equal(composeSnippets(reread.snippets, h), composeSnippets(snippets, h));
    assert.equal(await readFile(store.sharedFile, 'utf8'), item.shared);
  }
});

test('规则片段端到端：只写变化的端、软链原子拆分、空端不清空、原样导入与损坏配置保护', async t => {
  const base = await mkdtemp(join(tmpdir(), 'ap-rules-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const homeDir = join(base, 'home');
  const dshHome = join(homeDir, '.dsh');
  const root = join(dshHome, 'dsh-agent-packages');
  const customClaudeDir = join(base, 'custom-claude-config');

  await mkdir(join(homeDir, '.codex'), { recursive: true });
  await mkdir(dshHome, { recursive: true });
  const codexFile = join(homeDir, '.codex', 'AGENTS.md');
  const dshFile = join(dshHome, 'AGENTS.md');
  const claudeFile = join(customClaudeDir, 'CLAUDE.md');
  const agyFile = join(homeDir, '.gemini', 'AGENTS.md');
  const initialCodex = '# 既有全局规则\n\n- 始终使用中文\n\n<!-- CODEGRAPH_START -->\n## CodeGraph\n<!-- CODEGRAPH_END -->\n';
  await writeFile(codexFile, initialCodex, 'utf8');
  await symlink(codexFile, dshFile);

  const service = new PackageManagerService({ root, homeDir, dshHome, claudeConfigDir: () => customClaudeDir });
  await service.init();

  const initial = await service.state();
  assert.equal(initial.instructions.harnesses['claude-code'].targetFile, claudeFile);
  assert.equal(initial.instructions.harnesses.dsh.isSymlink, true);
  assert.equal(initial.instructions.harnesses.codex.status, 'empty');
  assert.deepEqual(initial.instructions.snippets, []);

  // 没有任何片段时同步全部跳过，不改动现有文件与软链
  const emptySync = await service.action({ type: 'rules.sync' });
  assert.ok(emptySync.steps.every(s => s.status === 'skipped'));
  assert.equal(await readFile(codexFile, 'utf8'), initialCodex);

  // 原样导入 Codex 文件（含 CODEGRAPH 块）；不存在的端报 404
  const imported = await service.action({ type: 'rules.import', harness: 'codex' });
  assert.equal(imported.content, initialCodex);
  await assert.rejects(service.action({ type: 'rules.import', harness: 'claude-code' }), { status: 404 });

  // 保存三条片段：公共（Codex / Claude / DSH）、Codex 专属、DSH 专属；Antigravity 没有片段
  const snippets = [
    { id: 'common', title: '公共', content: '# 公共规则\n- 保持最小改动', harnesses: ['codex', 'claude-code', 'dsh'] },
    { id: 'codex-only', title: 'Codex 专属', content: '## Codex\n- node --test', harnesses: ['codex'] },
    { id: 'dsh-only', title: 'DSH 专属', content: '## DSH\n- 简短进度', harnesses: ['dsh'] },
  ];
  const saved = await service.action({ type: 'rules.save', snippets });
  assert.deepEqual(saved.steps.map(s => s.harness).sort(), ['claude-code', 'codex', 'dsh']);
  assert.ok(saved.steps.every(s => s.status === 'ok'));
  assert.equal(saved.ok, true);
  assert.equal(await readFile(codexFile, 'utf8'), '# 公共规则\n- 保持最小改动\n\n## Codex\n- node --test\n');
  assert.equal((await lstat(dshFile)).isSymbolicLink(), false, 'DSH 软链拆分为独立文件');
  assert.doesNotMatch(await readFile(dshFile, 'utf8'), /Codex/);
  assert.match(await readFile(claudeFile, 'utf8'), /# 公共规则/);
  await assert.rejects(() => lstat(agyFile), 'Antigravity 没有片段，不创建文件');
  assert.equal(saved.state.instructions.harnesses.codex.status, 'synced');
  assert.equal(saved.state.instructions.harnesses.antigravity.status, 'empty');

  // 外部修改 Claude 文件后，只改 DSH 专属片段：只写 DSH，Claude 保持「待同步」不被覆盖
  await writeFile(claudeFile, '外部工具写入的内容\n');
  const edited = await service.action({
    type: 'rules.save',
    snippets: snippets.map(s => (s.id === 'dsh-only' ? { ...s, content: '## DSH\n- 更短的进度' } : s)),
  });
  assert.deepEqual(edited.steps.map(s => s.harness), ['dsh']);
  assert.equal(await readFile(claudeFile, 'utf8'), '外部工具写入的内容\n');
  assert.equal(edited.state.instructions.harnesses['claude-code'].status, 'modified');

  // 某端写入失败：片段已保存（saved），整体 ok=false；恢复后只重试该端
  const codexDir = join(homeDir, '.codex');
  await chmod(codexDir, 0o555);
  let failedSave;
  try {
    failedSave = await service.action({
      type: 'rules.save',
      snippets: edited.state.instructions.snippets.map(s => (s.id === 'codex-only' ? { ...s, content: '## Codex\n- node --test --watch' } : s)),
    });
  } finally {
    await chmod(codexDir, 0o755);
  }
  assert.equal(failedSave.ok, false);
  assert.equal(failedSave.saved, true);
  assert.match(failedSave.message, /1 端写入失败/);
  assert.deepEqual(failedSave.steps.map(s => [s.harness, s.status]), [['codex', 'error']]);
  assert.match(failedSave.state.instructions.snippets.find(s => s.id === 'codex-only').content, /--watch/);
  const retried = await service.action({ type: 'rules.sync', harnesses: ['codex'] });
  assert.equal(retried.ok, true);
  assert.match(await readFile(codexFile, 'utf8'), /--watch/);

  // 关掉 Codex 的全部片段：Codex 文件保持原样
  const before = await readFile(codexFile, 'utf8');
  await service.action({
    type: 'rules.save',
    snippets: snippets.map(s => ({ ...s, harnesses: s.harnesses.filter(h => h !== 'codex') })),
  });
  assert.equal(await readFile(codexFile, 'utf8'), before);

  // 损坏 instructions.json 保护：拒绝覆盖并报错
  await writeFile(join(root, 'instructions.json'), '{broken json', 'utf8');
  await assert.rejects(() => service.state(), /读取指令配置失败/);
  assert.equal(await readFile(join(root, 'instructions.json'), 'utf8'), '{broken json');
});
