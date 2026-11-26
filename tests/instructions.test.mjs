import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeInstructionContent, extractExternalBlocks } from '../src/shared.mjs';
import { PackageManagerService } from '../src/service.mjs';

delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;

test('extractExternalBlocks 与 composeInstructionContent 能正确提取并保留外部标记块且忽略代码围栏', () => {
  const sample = [
    '# 全局协作规则',
    '',
    '```markdown',
    '<!-- FAKE_START -->',
    '代码块里的示例注释不应被剥离',
    '<!-- FAKE_END -->',
    '```',
    '',
    '<!-- CODEGRAPH_START -->',
    '## CodeGraph',
    'Use codegraph_explore.',
    '<!-- CODEGRAPH_END -->',
    '',
    '<!-- UNCLOSED_START -->',
    '未闭合注释保留在正文',
  ].join('\n');

  const { blocks, body } = extractExternalBlocks(sample);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].id, 'CODEGRAPH');
  assert.match(body, /<!-- FAKE_START -->/);
  assert.match(body, /<!-- UNCLOSED_START -->/);
  assert.doesNotMatch(body, /<!-- CODEGRAPH_START -->/);

  const composed = composeInstructionContent({
    shared: '# 公共规则\n- 中文回复',
    privateContent: '## Codex 私有\n- 优先小步验证',
    externalBlocks: blocks,
  });
  assert.equal(
    composed,
    [
      '# 公共规则',
      '- 中文回复',
      '',
      '## Codex 私有',
      '- 优先小步验证',
      '',
      '<!-- CODEGRAPH_START -->',
      '## CodeGraph',
      'Use codegraph_explore.',
      '<!-- CODEGRAPH_END -->',
      '',
    ].join('\n')
  );

  // 如果用户已手动在公共内容中写入同一标记块，不重复追加
  const deduped = composeInstructionContent({
    shared: '# 公共\n\n<!-- CODEGRAPH_START -->\n手动内容\n<!-- CODEGRAPH_END -->',
    privateContent: '',
    externalBlocks: blocks,
  });
  assert.equal((deduped.match(/<!-- CODEGRAPH_START -->/g) || []).length, 1);

  assert.equal(composeInstructionContent({ shared: '  \n ', privateContent: '' }), '');
});

