import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
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

test('Skills：按名称合并 4 端；开启建软链，关闭软链直接删、实体目录移入回收目录', async t => {
  const { homeDir, dshHome, service } = await setup(t, 'ap-skills-');
  const claudeSkills = join(homeDir, '.claude', 'skills');
  await makeSkill(claudeSkills, 'notes');
  await makeSkill(join(homeDir, '.codex', 'skills'), 'other');

  let state = await service.state();
  assert.deepEqual(state.skills.rows.map(r => r.name), ['notes', 'other']);
  assert.equal(state.skills.rows[0].complete, false);

  const on = await service.action({ type: 'skill.toggle', name: 'notes', harness: 'codex', on: true });
  assert.equal(on.ok, true);
  const codexLink = join(homeDir, '.codex', 'skills', 'notes');
  assert.equal(await readlink(codexLink), await realpath(join(claudeSkills, 'notes')));
  assert.equal(on.state.skills.rows.find(r => r.name === 'notes').consistent, true);

  // 关闭实体目录所在端：Codex 软链指向它，拒绝
  const blocked = await service.action({ type: 'skill.toggle', name: 'notes', harness: 'claude-code', on: false });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /Codex 的软链指向这个目录/);
  assert.equal(await exists(join(claudeSkills, 'notes', 'SKILL.md')), true);

  // 先关 Codex（删软链），再关 Claude（实体目录移入回收目录而非删除）
  await service.action({ type: 'skill.toggle', name: 'notes', harness: 'codex', on: false });
  assert.equal(await exists(codexLink), false);
  const off = await service.action({ type: 'skill.toggle', name: 'notes', harness: 'claude-code', on: false });
  assert.equal(off.ok, true);
  assert.equal(await exists(join(claudeSkills, 'notes')), false);
  const trash = join(dshHome, 'dsh-agent-packages', 'trash');
  const [stamp] = await readdir(trash);
  assert.equal(await exists(join(trash, stamp, 'claude-code', 'notes', 'SKILL.md')), true);
  assert.equal(off.state.skills.rows.some(r => r.name === 'notes'), false);

  await assert.rejects(() => service.action({ type: 'skill.toggle', name: '../etc', harness: 'codex', on: true }).then(r => { if (!r.ok) throw new Error(r.message); }), /不合法/);
});

test('Skills：各端副本不同时标为不一致；失效软链可关闭清理，开启时替换', async t => {
  const { homeDir, service } = await setup(t, 'ap-skills-diff-');
  await makeSkill(join(homeDir, '.claude', 'skills'), 'dup');
  await makeSkill(join(homeDir, '.codex', 'skills'), 'dup');
  const { symlink } = await import('node:fs/promises');
  await mkdir(join(homeDir, '.gemini', 'config', 'skills'), { recursive: true });
  await symlink(join(homeDir, 'missing'), join(homeDir, '.gemini', 'config', 'skills', 'dup'));

  let row = (await service.state()).skills.rows.find(r => r.name === 'dup');
  assert.equal(row.consistent, false);
  assert.equal(row.harnesses.antigravity.broken, true);

  await service.action({ type: 'skill.toggle', name: 'dup', harness: 'antigravity', on: true });
  const target = await readlink(join(homeDir, '.gemini', 'config', 'skills', 'dup'));
  assert.ok(target.endsWith(join('skills', 'dup')) && !target.includes('missing'), '失效软链被替换为指向实体目录');
});

test('MCP：跨格式翻译写入、关闭移除、手工保存保留各端未建模字段', async t => {
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

  // Claude → Codex：${TOKEN} 转成 env_vars，具体值进 env
  const on = await service.action({ type: 'mcp.toggle', key: 'Chrome-DevTools', harness: 'codex', on: true });
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

  // 按端不同的变量：同一 key 在各端写入各自的值；只是变量值不同仍算一致；点亮新端时提示去核对
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
  const agyOn = await service.action({ type: 'mcp.toggle', key: 'hindsight', harness: 'antigravity', on: true });
  assert.match(agyOn.message, /HINDSIGHT_MCP_HARNESS 各端取值不同，已按 Codex 的值写入，请编辑核对/);
  assert.equal(agyOn.ok, true);
  assert.equal(agyOn.warn, true, '需要核对的提示用警示色');

  const off = await service.action({ type: 'mcp.toggle', key: 'Chrome-DevTools', harness: 'codex', on: false });
  assert.equal(off.ok, true);
  assert.equal((await readCodexMcpServers(codexFile))['Chrome-DevTools'], undefined);
  const dsh = await service.action({ type: 'mcp.toggle', key: 'Chrome-DevTools', harness: 'dsh', on: true });
  assert.equal(dsh.ok, false);
});

