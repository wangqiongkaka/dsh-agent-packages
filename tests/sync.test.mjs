import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PackageManagerService } from '../src/service.mjs';
import { readCodexMcpServers, readJsonMcpServers } from '../src/config-editors.mjs';
import { readHarnessClaudeCommand, readHarnessClaudeConfigDir } from '../src/claude-command.mjs';

// 测试只用临时目录，避免经环境变量读到本机真实的 Claude / Codex 配置
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;

async function setup(t, prefix, options = {}) {
  const base = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(base, { recursive: true, force: true }));
  const homeDir = join(base, 'home');
  const dshHome = join(homeDir, '.dsh');
  const service = new PackageManagerService({ root: join(dshHome, 'dsh-agent-packages'), homeDir, dshHome, ...options });
  await service.init();
  return { base, homeDir, dshHome, service };
}

const exists = async p => { try { await lstat(p); return true; } catch { return false; } };

async function makeSkill(dir, name) {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
}

test('Skills：只读，按名称合并 4 端；各端副本不同标为不一致，失效软链标出；页面不再同步或删除', async t => {
  const { homeDir, service } = await setup(t, 'ap-skills-');
  const claudeSkills = join(homeDir, '.claude', 'skills');
  await makeSkill(claudeSkills, 'notes');
  await makeSkill(claudeSkills, 'dup');
  await makeSkill(join(homeDir, '.codex', 'skills'), 'dup');
  const { symlink } = await import('node:fs/promises');
  await mkdir(join(homeDir, '.gemini', 'config', 'skills'), { recursive: true });
  await symlink(join(homeDir, 'missing'), join(homeDir, '.gemini', 'config', 'skills', 'dup'));

  const state = await service.state();
  assert.deepEqual(state.skills.rows.map(r => r.name), ['dup', 'notes']);
  const dup = state.skills.rows.find(r => r.name === 'dup');
  assert.equal(dup.consistent, false);
  assert.equal(dup.harnesses.antigravity.broken, true);
  assert.equal(state.skills.rows.find(r => r.name === 'notes').complete, false);
  assert.equal('providedBy' in dup, false, '不再区分是否由插件提供');
  assert.equal('trashDir' in state, false);

  await assert.rejects(() => service.action({ type: 'skill.toggle', name: 'notes', harness: 'codex', on: true }), /不支持的操作类型/);
  assert.equal(await exists(join(homeDir, '.codex', 'skills', 'notes')), false);
});

