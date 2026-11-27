import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PackageManagerService } from '../src/service.mjs';
import { readCodexMcpServers, readJsonMcpServers } from '../src/config-editors.mjs';

const execFileAsync = promisify(execFile);
// 测试只用临时目录，避免经环境变量读到本机真实的 Claude / Codex 配置
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;

async function setup(t, prefix) {
  const base = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(base, { recursive: true, force: true }));
  const homeDir = join(base, 'home');
  const dshHome = join(homeDir, '.dsh');
  const service = new PackageManagerService({ root: join(dshHome, 'dsh-agent-packages'), homeDir, dshHome, githubToken: '' });
  await service.init();
  return { base, homeDir, dshHome, service };
}

async function createSkillsRepo(baseDir) {
  const repoDir = join(baseDir, 'upstream');
  for (const name of ['alpha', 'beta']) {
    await mkdir(join(repoDir, 'skills', name), { recursive: true });
    await writeFile(join(repoDir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  }
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: repoDir });
  await execFileAsync('git', ['add', '.'], { cwd: repoDir });
  await execFileAsync('git', ['commit', '-m', 'v1'], { cwd: repoDir });
  return repoDir;
}

const exists = async p => { try { await lstat(p); return true; } catch { return false; } };

test('端开关：MCP 单端写入与移除，只有成功才翻转，不支持的端被拒绝', async t => {
  const { homeDir, service } = await setup(t, 'ap-toggle-');
  await service.action({
    type: 'package.save',
    package: { id: 'demo', name: 'demo', kind: 'mcp', targets: [], mcp: { serverName: 'demo', command: 'npx', args: ['-y', 'demo'] } },
  });
  const codexFile = join(homeDir, '.codex', 'config.toml');

  const on = await service.action({ type: 'package.toggleHarness', id: 'demo', harness: 'codex', enabled: true });
  assert.equal(on.ok, true);
  assert.equal((await readCodexMcpServers(codexFile)).demo.command, 'npx');
  let pkg = on.state.packages.find(p => p.id === 'demo');
  assert.deepEqual(pkg.targets, ['codex']);
  assert.equal(pkg.harnessStatuses.codex.status, 'installed');

  await assert.rejects(
    () => service.action({ type: 'package.toggleHarness', id: 'demo', harness: 'dsh', enabled: true }),
    /DSH 原生没有可写入的 MCP 配置文件/,
  );

  const off = await service.action({ type: 'package.toggleHarness', id: 'demo', harness: 'codex', enabled: false });
  assert.equal(off.ok, true);
  assert.equal((await readCodexMcpServers(codexFile)).demo, undefined);
  pkg = off.state.packages.find(p => p.id === 'demo');
  assert.deepEqual(pkg.targets, []);
  assert.equal(pkg.harnessStatuses.codex.status, 'unselected', '关闭成功后清掉该端锁记录');
});

test('端开关：步骤被跳过时不翻转（安装器某端没有卸载命令）', async t => {
  const { service } = await setup(t, 'ap-toggle-skip-');
  const runShell = async () => ({ stdout: 'ok', stderr: '' });
  service.runShell = runShell;
  await service.action({
    type: 'package.save',
    installNow: true,
    package: { id: 'tool', name: 'tool', kind: 'installer', targets: ['codex'], commands: { codex: { install: 'tool install codex' } } },
  });
  const off = await service.action({ type: 'package.toggleHarness', id: 'tool', harness: 'codex', enabled: false });
  assert.equal(off.ok, false);
  assert.match(off.message, /未变更/);
  const pkg = off.state.packages.find(p => p.id === 'tool');
  assert.deepEqual(pkg.targets, ['codex'], '跳过时保持原目标端');
  assert.equal(pkg.harnessStatuses.codex.status, 'installed');
});

