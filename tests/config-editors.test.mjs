import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readCodexMcpServers,
  readJsonMcpServers,
  removeCodexMcpServer,
  removeJsonMcpServer,
  renderMcpConfigForHarness,
  upsertCodexMcpServer,
  upsertJsonMcpServer,
} from '../src/config-editors.mjs';

test('JSON MCP 局部合并保留宿主其他字段并支持 dryRun 和安全移除', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ap-json-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const claudeFile = join(dir, '.claude.json');
  await writeFile(claudeFile, JSON.stringify({
    skillUsage: { tdd: 5 },
    mcpServers: {
      existing: { type: 'stdio', command: 'node', args: ['keep.js'] },
    },
  }, null, 2));

  const preview = await upsertJsonMcpServer(claudeFile, 'playwright', {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@0.0.28'],
  }, { dryRun: true });
  assert.equal(preview.action, 'add');
  assert.equal(preview.changed, true);
  assert.equal((await readJsonMcpServers(claudeFile)).playwright, undefined);

  const added = await upsertJsonMcpServer(claudeFile, 'playwright', {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@0.0.28'],
  });
  assert.equal(added.action, 'add');

  const rawAfterAdd = JSON.parse(await readFile(claudeFile, 'utf8'));
  assert.deepEqual(rawAfterAdd.skillUsage, { tdd: 5 });
  assert.deepEqual(rawAfterAdd.mcpServers.existing, { type: 'stdio', command: 'node', args: ['keep.js'] });
  assert.deepEqual(rawAfterAdd.mcpServers.playwright.args, ['-y', '@playwright/mcp@0.0.28']);

  const removed = await removeJsonMcpServer(claudeFile, 'playwright');
  assert.equal(removed.action, 'remove');
  const rawAfterRemove = JSON.parse(await readFile(claudeFile, 'utf8'));
  assert.equal(rawAfterRemove.mcpServers.playwright, undefined);
  assert.ok(rawAfterRemove.mcpServers.existing);
  assert.deepEqual(rawAfterRemove.skillUsage, { tdd: 5 });
});

test('损坏的 JSON 文件拒绝写入且不破坏原内容', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ap-json-bad-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const badFile = join(dir, 'mcp_config.json');
  await writeFile(badFile, '{ invalid json');
  await assert.rejects(
    () => upsertJsonMcpServer(badFile, 'foo', { command: 'node', args: [] }),
    /解析 JSON 配置失败/
  );
  assert.equal(await readFile(badFile, 'utf8'), '{ invalid json');
});

test('Codex TOML 局部编辑保留注释、其他 MCP 和 projects 区块', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ap-toml-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tomlFile = join(dir, 'config.toml');
  const original = [
    '# 顶层注释必须保留',
    'model = "gpt-5"',
    '',
    '[mcp_servers.codegraph]',
    'command = "codegraph"',
    'args = ["serve"]',
    '',
    '[projects."/Users/demo/repo"]',
    'trust_level = "trusted"',
    '',
  ].join('\n');
  await writeFile(tomlFile, original);

  const dry = await upsertCodexMcpServer(tomlFile, 'playwright', {
    command: 'npx',
    args: ['-y', '@playwright/mcp@0.0.28'],
    env_vars: ['HTTPS_PROXY'],
  }, { dryRun: true });
  assert.equal(dry.action, 'add');
  assert.equal(await readFile(tomlFile, 'utf8'), original);

  await upsertCodexMcpServer(tomlFile, 'playwright', {
    command: 'npx',
    args: ['-y', '@playwright/mcp@0.0.28'],
    env_vars: ['HTTPS_PROXY'],
    env: { NODE_ENV: 'production' },
  });

  const afterAdd = await readFile(tomlFile, 'utf8');
  assert.match(afterAdd, /# 顶层注释必须保留/);
  assert.match(afterAdd, /\[mcp_servers\.codegraph\]/);
  assert.match(afterAdd, /\[projects\."\/Users\/demo\/repo"\]/);
  assert.match(afterAdd, /\[mcp_servers\.playwright\.env\]/);

  const parsed = await readCodexMcpServers(tomlFile);
  assert.equal(parsed.codegraph.command, 'codegraph');
  assert.deepEqual(parsed.playwright.args, ['-y', '@playwright/mcp@0.0.28']);
  assert.equal(parsed.playwright.env.NODE_ENV, 'production');

  // 更新原位替换且不残留子表
  const updated = await upsertCodexMcpServer(tomlFile, 'playwright', {
    command: 'npx',
    args: ['-y', '@playwright/mcp@0.0.29'],
  });
  assert.equal(updated.action, 'update');
  const afterUpdate = await readFile(tomlFile, 'utf8');
  assert.doesNotMatch(afterUpdate, /\[mcp_servers\.playwright\.env\]/);
  assert.match(afterUpdate, /@playwright\/mcp@0\.0\.29/);
  assert.match(afterUpdate, /\[projects\."\/Users\/demo\/repo"\]/);

  // 移除仅删目标区块
  const removed = await removeCodexMcpServer(tomlFile, 'playwright');
  assert.equal(removed.action, 'remove');
  const afterRemove = await readFile(tomlFile, 'utf8');
  assert.doesNotMatch(afterRemove, /mcp_servers\.playwright/);
  assert.match(afterRemove, /# 顶层注释必须保留/);
  assert.match(afterRemove, /\[mcp_servers\.codegraph\]/);
  assert.match(afterRemove, /\[projects\."\/Users\/demo\/repo"\]/);
});

test('renderMcpConfigForHarness 按不同 Harness 渲染并提示 Antigravity SSE 限制', () => {
  const stdioSpec = {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@{{version}}'],
    envRefs: ['API_TOKEN'],
  };
  const codex = renderMcpConfigForHarness('codex', stdioSpec, { version: '1.2.3' });
  assert.deepEqual(codex.config, {
    command: 'npx',
    args: ['-y', '@playwright/mcp@1.2.3'],
    env_vars: ['API_TOKEN'],
  });

  const claude = renderMcpConfigForHarness('claude-code', stdioSpec, { version: '1.2.3' });
  assert.deepEqual(claude.config, {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@1.2.3'],
    env: { API_TOKEN: '${API_TOKEN}' },
  });

  const agySse = renderMcpConfigForHarness('antigravity', {
    transport: 'http',
    url: 'https://example.com/sse',
  });
  assert.equal(agySse.warnings.length, 1);
  assert.match(agySse.warnings[0], /Streamable HTTP/);
});