// 模拟三端 CLI：真实改写各端记录文件，让「以本机记录为准」的翻转判断有据可查
function fakeCli(homeDir, { claudeDir, calls, noop = false }) {
  const claudePlugins = join(claudeDir, 'plugins');
  return async (argv, { env } = {}) => {
    calls.push({ argv: argv.join(' '), env });
    if (noop) return { command: argv.join(' '), stdout: 'ok', stderr: '' };
    const [bin, , sub, a, b] = argv;
    const isClaude = bin === 'claude' || bin === 'reclaude';
    if (isClaude && sub === 'marketplace' && a === 'add') {
      const known = JSON.parse(await readFile(join(claudePlugins, 'known_marketplaces.json'), 'utf8').catch(() => '{}'));
      known[b.split('/').pop()] = { source: { source: 'github', repo: b }, installLocation: join(claudePlugins, 'marketplaces', b.split('/').pop()) };
      await mkdir(claudePlugins, { recursive: true });
      await writeFile(join(claudePlugins, 'known_marketplaces.json'), JSON.stringify(known));
    } else if (isClaude && (sub === 'install' || sub === 'uninstall')) {
      const file = join(claudePlugins, 'installed_plugins.json');
      const data = JSON.parse(await readFile(file, 'utf8').catch(() => '{"plugins":{}}'));
      if (sub === 'install') data.plugins[a] = [{ scope: 'user', version: '1.0.0', installPath: join(claudePlugins, 'cache', a) }];
      else delete data.plugins[a];
      await mkdir(claudePlugins, { recursive: true });
      await writeFile(file, JSON.stringify(data));
    } else if (bin === 'codex' && sub === 'add') {
      const file = join(homeDir, '.codex', 'config.toml');
      await writeFile(file, `${await readFile(file, 'utf8').catch(() => '')}\n[plugins."${a}"]\nenabled = true\n`);
    } else if (bin === 'agy' && sub === 'install') {
      const name = a.split('/').pop().split('@')[0];
      await mkdir(join(homeDir, '.gemini', 'config', 'plugins', name), { recursive: true });
      await writeFile(join(homeDir, '.gemini', 'config', 'plugins', name, 'plugin.json'), '{"version":"1.0.0"}');
    } else if (bin === 'agy' && sub === 'uninstall') {
      await rm(join(homeDir, '.gemini', 'config', 'plugins', a), { recursive: true, force: true });
    }
    return { command: argv.join(' '), stdout: 'ok', stderr: '' };
  };
}

async function seedMarketplace(homeDir, claudeDir) {
  // Claude 已添加市场 tools（本地目录里有 marketplace.json，插件 tidy 来源为相对路径）
  const root = join(claudeDir, 'plugins', 'marketplaces', 'tools');
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await mkdir(join(root, 'plugins', 'tidy', '.claude-plugin'), { recursive: true });
  await writeFile(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'tools', plugins: [{ name: 'tidy', description: '整理', version: '1.0.0', source: './plugins/tidy' }, { name: 'remote', source: { source: 'github', repo: 'x/y' } }] }));
  await writeFile(join(claudeDir, 'plugins', 'known_marketplaces.json'), JSON.stringify({ tools: { source: { source: 'github', repo: 'acme/tools' }, installLocation: root } }));
  // Codex 内置市场里的一个插件
  await mkdir(join(homeDir, '.codex'), { recursive: true });
  await writeFile(join(homeDir, '.codex', 'config.toml'), '[marketplaces.openai-bundled]\nsource_type = "local"\nsource = "/tmp/bundled"\n\n[plugins."browser@openai-bundled"]\nenabled = true\n');
  return root;
}