test('全局指令维护端到端：导入、外部标记块保留、软链原子拆分、Dry-Run 与 Claude 自定义目录', async t => {
  const base = await mkdtemp(join(tmpdir(), 'ap-instructions-'));
  t.after(() => rm(base, { recursive: true, force: true }));

  const homeDir = join(base, 'home');
  const dshHome = join(homeDir, '.dsh');
  const root = join(dshHome, 'dsh-agent-packages');
  const customClaudeDir = join(base, 'custom-claude-config');

  // 预置本机文件：Codex 有正文 + CODEGRAPH 块，DSH 软链指向 Codex
  await mkdir(join(homeDir, '.codex'), { recursive: true });
  await mkdir(dshHome, { recursive: true });
  const codexFile = join(homeDir, '.codex', 'AGENTS.md');
  const dshFile = join(dshHome, 'AGENTS.md');
  const claudeFile = join(customClaudeDir, 'CLAUDE.md');
  const agyFile = join(homeDir, '.gemini', 'AGENTS.md');

  const initialCodex = [
    '# 既有全局规则',
    '',
    '- 始终使用中文',
    '',
    '<!-- CODEGRAPH_START -->',
    '## CodeGraph',
    'CodeGraph block content.',
    '<!-- CODEGRAPH_END -->',
    '',
  ].join('\n');
  await writeFile(codexFile, initialCodex, 'utf8');
  await symlink(codexFile, dshFile);

  const service = new PackageManagerService({
    root,
    homeDir,
    dshHome,
    claudeConfigDir: () => customClaudeDir,
  });
  await service.init();

  // 1. 初始状态检查：路径、软链、外部标记块识别
  const initialState = await service.state();
  assert.equal(initialState.instructions.harnesses.codex.targetFile, codexFile);
  assert.equal(initialState.instructions.harnesses['claude-code'].targetFile, claudeFile);
  assert.equal(initialState.instructions.harnesses.antigravity.targetFile, agyFile);
  assert.equal(initialState.instructions.harnesses.dsh.targetFile, dshFile);
  assert.equal(initialState.instructions.harnesses.dsh.isSymlink, true);
  assert.equal(initialState.instructions.harnesses.dsh.externalBlocks[0].id, 'CODEGRAPH');
  assert.equal(initialState.instructions.harnesses.codex.status, 'empty');

  // 2. 防误清空保护：公共和私有都为空时同步应跳过，不改动现有文件与软链
  const emptySync = await service.action({ type: 'instructions.sync' });
  assert.ok(emptySync.steps.every(s => s.status === 'skipped'));
  assert.equal(await readFile(codexFile, 'utf8'), initialCodex);
  assert.equal((await lstat(dshFile)).isSymbolicLink(), true);

  // 3. 从 Codex 导入到公共内容（只返回内容，自动剥离 CODEGRAPH 块）
  const imported = await service.action({
    type: 'instructions.import',
    harness: 'codex',
    target: 'shared',
  });
  assert.equal(imported.content, '# 既有全局规则\n\n- 始终使用中文');
  assert.deepEqual(imported.strippedBlocks, ['CODEGRAPH']);
  await assert.rejects(
    service.action({ type: 'instructions.import', harness: 'claude-code', target: 'shared' }),
    { status: 404 }
  );

  // 4. Dry-Run 预览未保存草稿：不写任何目标文件，不拆软链
  const draftPayload = {
    shared: `${imported.content}\n- 保持最小改动`,
    harnesses: {
      codex: { enabled: true, privateContent: '## Codex 专属\n- 优先运行 node --test' },
      'claude-code': { enabled: true, privateContent: '## Claude Code 专属\n- 遵循 CLAUDE.md' },
      antigravity: { enabled: false, privateContent: '## Antigravity 专属' },
      dsh: { enabled: true, privateContent: '## DSH 专属\n- 输出简短进度反馈' },
    },
  };
  const preview = await service.action({
    type: 'instructions.sync',
    dryRun: true,
    draft: draftPayload,
  });
  assert.equal(preview.steps.length, 3);
  assert.ok(preview.steps.every(s => s.status === 'preview'));
  assert.ok(preview.steps.find(s => s.harness === 'dsh').warnings.some(w => w.includes('软链')));
  assert.equal(await readFile(codexFile, 'utf8'), initialCodex);
  assert.equal((await lstat(dshFile)).isSymbolicLink(), true);
  await assert.rejects(() => lstat(claudeFile));

  // 5. 保存并同步全部启用端
  const synced = await service.action({
    type: 'instructions.save',
    shared: draftPayload.shared,
    harnesses: draftPayload.harnesses,
    syncNow: true,
    dryRun: false,
  });
  assert.equal(synced.steps.length, 3);
  assert.ok(synced.steps.every(s => s.status === 'ok'));

  // 验证 Codex：公共 + Codex私有 + 自动保留 CODEGRAPH 块
  const codexAfter = await readFile(codexFile, 'utf8');
  assert.match(codexAfter, /# 既有全局规则/);
  assert.match(codexAfter, /## Codex 专属/);
  assert.match(codexAfter, /<!-- CODEGRAPH_START -->/);
  assert.doesNotMatch(codexAfter, /## DSH 专属/);

  // 验证 DSH：已从软链原子拆分为独立普通文件，且含 DSH 私有 + 保留 CODEGRAPH 块，未串写 Codex
  assert.equal((await lstat(dshFile)).isSymbolicLink(), false);
  const dshAfter = await readFile(dshFile, 'utf8');
  assert.match(dshAfter, /# 既有全局规则/);
  assert.match(dshAfter, /## DSH 专属/);
  assert.match(dshAfter, /<!-- CODEGRAPH_START -->/);
  assert.doesNotMatch(dshAfter, /## Codex 专属/);

  // 验证 Claude Code：写入自定义 claudeConfigDir 下的 CLAUDE.md
  const claudeAfter = await readFile(claudeFile, 'utf8');
  assert.match(claudeAfter, /# 既有全局规则/);
  assert.match(claudeAfter, /## Claude Code 专属/);

  // 验证未启用的 Antigravity 未被创建
  await assert.rejects(() => lstat(agyFile));
  assert.equal(synced.state.instructions.harnesses.antigravity.status, 'disabled');
  assert.equal(synced.state.instructions.harnesses.codex.status, 'synced');
  assert.equal(synced.state.instructions.harnesses.dsh.status, 'synced');
  assert.equal(synced.state.instructions.harnesses['claude-code'].status, 'synced');

  // 6. 幂等同步：无改动时全部提示无需写入
  const resync = await service.action({ type: 'instructions.sync' });
  assert.ok(resync.steps.every(s => s.status === 'ok' && s.detail.includes('已是最新')));

  // 7. 损坏 instructions.json 保护：拒绝覆盖并报错
  await writeFile(join(root, 'instructions.json'), '{broken json', 'utf8');
  await assert.rejects(() => service.state(), /读取指令配置失败/);
  assert.equal(await readFile(join(root, 'instructions.json'), 'utf8'), '{broken json');
});