test('Skill 开关：单个 Skill × 单个端增删，整组开关，全选时不写逐端列表', async t => {
  const { base, homeDir, service } = await setup(t, 'ap-skill-toggle-');
  const upstream = await createSkillsRepo(base);
  await service.action({
    type: 'package.save',
    installNow: true,
    package: { id: 'sk', name: 'sk', kind: 'skills-repo', repo: upstream, targets: ['codex', 'claude-code'] },
  });
  const codexAlpha = join(homeDir, '.codex', 'skills', 'alpha');
  const codexBeta = join(homeDir, '.codex', 'skills', 'beta');
  assert.equal(await exists(codexAlpha), true);

  let res = await service.action({ type: 'skill.toggle', id: 'sk', skill: 'alpha', harness: 'codex', enabled: false });
  assert.equal(res.ok, true);
  assert.equal(await exists(codexAlpha), false);
  assert.equal(await exists(codexBeta), true);
  assert.equal(await exists(join(homeDir, '.claude', 'skills', 'alpha')), true, '其他端不受影响');
  let pkg = res.state.packages.find(p => p.id === 'sk');
  assert.deepEqual(pkg.skills.perHarness.codex, ['beta']);
  const alpha = pkg.skillItems.find(item => item.name === 'alpha');
  assert.equal(alpha.harnesses.codex.status, 'unselected');
  assert.equal(alpha.harnesses['claude-code'].status, 'installed');

  res = await service.action({ type: 'skill.toggle', id: 'sk', skill: 'alpha', harness: 'codex', enabled: true });
  assert.equal(await exists(codexAlpha), true);
  pkg = res.state.packages.find(p => p.id === 'sk');
  assert.equal(pkg.skills.perHarness.codex, undefined, '全选时恢复为「全部」，上游新增 Skill 自动跟上');

  res = await service.action({ type: 'skill.toggle', id: 'sk', skill: null, harness: 'claude-code', enabled: false });
  assert.equal(res.ok, true);
  assert.equal(await exists(join(homeDir, '.claude', 'skills', 'alpha')), false);
  assert.equal(await exists(join(homeDir, '.claude', 'skills', 'beta')), false);
  pkg = res.state.packages.find(p => p.id === 'sk');
  assert.deepEqual(pkg.targets, ['codex']);

  res = await service.action({ type: 'skill.toggle', id: 'sk', skill: 'beta', harness: 'antigravity', enabled: true });
  assert.equal(await exists(join(homeDir, '.gemini', 'config', 'skills', 'beta')), true);
  assert.equal(await exists(join(homeDir, '.gemini', 'config', 'skills', 'alpha')), false);
});

test('纳管 MCP：只登记不改文件，保留原 key 与未建模字段，之后可同步到其他端', async t => {
  const { homeDir, service } = await setup(t, 'ap-adopt-mcp-');
  const claudeFile = join(homeDir, '.claude.json');
  const original = {
    theme: 'dark',
    mcpServers: {
      'Chrome-DevTools': { type: 'stdio', command: 'npx', args: ['chrome-devtools-mcp'], env: { TOKEN: '${TOKEN}', MODE: 'fast' }, alwaysLoad: true },
    },
  };
  await writeFile(claudeFile, JSON.stringify(original, null, 2) + '\n');
  const before = await readFile(claudeFile, 'utf8');

  let state = await service.state();
  assert.deepEqual(state.local.unmanaged.mcp.map(item => item.name), ['Chrome-DevTools']);

  const res = await service.action({ type: 'local.adopt', area: 'mcp', name: 'Chrome-DevTools' });
  assert.equal(await readFile(claudeFile, 'utf8'), before, '纳管不改动本机配置');
  const pkg = res.state.packages.find(p => p.kind === 'mcp');
  assert.equal(pkg.mcp.serverName, 'Chrome-DevTools');
  assert.deepEqual(pkg.mcp.envRefs, ['TOKEN']);
  assert.deepEqual(pkg.mcp.env, { MODE: 'fast' });
  assert.equal(pkg.harnessStatuses['claude-code'].status, 'installed');
  assert.equal(res.state.local.unmanaged.mcp.length, 0);

  // 同步到 Antigravity：用原 key 写入
  await service.action({ type: 'package.toggleHarness', id: pkg.id, harness: 'antigravity', enabled: true });
  const agy = await readJsonMcpServers(join(homeDir, '.gemini', 'config', 'mcp_config.json'));
  assert.equal(agy['Chrome-DevTools'].command, 'npx');

  // 对原端重新同步：key 不变、alwaysLoad 保留、无关配置不动
  await service.action({ type: 'package.install', id: pkg.id, harnesses: ['claude-code'] });
  const after = JSON.parse(await readFile(claudeFile, 'utf8'));
  assert.equal(after.theme, 'dark');
  assert.deepEqual(Object.keys(after.mcpServers), ['Chrome-DevTools']);
  assert.equal(after.mcpServers['Chrome-DevTools'].alwaysLoad, true);
  assert.equal(after.mcpServers['Chrome-DevTools'].env.TOKEN, '${TOKEN}');

  // 编辑面板只提交基本字段：保存后纳管保留的额外字段不丢
  const edited = await service.action({
    type: 'package.save',
    originalId: pkg.id,
    package: { name: pkg.name, kind: 'mcp', repo: '', targets: ['claude-code', 'antigravity'], skills: { include: [], mode: 'symlink' }, mcp: { serverName: 'Chrome-DevTools', transport: 'stdio', command: 'npx', args: ['chrome-devtools-mcp', '--headless'] } },
  });
  const editedPkg = edited.state.packages.find(p => p.id === pkg.id);
  assert.equal(editedPkg.mcp.overrides['claude-code'].alwaysLoad, true);
});