test('插件：先添加市场再安装；成功才翻转；命令成功但记录没变如实提示；Antigravity 用本地目录安装', async t => {
  const calls = [];
  const { homeDir, service } = await setup(t, 'ap-plugins-');
  const claudeDir = join(homeDir, '.claude');
  const root = await seedMarketplace(homeDir, claudeDir);
  service.runCommand = fakeCli(homeDir, { claudeDir, calls });

  let state = await service.state();
  assert.equal(state.plugins.plugins.find(p => p.id === 'browser@openai-bundled').builtin, true);
  const tools = state.plugins.marketplaces.find(m => m.name === 'tools');
  assert.equal(tools.source, 'acme/tools');
  assert.ok(tools.harnesses['claude-code'] && !tools.harnesses.codex);

  // 市场里的插件按需读取，相对路径来源得到本地目录
  const listed = await service.action({ type: 'marketplace.plugins', name: 'tools' });
  assert.deepEqual(listed.plugins.map(p => [p.name, p.localDir]), [['tidy', join(root, 'plugins', 'tidy')], ['remote', '']]);

  // Codex 未添加市场：拒绝并说明
  await assert.rejects(() => service.action({ type: 'plugin.toggle', name: 'tidy', marketplace: 'tools', harness: 'codex', on: true }), /Codex 未添加市场 tools/);
  // DSH 没有插件机制
  await assert.rejects(() => service.action({ type: 'plugin.toggle', name: 'tidy', marketplace: 'tools', harness: 'dsh', on: true }), /DSH 原生没有插件机制/);

  // Claude 安装：命令执行后读回记录，翻转
  const installed = await service.action({ type: 'plugin.toggle', name: 'tidy', marketplace: 'tools', harness: 'claude-code', on: true });
  assert.equal(installed.ok, true);
  assert.equal(calls.at(-1).argv, 'claude plugin install tidy@tools');
  const row = installed.state.plugins.plugins.find(p => p.id === 'tidy@tools');
  assert.equal(row.harnesses['claude-code'].version, '1.0.0');

  // Antigravity：不是内置市场，用 Claude 记录里的本地目录安装
  const agy = await service.action({ type: 'plugin.toggle', name: 'tidy', marketplace: 'tools', harness: 'antigravity', on: true });
  assert.equal(agy.ok, true);
  assert.equal(calls.at(-1).argv, `agy plugin install ${join(claudeDir, 'plugins', 'cache', 'tidy@tools')}`);
  assert.ok(agy.state.plugins.plugins.find(p => p.id === 'tidy@tools').harnesses.antigravity, 'Antigravity 插件并入同名行');

  // 在 Codex 开启市场（来源取 Claude 的记录），之后可以安装
  const mpOn = await service.action({ type: 'marketplace.toggle', name: 'tools', harness: 'codex', on: true });
  assert.equal(calls.at(-1).argv, 'codex plugin marketplace add acme/tools');
  assert.equal(mpOn.ok, false, '模拟的 codex 没有写入市场记录：命令成功但记录没变，如实提示');
  assert.match(mpOn.message, /市场记录没有变化/);

  // 卸载
  const off = await service.action({ type: 'plugin.toggle', name: 'tidy', marketplace: 'tools', harness: 'antigravity', on: false });
  assert.equal(off.ok, true);
  assert.equal(calls.at(-1).argv, 'agy plugin uninstall tidy');

  // 命令成功但插件记录没变：不翻转并提示
  service.runCommand = fakeCli(homeDir, { claudeDir, calls, noop: true });
  const noop = await service.action({ type: 'plugin.toggle', name: 'tidy', marketplace: 'tools', harness: 'claude-code', on: false });
  assert.equal(noop.ok, false);
  assert.match(noop.message, /插件记录没有变化/);

  // 命令失败：不翻转，执行记录写明错误
  service.runCommand = async () => { throw new Error('network down'); };
  const fail = await service.action({ type: 'plugin.toggle', name: 'tidy', marketplace: 'tools', harness: 'claude-code', on: false });
  assert.equal(fail.ok, false);
  assert.match(fail.steps[0].detail, /network down/);

  await assert.rejects(() => service.action({ type: 'marketplace.add', source: 'rm -rf /', harnesses: ['codex'] }), /市场来源/);

  // 添加市场逐端执行：一端失败不影响另一端，整体 ok=false，失败步骤带命令与错误原文
  service.runCommand = async argv => {
    if (argv[0] === 'codex') throw new Error(`${argv.join(' ')} 退出码 1：fatal: repository not found`);
    return { command: argv.join(' '), stdout: 'ok', stderr: '' };
  };
  const partial = await service.action({ type: 'marketplace.add', source: 'acme/extras', harnesses: ['claude-code', 'codex'] });
  assert.equal(partial.ok, false);
  assert.match(partial.message, /1 端失败/);
  assert.deepEqual(partial.steps.map(s => [s.harness, s.status]), [['claude-code', 'ok'], ['codex', 'error']]);
  assert.match(partial.steps[1].detail, /退出码 1/);
  assert.match(partial.steps[1].command, /codex plugin marketplace add acme\/extras/);
});