test('MCP：添加 / 编辑按所选端跨格式写入、保留未建模字段；格子只能移除，不再同步', async t => {
  const { homeDir, service } = await setup(t, 'ap-mcp-');
  const claudeFile = join(homeDir, '.claude.json');
  await writeFile(claudeFile, JSON.stringify({
    theme: 'dark',
    mcpServers: { 'Chrome-DevTools': { type: 'stdio', command: 'npx', args: ['chrome-devtools-mcp'], env: { TOKEN: '${TOKEN}', MODE: 'fast' }, alwaysLoad: true } },
  }, null, 2) + '\n');
  const codexFile = join(homeDir, '.codex', 'config.toml');

  let state = await service.state();
  assert.deepEqual(state.mcp.rows.map(r => r.key), ['Chrome-DevTools']);
  assert.equal(state.harnesses.find(h => h.id === 'dsh').supportsMcp, false);

  // 不再提供点格子同步
  await assert.rejects(() => service.action({ type: 'mcp.toggle', key: 'Chrome-DevTools', harness: 'codex', on: true }), /不支持的操作类型/);

  // 编辑时勾选 Codex：${TOKEN} 转成 env_vars，具体值进 env
  const on = await service.action({
    type: 'mcp.save',
    key: 'Chrome-DevTools',
    harnesses: ['codex'],
    spec: { transport: 'stdio', command: 'npx', args: ['chrome-devtools-mcp'], env: { MODE: 'fast' }, envRefs: ['TOKEN'] },
  });
  assert.equal(on.ok, true);
  const codex = (await readCodexMcpServers(codexFile))['Chrome-DevTools'];
  assert.equal(codex.command, 'npx');
  assert.deepEqual(codex.env_vars, ['TOKEN']);
  assert.equal(codex.env.MODE, 'fast');
  assert.equal(on.state.mcp.rows[0].consistent, true, '归一化后两端定义一致');

  // 手工编辑并写回 Claude：alwaysLoad 等未建模字段保留，无关配置不动
  await service.action({
    type: 'mcp.save',
    key: 'Chrome-DevTools',
    harnesses: ['claude-code'],
    spec: { transport: 'stdio', command: 'npx', args: ['chrome-devtools-mcp', '--headless'], env: { MODE: 'fast' }, envRefs: ['TOKEN'] },
  });
  const claude = JSON.parse(await readFile(claudeFile, 'utf8'));
  assert.equal(claude.theme, 'dark');
  assert.equal(claude.mcpServers['Chrome-DevTools'].alwaysLoad, true);
  assert.deepEqual(claude.mcpServers['Chrome-DevTools'].args, ['chrome-devtools-mcp', '--headless']);
  assert.equal((await service.state()).mcp.rows[0].consistent, false, 'args 不同后标为不一致');

  // 手工新增只写所选端；DSH 原生不可写
  await service.action({ type: 'mcp.save', key: 'local-api', harnesses: ['antigravity'], spec: { transport: 'http', url: 'https://example.com/mcp' } });
  assert.equal((await readJsonMcpServers(join(homeDir, '.gemini', 'config', 'mcp_config.json')))['local-api'].url, 'https://example.com/mcp');
  await assert.rejects(() => service.action({ type: 'mcp.save', key: 'x', harnesses: ['dsh'], spec: { command: 'x' } }), /至少选择一个可写入 MCP 的端/);
  await assert.rejects(() => service.action({ type: 'mcp.save', key: 'bad key', harnesses: ['codex'], spec: { command: 'x' } }), /MCP key/);

  // 按端不同的变量：同一 key 在各端写入各自的值；只是变量值不同仍算一致
  const base = { transport: 'stdio', command: 'node', args: ['mcp-server.js'] };
  await service.action({
    type: 'mcp.save',
    key: 'hindsight',
    harnesses: ['codex', 'claude-code'],
    spec: { ...base, env: { HINDSIGHT_MCP_HARNESS: 'codex' } },
    specs: { 'claude-code': { ...base, env: { HINDSIGHT_MCP_HARNESS: 'claude-code' } } },
  });
  assert.equal((await readCodexMcpServers(codexFile)).hindsight.env.HINDSIGHT_MCP_HARNESS, 'codex');
  assert.equal(JSON.parse(await readFile(claudeFile, 'utf8')).mcpServers.hindsight.env.HINDSIGHT_MCP_HARNESS, 'claude-code');
  assert.equal((await service.state()).mcp.rows.find(r => r.key === 'hindsight').consistent, true, '只是变量值不同算一致');

  // 移除：只删该端的这个 key，其他条目不动
  const off = await service.action({ type: 'mcp.remove', key: 'Chrome-DevTools', harness: 'codex' });
  assert.equal(off.ok, true);
  assert.equal((await readCodexMcpServers(codexFile))['Chrome-DevTools'], undefined);
  assert.equal((await readCodexMcpServers(codexFile)).hindsight.command, 'node');
  const dsh = await service.action({ type: 'mcp.remove', key: 'Chrome-DevTools', harness: 'dsh' });
  assert.equal(dsh.ok, false);
  assert.match(dsh.message, /没有可写入的 MCP 配置文件/);
});

// 三端已装插件的记录：Claude 装了 tidy@tools，Codex 装了内置的 browser@openai-bundled，Antigravity 装了同名的 tidy
async function seedPlugins(homeDir, claudeDir) {
  const tidyDir = join(claudeDir, 'plugins', 'cache', 'tools', 'tidy', '1.0.0');
  await mkdir(tidyDir, { recursive: true });
  await writeFile(join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'tidy@tools': [{ scope: 'user', version: '1.0.0', installPath: tidyDir }] } }));
  await mkdir(join(homeDir, '.codex'), { recursive: true });
  await writeFile(join(homeDir, '.codex', 'config.toml'), '[plugins."browser@openai-bundled"]\nenabled = true\n');
  const agyTidy = join(homeDir, '.gemini', 'config', 'plugins', 'tidy');
  await mkdir(agyTidy, { recursive: true });
  await writeFile(join(agyTidy, 'plugin.json'), '{"name":"tidy","version":"1.0.1"}');
}

test('插件：只读展示各端已装插件，按「名称@市场」合并；安装与市场操作已移除', async t => {
  const { homeDir, service } = await setup(t, 'ap-plugins-');
  await seedPlugins(homeDir, join(homeDir, '.claude'));

  const state = await service.state();
  assert.deepEqual(state.plugins.plugins.map(p => p.id), ['browser@openai-bundled', 'tidy@tools']);
  const tidy = state.plugins.plugins.find(p => p.id === 'tidy@tools');
  assert.equal(tidy.harnesses['claude-code'].version, '1.0.0');
  assert.equal(tidy.harnesses.antigravity.version, '1.0.1', 'Antigravity 没有市场名，按名称并入');
  assert.equal(tidy.harnesses.codex, undefined);
  assert.equal(state.plugins.plugins.find(p => p.id === 'browser@openai-bundled').builtin, true);
  assert.equal('marketplaces' in state.plugins, false);
  assert.deepEqual(state.harnesses.map(h => h.command), ['codex', 'claude', 'agy', ''], '各端插件命令名，提示手工安装用');

  // 插件由各端原生命令手工安装，页面不再执行任何插件或市场命令
  for (const type of ['plugin.toggle', 'plugin.update', 'marketplace.add', 'marketplace.toggle', 'marketplace.refresh', 'marketplace.plugins']) {
    await assert.rejects(() => service.action({ type, name: 'tidy', marketplace: 'tools', harness: 'claude-code', on: true }), /不支持的操作类型/);
  }
});