test('纳管 Skill：以原目录为源，同步到其他端建软链；其他端仍在用时不删源目录', async t => {
  const { homeDir, service } = await setup(t, 'ap-adopt-skill-');
  const sourceDir = join(homeDir, '.claude', 'skills', 'my-skill');
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, 'SKILL.md'), '---\nname: my-skill\n---\n');

  let res = await service.action({ type: 'local.adopt', area: 'skill', name: 'my-skill' });
  const local = res.state.packages.find(p => p.id === 'local-skills');
  assert.ok(local, '纳管进「本机 Skills」组');
  assert.equal(local.skillItems[0].harnesses['claude-code'].status, 'installed');
  assert.equal(res.state.local.unmanaged.skills.length, 0);

  res = await service.action({ type: 'skill.toggle', id: 'local-skills', skill: 'my-skill', harness: 'codex', enabled: true });
  assert.equal(res.ok, true);
  const codexPath = join(homeDir, '.codex', 'skills', 'my-skill');
  assert.equal((await lstat(codexPath)).isSymbolicLink(), true);
  assert.equal(await readlink(codexPath), await realpath(sourceDir));
  // 对源目录所在端重新同步：源目录原样保留，不被删除重建
  await service.action({ type: 'package.install', id: 'local-skills', harnesses: ['claude-code'] });
  assert.equal((await lstat(sourceDir)).isDirectory(), true);
  assert.equal(await exists(join(sourceDir, 'SKILL.md')), true);

  // 关闭源目录所在端：Codex 仍软链到它，拒绝删除
  res = await service.action({ type: 'skill.toggle', id: 'local-skills', skill: 'my-skill', harness: 'claude-code', enabled: false });
  assert.equal(res.ok, false);
  assert.equal(await exists(join(sourceDir, 'SKILL.md')), true);

  // 先关 Codex，再关源端：源目录随最后一个端删除，组随之移除
  await service.action({ type: 'skill.toggle', id: 'local-skills', skill: 'my-skill', harness: 'codex', enabled: false });
  assert.equal(await exists(codexPath), false);
  res = await service.action({ type: 'skill.toggle', id: 'local-skills', skill: 'my-skill', harness: 'claude-code', enabled: false });
  assert.equal(res.ok, true);
  assert.equal(res.state.packages.some(p => p.id === 'local-skills'), false);
});