test('Claude Code 命令配置为 reclaude：按其账号配置目录读写，插件命令经 reclaude 执行并带上 CLAUDE_CONFIG_DIR', async t => {
  const calls = [];
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
  await seedMarketplace(homeDir, accountDir);
  service.runCommand = fakeCli(homeDir, { claudeDir: accountDir, calls });

  const state = await service.state();
  const claude = state.harnesses.find(h => h.id === 'claude-code');
  assert.equal(claude.skillsDir, join(accountDir, 'skills'));
  assert.equal(claude.mcpFile, join(accountDir, '.claude.json'));
  assert.ok(probes > 0);

  const res = await service.action({ type: 'plugin.toggle', name: 'tidy', marketplace: 'tools', harness: 'claude-code', on: true });
  assert.equal(res.ok, true);
  assert.equal(calls.at(-1).argv, 'reclaude plugin install tidy@tools');
  assert.equal(calls.at(-1).env.CLAUDE_CONFIG_DIR, accountDir);
});

test('dsh-harness-provider 显式配置 claudeConfigDir：优先于 reclaude 探测，Skills / MCP / 插件都落在该目录', async t => {
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
  await makeSkill(join(homeDir, '.codex', 'skills'), 'alpha');
  await service.action({ type: 'skill.toggle', name: 'alpha', harness: 'claude-code', on: true });
  assert.equal((await lstat(join(configDir, 'skills', 'alpha'))).isSymbolicLink(), true);
  assert.equal(await exists(join(homeDir, '.claude', 'skills', 'alpha')), false);
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

test('插件带来的 Skill 与 MCP：标注来源插件，开关与编辑一律拒绝', async t => {
  const { homeDir, service } = await setup(t, 'ap-owned-');
  const pluginDir = join(homeDir, '.claude', 'plugins', 'cache', 'tidy');
  await makeSkill(join(pluginDir, 'skills'), 'helper');
  await writeFile(join(pluginDir, '.mcp.json'), JSON.stringify({ mcpServers: { 'tidy-mcp': { command: 'tidy' } } }));
  await writeFile(join(homeDir, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'tidy@tools': [{ scope: 'user', version: '1.0.0', installPath: pluginDir }] } }));
  // 插件把 helper 拷进了 DSH 的 Skills 目录，把 tidy-mcp 写进了 Codex 配置
  await makeSkill(join(homeDir, '.dsh', 'skills'), 'helper');
  await makeSkill(join(homeDir, '.dsh', 'skills'), 'mine');
  await mkdir(join(homeDir, '.codex'), { recursive: true });
  await writeFile(join(homeDir, '.codex', 'config.toml'), '[mcp_servers.tidy-mcp]\ncommand = "tidy"\n');

  const state = await service.state();
  assert.deepEqual(state.skills.rows.find(r => r.name === 'helper').providedBy, ['tidy']);
  assert.deepEqual(state.skills.rows.find(r => r.name === 'mine').providedBy, []);
  assert.deepEqual(state.mcp.rows.find(r => r.key === 'tidy-mcp').providedBy, ['tidy']);

  await assert.rejects(() => service.action({ type: 'skill.toggle', name: 'helper', harness: 'codex', on: true }), /由插件 tidy 提供/);
  await assert.rejects(() => service.action({ type: 'skill.toggle', name: 'helper', harness: 'dsh', on: false }), /由插件 tidy 提供/);
  assert.equal(await exists(join(homeDir, '.dsh', 'skills', 'helper', 'SKILL.md')), true, '插件的文件不被删除');
  await assert.rejects(() => service.action({ type: 'mcp.toggle', key: 'tidy-mcp', harness: 'claude-code', on: true }), /由插件 tidy 提供/);
  await assert.rejects(() => service.action({ type: 'mcp.save', key: 'tidy-mcp', harnesses: ['codex'], spec: { command: 'x' } }), /由插件 tidy 提供/);
  // 不是插件带来的照常可以同步
  const ok = await service.action({ type: 'skill.toggle', name: 'mine', harness: 'codex', on: true });
  assert.equal(ok.ok, true);
});