test('Claude Code 命令配置为 reclaude：按其账号配置目录读写，插件记录也从该目录读取', async t => {
  const base = await mkdtemp(join(tmpdir(), 'ap-reclaude-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const homeDir = join(base, 'home');
  const dataDir = join(base, 'rec-data');
  const accountDir = join(dataDir, 'claude', 'accounts', '57531', 'config');
  let probes = 0;
  const service = new PackageManagerService({
    root: join(homeDir, '.dsh', 'dsh-agent-packages'),
    homeDir,
    dshHome: join(homeDir, '.dsh'),
    claudeCommand: () => 'reclaude',
    execImpl: async (file, args) => {
      if (file === 'reclaude' && args.join(' ') === 'status --json') {
        probes++;
        return { stdout: JSON.stringify({ global: { data_dir: dataDir }, claude: { current: { device_id: 57531 } } }) };
      }
      throw new Error(`unexpected ${file}`);
    },
  });
  await service.init();
  await seedPlugins(homeDir, accountDir);

  const state = await service.state();
  const claude = state.harnesses.find(h => h.id === 'claude-code');
  assert.equal(claude.skillsDir, join(accountDir, 'skills'));
  assert.equal(claude.mcpFile, join(accountDir, '.claude.json'));
  assert.ok(probes > 0);

  assert.equal(claude.command, 'reclaude');
  assert.ok(state.plugins.plugins.find(p => p.id === 'tidy@tools').harnesses['claude-code'], '插件记录从账号配置目录读取');
});

test('dsh-harness-provider 显式配置 claudeConfigDir：优先于 reclaude 探测，Skills / MCP / 插件都按该目录读写', async t => {
  const base = await mkdtemp(join(tmpdir(), 'ap-config-dir-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const homeDir = join(base, 'home');
  const configDir = join(base, 'claude-config');
  const service = new PackageManagerService({
    root: join(homeDir, '.dsh', 'dsh-agent-packages'),
    homeDir,
    dshHome: join(homeDir, '.dsh'),
    claudeCommand: () => 'reclaude',
    claudeConfigDir: () => configDir,
    execImpl: async () => { throw new Error('显式配置 claudeConfigDir 时不应探测 reclaude'); },
  });
  await service.init();
  await makeSkill(join(configDir, 'skills'), 'alpha');
  await makeSkill(join(homeDir, '.claude', 'skills'), 'stray');
  const names = (await service.state()).skills.rows.map(r => r.name);
  assert.deepEqual(names, ['alpha'], 'Claude Code 的 Skills 从配置目录读取，不读默认目录');
  await service.action({ type: 'mcp.save', key: 'dir-mcp', harnesses: ['claude-code'], spec: { command: 'npx', args: ['dir-mcp'] } });
  assert.equal((await readJsonMcpServers(join(configDir, '.claude.json')))['dir-mcp'].command, 'npx');
  assert.equal(await exists(join(homeDir, '.claude.json')), false);
});

test('读取 harness-provider 的 claudeCommand 与 claudeConfigDir：缺少设置服务或读取出错时回落为空', () => {
  const settings = rows => () => ({ describe: () => rows });
  assert.equal(readHarnessClaudeCommand(settings([{ ns: 'harness-plugin', value: { claudeCommand: ' reclaude ' } }])), 'reclaude');
  assert.equal(readHarnessClaudeCommand(settings([{ ns: 'other', value: { claudeCommand: 'x' } }])), '');
  assert.equal(readHarnessClaudeCommand(settings([{ ns: 'harness-plugin', value: { claudeCommand: 1 } }])), '');
  assert.equal(readHarnessClaudeCommand(() => undefined), '');
  assert.equal(readHarnessClaudeCommand(() => { throw new Error('no settings'); }), '');
  assert.equal(readHarnessClaudeConfigDir(settings([{ ns: 'harness-plugin', value: { claudeConfigDir: ' ~/.rec/x ' } }])), '~/.rec/x');
  assert.equal(readHarnessClaudeConfigDir(settings([{ ns: 'harness-plugin', value: { claudeConfigDir: null } }])), '');
  assert.equal(readHarnessClaudeConfigDir(() => { throw new Error('no settings'); }), '');
});