test('纳管插件只登记；插件与安装器带来的条目标为「由 X 管理」，Codex 内置插件不列为未纳管', async t => {
  const { homeDir, service } = await setup(t, 'ap-adopt-plugin-');
  await mkdir(join(homeDir, '.claude', 'plugins'), { recursive: true });
  await writeFile(join(homeDir, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: { 'tidy@tidy-market': [{ scope: 'user', version: '2.0.0' }] },
  }));
  await mkdir(join(homeDir, '.codex'), { recursive: true });
  await writeFile(join(homeDir, '.codex', 'config.toml'), [
    '[plugins."browser@openai-bundled"]',
    'enabled = true',
    '',
    '[mcp_servers.codegraph]',
    'command = "codegraph"',
    '',
  ].join('\n'));
  await mkdir(join(homeDir, '.dsh', 'skills', 'ponytail-audit'), { recursive: true });

  service.runShell = async () => ({ stdout: 'ok', stderr: '' });
  await service.action({
    type: 'package.save',
    package: { id: 'codegraph', name: 'codegraph', kind: 'installer', targets: ['codex'], commands: { codex: { install: 'codegraph install' } } },
  });
  await service.action({
    type: 'package.save',
    package: { id: 'ponytail', name: 'ponytail', kind: 'plugin', targets: ['dsh'], plugin: { name: 'ponytail', marketplace: 'ponytail' }, commands: { dsh: { install: 'cp -R skills ~/.dsh/skills' } } },
  });

  let state = await service.state();
  assert.deepEqual(state.local.unmanaged.plugins.map(item => item.name), ['tidy']);
  assert.equal(state.local.builtinPluginCount, 1);
  assert.deepEqual(state.local.owned.mcp.map(item => [item.name, item.ownedBy]), [['codegraph', 'codegraph']]);
  assert.deepEqual(state.local.owned.skills.map(item => [item.name, item.ownedBy]), [['ponytail-audit', 'ponytail']]);
  assert.equal(state.local.unmanaged.mcp.length, 0);
  assert.equal(state.local.unmanaged.skills.length, 0);

  const before = await readFile(join(homeDir, '.claude', 'plugins', 'installed_plugins.json'), 'utf8');
  const res = await service.action({ type: 'local.adopt', area: 'plugin', name: 'tidy' });
  assert.equal(await readFile(join(homeDir, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'), before);
  const pkg = res.state.packages.find(p => p.id === 'tidy');
  assert.equal(pkg.plugin.marketplace, 'tidy-market');
  assert.equal(pkg.harnessStatuses['claude-code'].status, 'installed');
  assert.equal(pkg.harnessStatuses['claude-code'].installedVersion, '2.0.0');
});

test('纳管多端配置不同的 MCP 后「全部同步」：各端条目保持原样', async t => {
  const { homeDir, service } = await setup(t, 'ap-adopt-diverge-');
  await mkdir(join(homeDir, '.codex'), { recursive: true });
  await writeFile(join(homeDir, '.codex', 'config.toml'), '[mcp_servers.pw]\ncommand = "npx"\nargs = ["@playwright/mcp@latest", "--headless"]\n');
  const claudeFile = join(homeDir, '.claude.json');
  const claudeEntry = { type: 'stdio', command: 'npx', args: ['@playwright/mcp@0.0.29'], env: { DEBUG: '1' } };
  await writeFile(claudeFile, JSON.stringify({ mcpServers: { pw: claudeEntry } }, null, 2) + '\n');
  const codexBefore = await readCodexMcpServers(join(homeDir, '.codex', 'config.toml'));

  await service.action({ type: 'local.adopt', area: 'mcp', name: 'pw' });
  await service.action({ type: 'packages.syncAll' });

  assert.deepEqual(await readCodexMcpServers(join(homeDir, '.codex', 'config.toml')), codexBefore);
  assert.deepEqual(JSON.parse(await readFile(claudeFile, 'utf8')).mcpServers.pw, claudeEntry);
});

test('同名不同市场的插件分行列出、按分组键纳管；Antigravity 无市场名并入同名行', async t => {
  const { homeDir, service } = await setup(t, 'ap-plugin-group-');
  await mkdir(join(homeDir, '.claude', 'plugins'), { recursive: true });
  await writeFile(join(homeDir, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: { 'design@market-a': [{ scope: 'user', version: '1.0.0' }] },
  }));
  await mkdir(join(homeDir, '.codex'), { recursive: true });
  await writeFile(join(homeDir, '.codex', 'config.toml'), '[plugins."design@market-b"]\nenabled = true\n');
  await mkdir(join(homeDir, '.gemini', 'config', 'plugins', 'design'), { recursive: true });

  const state = await service.state();
  assert.deepEqual(state.local.unmanaged.plugins.map(item => item.key), ['design@market-a', 'design@market-b']);
  // Antigravity 没有市场名，并入最先出现的同名行（Codex 先扫描），不单独成行
  assert.equal(state.local.unmanaged.plugins.filter(item => item.harnesses.antigravity).length, 1);
  assert.ok(state.local.unmanaged.plugins.find(item => item.key === 'design@market-b').harnesses.antigravity);

  const res = await service.action({ type: 'local.adopt', area: 'plugin', name: 'design@market-b' });
  const pkg = res.state.packages.find(p => p.kind === 'plugin');
  assert.equal(pkg.plugin.marketplace, 'market-b');
  assert.deepEqual(pkg.targets, ['codex', 'antigravity']);
  assert.deepEqual(res.state.local.unmanaged.plugins.map(item => item.key), ['design@market-a']);
});

test('本机扫描出错时降级为提示，页面状态仍可读取', async t => {
  const { homeDir, service } = await setup(t, 'ap-scan-error-');
  const skillsDir = join(homeDir, '.codex', 'skills');
  await mkdir(skillsDir, { recursive: true });
  await chmod(skillsDir, 0o000);
  t.after(() => chmod(skillsDir, 0o755).catch(() => {}));
  const state = await service.state();
  assert.ok(state.local.warnings.some(w => w.area === 'skills' && /本机扫描失败/.test(w.message)));
  assert.deepEqual(state.local.unmanaged.skills, []);
});

test('整组开启遵守 include：只装 include 中的 Skill', async t => {
  const { base, homeDir, service } = await setup(t, 'ap-skill-include-');
  const upstream = await createSkillsRepo(base);
  await service.action({
    type: 'package.save',
    installNow: true,
    package: { id: 'sk', name: 'sk', kind: 'skills-repo', repo: upstream, targets: ['codex'], skills: { include: ['alpha'], mode: 'symlink' } },
  });
  const res = await service.action({ type: 'skill.toggle', id: 'sk', skill: null, harness: 'claude-code', enabled: true });
  assert.equal(res.ok, true);
  assert.equal(await exists(join(homeDir, '.claude', 'skills', 'alpha')), true);
  assert.equal(await exists(join(homeDir, '.claude', 'skills', 'beta')), false);
});
