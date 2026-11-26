import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inferPackageFromRepoMeta, extractInstallCommandsFromReadme, pluginHookPaths } from '../src/github-inspector.mjs';
import { PackageManagerService } from '../src/service.mjs';
import { apiHandler, ENDPOINT, HEADER_KEY } from '../src/api.mjs';
import { readCodexMcpServers, readJsonMcpServers } from '../src/config-editors.mjs';
import { formatHarnessVersion, formatVersion, summarizePackageVersions } from '../src/shared.mjs';

const execFileAsync = promisify(execFile);
// 测试只用临时目录，避免经环境变量读到本机真实的 Claude / Codex 配置
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;

async function createSampleSkillsRepo(baseDir) {
  const repoDir = join(baseDir, 'upstream-skills');
  await mkdir(join(repoDir, 'skills', 'alpha'), { recursive: true });
  await mkdir(join(repoDir, 'skills', 'beta'), { recursive: true });
  await writeFile(join(repoDir, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\n---\n# Alpha v1\n');
  await writeFile(join(repoDir, 'skills', 'beta', 'SKILL.md'), '---\nname: beta\n---\n# Beta v1\n');
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  await execFileAsync('git', ['add', '.'], { cwd: repoDir });
  await execFileAsync('git', ['commit', '-m', 'v1'], { cwd: repoDir });
  await execFileAsync('git', ['tag', 'v1.0.0'], { cwd: repoDir });

  // v1.1.0: 移除 beta，新增 gamma
  await rm(join(repoDir, 'skills', 'beta'), { recursive: true, force: true });
  await mkdir(join(repoDir, 'skills', 'gamma'), { recursive: true });
  await writeFile(join(repoDir, 'skills', 'gamma', 'SKILL.md'), '---\nname: gamma\n---\n# Gamma v2\n');
  await execFileAsync('git', ['add', '-A'], { cwd: repoDir });
  await execFileAsync('git', ['commit', '-m', 'v1.1.0'], { cwd: repoDir });
  await execFileAsync('git', ['tag', 'v1.1.0'], { cwd: repoDir });
  return repoDir;
}

test('仓库元数据与 README 推断能正确区分 Skills 仓库、MCP 包与分端安装命令', () => {
  const readme = [
    '# Demo Tool',
    '## Claude Code',
    '```bash',
    'claude plugin install demo@marketplace',
    '```',
    '## Codex',
    '```bash',
    'codex mcp add demo -- npx -y demo-mcp',
    '```',
  ].join('\n');
  const extracted = extractInstallCommandsFromReadme(readme);
  assert.equal(extracted.perHarness['claude-code'], 'claude plugin install demo@marketplace');
  assert.equal(extracted.perHarness.codex, 'codex mcp add demo -- npx -y demo-mcp');

  const skillsDraft = inferPackageFromRepoMeta({
    slug: { owner: 'org', repo: 'my-skills' },
    repoUrl: 'https://github.com/org/my-skills',
    repoInfo: { name: 'my-skills', default_branch: 'main', description: 'Skills pack' },
    latestRelease: { tag_name: 'v2.0.0' },
    treePaths: ['README.md', 'skills/review/SKILL.md', 'skills/tdd/SKILL.md'],
  });
  assert.equal(skillsDraft.draft.kind, 'skills-repo');
  assert.equal(skillsDraft.draft.ref, 'v2.0.0');
  assert.deepEqual(skillsDraft.evidence.discoveredSkills, ['review', 'tdd']);

  const mcpDraft = inferPackageFromRepoMeta({
    slug: { owner: 'microsoft', repo: 'playwright-mcp' },
    repoUrl: 'https://github.com/microsoft/playwright-mcp',
    repoInfo: { name: 'playwright-mcp', default_branch: 'main' },
    latestRelease: { tag_name: 'v0.0.28' },
    treePaths: ['package.json', 'README.md'],
    packageJson: {
      name: '@playwright/mcp',
      version: '0.0.28',
      dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
      bin: { 'playwright-mcp': 'cli.js' },
    },
  });
  assert.equal(mcpDraft.draft.kind, 'mcp');
  assert.equal(mcpDraft.draft.npmPackage, '@playwright/mcp');
  assert.deepEqual(mcpDraft.draft.mcp.args, ['-y', '@playwright/mcp@{{version}}']);
});

test('Skills 仓库端到端：安装、保护非受管目录、版本升级清理旧软链与卸载', async t => {
  const base = await mkdtemp(join(tmpdir(), 'ap-e2e-skills-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const upstream = await createSampleSkillsRepo(base);
  const homeDir = join(base, 'home');
  const dshHome = join(homeDir, '.dsh');
  const root = join(dshHome, 'dsh-agent-packages');

  // 预先在 Codex 放一个非受管同名实体目录 alpha，验证不会被强行覆盖
  const unmanagedAlpha = join(homeDir, '.codex', 'skills', 'alpha');
  await mkdir(unmanagedAlpha, { recursive: true });
  await writeFile(join(unmanagedAlpha, 'KEEP.txt'), 'user-owned');

  const service = new PackageManagerService({ root, homeDir, dshHome });
  await service.init();

  const saved = await service.action({
    type: 'package.save',
    installNow: true,
    package: {
      id: 'sample-skills',
      name: 'Sample Skills',
      kind: 'skills-repo',
      repo: upstream,
      ref: 'v1.0.0',
      targets: ['codex', 'claude-code', 'antigravity', 'dsh'],
    },
  });

  // Codex alpha 保留用户实体目录，beta 正常软链
  assert.equal(await readFile(join(unmanagedAlpha, 'KEEP.txt'), 'utf8'), 'user-owned');
  assert.equal((await lstat(join(homeDir, '.codex', 'skills', 'beta'))).isSymbolicLink(), true);
  assert.equal((await lstat(join(homeDir, '.claude', 'skills', 'alpha'))).isSymbolicLink(), true);
  assert.equal((await lstat(join(homeDir, '.gemini', 'config', 'skills', 'alpha'))).isSymbolicLink(), true);
  assert.equal((await lstat(join(dshHome, 'skills', 'alpha'))).isSymbolicLink(), true);
  assert.equal(saved.state.packages[0].harnessStatuses['claude-code'].status, 'installed');

  // 升级到 v1.1.0：beta 自动清理，gamma 新增，用户实体 alpha 保持不动
  await service.action({
    type: 'package.upgrade',
    id: 'sample-skills',
    ref: 'v1.1.0',
  });
  await assert.rejects(() => lstat(join(homeDir, '.codex', 'skills', 'beta')));
  assert.equal((await lstat(join(homeDir, '.codex', 'skills', 'gamma'))).isSymbolicLink(), true);
  assert.equal(await readFile(join(unmanagedAlpha, 'KEEP.txt'), 'utf8'), 'user-owned');

  // 卸载：清理所有受管软链，不删用户实体 alpha
  await service.action({ type: 'package.uninstall', id: 'sample-skills' });
  await assert.rejects(() => lstat(join(homeDir, '.codex', 'skills', 'gamma')));
  await assert.rejects(() => lstat(join(homeDir, '.claude', 'skills', 'gamma')));
  assert.equal(await readFile(join(unmanagedAlpha, 'KEEP.txt'), 'utf8'), 'user-owned');
});

test('MCP 包与自定义安装器端到端：安装、检查更新、升级与本机只读诊断', async t => {
  const base = await mkdtemp(join(tmpdir(), 'ap-e2e-mcp-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const homeDir = join(base, 'home');
  const dshHome = join(homeDir, '.dsh');
  const root = join(dshHome, 'dsh-agent-packages');

  // 准备一个本机旧目录分叉 + 未纳管 MCP + 失效软链，验证只读扫描
  await mkdir(join(homeDir, '.gemini', 'skills', 'legacy-one'), { recursive: true });
  await mkdir(join(homeDir, '.gemini', 'config', 'skills'), { recursive: true });
  await symlink(join(base, 'missing-target'), join(homeDir, '.gemini', 'config', 'skills', 'broken-skill'));
  await mkdir(join(homeDir, '.codex'), { recursive: true });
  await writeFile(join(homeDir, '.codex', 'config.toml'), '[mcp_servers.existing_tool]\ncommand = "existing"\nargs = ["--stdio"]\n');

  const executedCommands = [];
  const mockFetch = async url => {
    if (String(url).includes('registry.npmjs.org')) {
      return { ok: true, json: async () => ({ version: '0.0.29' }) };
    }
    if (String(url).endsWith('/releases/latest')) {
      return { ok: true, json: async () => ({ tag_name: 'v0.0.29' }) };
    }
    if (String(url).includes('/commits/')) {
      return { ok: true, json: async () => ({ sha: 'abcdef1234567890abcdef1234567890abcdef12' }) };
    }
    return { ok: true, json: async () => ({ default_branch: 'main', name: 'playwright-mcp' }) };
  };

  const service = new PackageManagerService({
    root,
    homeDir,
    dshHome,
    fetchImpl: mockFetch,
    githubToken: '',
    runShell: async cmd => {
      executedCommands.push(cmd);
      return { stdout: `ran: ${cmd}`, stderr: '' };
    },
  });
  await service.init();

  // 1. 保存并安装 MCP 到 3 端
  await service.action({
    type: 'package.save',
    installNow: true,
    package: {
      id: 'playwright',
      name: 'Playwright MCP',
      kind: 'mcp',
      repo: 'https://github.com/microsoft/playwright-mcp',
      version: '0.0.28',
      npmPackage: '@playwright/mcp',
      targets: ['codex', 'claude-code', 'antigravity'],
      mcp: {
        serverName: 'playwright',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@playwright/mcp@{{version}}'],
        envRefs: ['HTTPS_PROXY'],
      },
    },
  });

  const codexServers = await readCodexMcpServers(join(homeDir, '.codex', 'config.toml'));
  assert.deepEqual(codexServers.playwright.args, ['-y', '@playwright/mcp@0.0.28']);
  assert.equal(codexServers.existing_tool.command, 'existing');
  const claudeServers = await readJsonMcpServers(join(homeDir, '.claude.json'));
  assert.deepEqual(claudeServers.playwright.args, ['-y', '@playwright/mcp@0.0.28']);
  const agyServers = await readJsonMcpServers(join(homeDir, '.gemini', 'config', 'mcp_config.json'));
  assert.deepEqual(agyServers.playwright.args, ['-y', '@playwright/mcp@0.0.28']);

  // 2. 检查更新并一键升级
  const checked = await service.action({ type: 'packages.checkUpdates' });
  assert.equal(checked.state.summary.outdated, 1);
  assert.equal(checked.state.packages[0].lock.latestVersion, '0.0.29');

  await service.action({ type: 'packages.upgradeAll' });
  const codexAfter = await readCodexMcpServers(join(homeDir, '.codex', 'config.toml'));
  assert.deepEqual(codexAfter.playwright.args, ['-y', '@playwright/mcp@0.0.29']);

  // 3. 保存并执行自定义安装器
  await service.action({
    type: 'package.save',
    installNow: true,
    package: {
      id: 'hindsight-cli',
      name: 'Hindsight',
      kind: 'installer',
      repo: 'https://github.com/example/hindsight',
      version: '1.0.0',
      targets: ['codex', 'claude-code'],
      commands: {
        codex: { install: 'echo install-codex-{{version}}', uninstall: 'echo uninstall-codex' },
        'claude-code': { install: 'echo install-claude-{{version}}' },
      },
    },
  });
  assert.deepEqual(executedCommands, ['echo install-codex-1.0.0', 'echo install-claude-1.0.0']);

  // 4. 本机只读诊断；已移除本机导入，包只能通过添加进入清单
  const scan = await service.action({ type: 'local.scan' });
  assert.ok(scan.report.warnings.some(w => w.kind === 'legacy-dir'));
  assert.ok(scan.report.warnings.some(w => w.kind === 'broken-symlink'));
  assert.equal(scan.report.harnesses.codex.mcpServers.find(m => m.serverName === 'existing_tool').managedBy, null);
  assert.equal(scan.report.importCandidates, undefined);
  await assert.rejects(service.action({ type: 'local.import', draft: {} }), { status: 400 });

  // 5. MCP 不支持 DSH 原生：前置检查直接拒绝保存
  await assert.rejects(
    service.action({ type: 'package.save', package: { name: 'Playwright MCP', kind: 'mcp', repo: 'https://github.com/microsoft/playwright-mcp', targets: ['dsh'] } }),
    { status: 400, message: /前置检查未通过：DSH 原生没有可写入的 MCP 配置文件/ },
  );
});

test('HTTP API 强制校验会话令牌并拒绝未授权 POST', async t => {
  const base = await mkdtemp(join(tmpdir(), 'ap-api-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const service = new PackageManagerService({ root: join(base, 'root'), homeDir: join(base, 'home') });
  await service.init();

  const handler = apiHandler(service);
  const server = createServer((req, res) => {
    if (req.url === ENDPOINT) return void handler(req, res);
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}${ENDPOINT}`;

  const getRes = await fetch(url);
  assert.equal(getRes.status, 200);
  const data = await getRes.json();
  assert.ok(data.key);

  const badPost = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'local.scan' }),
  });
  assert.equal(badPost.status, 403);

  const okPost = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [HEADER_KEY]: data.key },
    body: JSON.stringify({ type: 'local.scan' }),
  });
  assert.equal(okPost.status, 200);
  const okBody = await okPost.json();
  assert.ok(okBody.report);
});

test('插件仓库（如 ponytail）识别为 plugin 类型，提取插件名、市场名与安装时注册的 Hooks', () => {
  const treePaths = [
    '.claude-plugin/marketplace.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json',
    'hooks/claude-codex-hooks.json', 'hooks/claude-band.json', 'skills/ponytail/SKILL.md', 'README.md',
  ];
  const pluginManifests = {
    '.claude-plugin/marketplace.json': { name: 'ponytail', plugins: [{ name: 'ponytail', source: './' }] },
    '.claude-plugin/plugin.json': { name: 'ponytail', version: '5.3.3', hooks: ['./hooks/claude-codex-hooks.json', './hooks/claude-band.json'] },
    '.codex-plugin/plugin.json': { name: 'ponytail', version: '5.3.3', hooks: './hooks/claude-codex-hooks.json' },
  };
  assert.deepEqual(pluginHookPaths(pluginManifests, treePaths), ['hooks/claude-codex-hooks.json', 'hooks/claude-band.json']);

  const { draft, evidence } = inferPackageFromRepoMeta({
    slug: { owner: 'DietrichGebert', repo: 'ponytail' },
    repoUrl: 'https://github.com/DietrichGebert/ponytail',
    repoInfo: { name: 'ponytail', default_branch: 'main' },
    latestRelease: { tag_name: 'v5.3.3' },
    treePaths,
    readme: '## Codex\n```bash\ncodex plugin marketplace add DietrichGebert/ponytail\ncodex plugin add ponytail@ponytail\n```\n',
    pluginManifests,
    hookFiles: {
      'hooks/claude-codex-hooks.json': { hooks: { SessionStart: [{ hooks: [] }], UserPromptSubmit: [{ hooks: [] }] } },
      'hooks/claude-band.json': { hooks: {} },
    },
  });
  assert.equal(draft.kind, 'plugin');
  assert.deepEqual(draft.plugin, { name: 'ponytail', marketplace: 'ponytail', harnesses: ['codex', 'claude-code', 'antigravity'] });
  assert.deepEqual(draft.targets, ['codex', 'claude-code', 'antigravity']);
  assert.deepEqual(draft.commands, {}, 'README 中不完整的单行命令不能覆盖插件适配器');
  assert.equal(draft.version, '5.3.3');
  assert.deepEqual(evidence.plugin.hookEvents, ['SessionStart', 'UserPromptSubmit']);
});

test('插件端到端：添加时重命名与前置检查、幂等安装、读回版本与卸载', async t => {
  const base = await mkdtemp(join(tmpdir(), 'ap-plugin-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const homeDir = join(base, 'home');
  const claudeConfigDir = join(base, 'claude-config');
  const claudePlugins = join(claudeConfigDir, 'plugins');
  await mkdir(claudePlugins, { recursive: true });
  await writeFile(join(claudePlugins, 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'other@other-market': [{ scope: 'user', version: '2.0.0' }] },
  }));
  await writeFile(join(claudePlugins, 'known_marketplaces.json'), JSON.stringify({
    'other-market': { source: { source: 'github', repo: 'acme/other' } },
  }));

  // 模拟 Harness CLI：执行后写入各端自己的插件记录，供读回版本、幂等判断与扫描
  const executed = [];
  const runShell = async command => {
    executed.push(command);
    if (command.includes('claude plugin install ponytail@ponytail')) {
      const installed = JSON.parse(await readFile(join(claudePlugins, 'installed_plugins.json'), 'utf8'));
      installed.plugins['ponytail@ponytail'] = [{ scope: 'user', version: '5.3.3' }];
      await writeFile(join(claudePlugins, 'installed_plugins.json'), JSON.stringify(installed));
      const known = JSON.parse(await readFile(join(claudePlugins, 'known_marketplaces.json'), 'utf8'));
      known.ponytail = { source: { source: 'github', repo: 'DietrichGebert/ponytail' } };
      await writeFile(join(claudePlugins, 'known_marketplaces.json'), JSON.stringify(known));
    }
    if (command.includes('codex plugin add ponytail@ponytail')) {
      await mkdir(join(homeDir, '.codex'), { recursive: true });
      await writeFile(join(homeDir, '.codex', 'config.toml'), '[marketplaces.ponytail]\nsource = "https://github.com/DietrichGebert/ponytail"\n\n[plugins."ponytail@ponytail"]\nenabled = true\n');
    }
    if (command.startsWith('agy plugin install')) {
      await mkdir(join(homeDir, '.gemini', 'config', 'plugins', 'ponytail'), { recursive: true });
    }
    return { stdout: 'ok', stderr: '' };
  };
  const service = new PackageManagerService({ root: join(base, 'root'), homeDir, dshHome: join(homeDir, '.dsh'), claudeConfigDir, runShell });
  await service.init();

  // 解析仓库得到的草稿：包 ID 留空，名称改成自定义名称
  const ponytail = {
    name: 'Lazy Dev',
    kind: 'plugin',
    repo: 'https://github.com/DietrichGebert/ponytail',
    ref: 'v5.3.3',
    version: '5.3.3',
    targets: ['codex', 'claude-code', 'antigravity'],
    plugin: { name: 'ponytail', marketplace: 'ponytail', harnesses: ['codex', 'claude-code', 'antigravity'] },
  };

  // 前置检查：DSH 无插件机制、仓库没有该端插件清单时拒绝保存，不写清单
  await assert.rejects(
    service.action({ type: 'package.save', installNow: true, package: { ...ponytail, targets: [...ponytail.targets, 'dsh'] } }),
    { status: 400, message: /前置检查未通过：DSH 原生暂无插件机制/ },
  );
  await assert.rejects(
    service.action({ type: 'package.save', package: { ...ponytail, plugin: { ...ponytail.plugin, harnesses: ['claude-code'] } } }),
    { status: 400, message: /Codex仓库没有该端可用的插件清单/ },
  );
  assert.deepEqual(executed, []);
  assert.equal((await service.state()).packages.length, 0);

  const saved = await service.action({ type: 'package.save', installNow: true, package: ponytail });
  assert.equal(saved.package.id, 'lazy-dev', '包 ID 留空时按重命名后的名称生成');
  assert.deepEqual(executed, [
    "codex plugin marketplace add 'DietrichGebert/ponytail' && codex plugin add ponytail@ponytail",
    "claude plugin marketplace add 'DietrichGebert/ponytail' && claude plugin install ponytail@ponytail",
    "agy plugin install 'https://github.com/DietrichGebert/ponytail'",
  ], '重命名不影响各端插件标识');
  assert.ok(saved.steps.find(step => step.harness === 'codex').warnings.some(w => w.includes('/hooks')));
  const statuses = saved.state.packages[0].harnessStatuses;
  assert.equal(statuses['claude-code'].status, 'installed');
  assert.equal(statuses['claude-code'].installedVersion, '5.3.3');
  assert.equal(statuses.dsh.status, 'unselected');

  // 幂等：同一插件换个名称再次添加，只更新原条目（可重命名），已装各端不重复执行任何命令
  executed.length = 0;
  // 重复添加时解析到更新的版本：只采用新名称与目标端，原条目的锁定版本不被覆盖，升级仍走「升级」
  const again = await service.action({ type: 'package.save', installNow: true, package: { ...ponytail, name: 'Ponytail', ref: 'v5.4.0', version: '5.4.0' } });
  assert.deepEqual(executed, []);
  assert.match(again.message, /已在清单中/);
  assert.deepEqual(again.state.packages.map(p => [p.id, p.name, p.version, p.ref]), [['lazy-dev', 'Ponytail', '5.3.3', 'v5.3.3']]);
  assert.ok(again.steps.every(step => step.status === 'ok' && step.detail.includes('无需重复安装')));
  await service.action({ type: 'packages.syncAll' });
  assert.deepEqual(executed, []);

  // 自定义安装命令同样受已安装判断约束
  await service.action({
    type: 'package.save',
    originalId: 'lazy-dev',
    package: { ...ponytail, id: 'lazy-dev', commands: { 'claude-code': { install: 'echo custom-install' } } },
  });
  await service.action({ type: 'package.install', id: 'lazy-dev', harnesses: ['claude-code'] });
  assert.deepEqual(executed, []);

  // 其他来源占用同一包 ID 时提示重命名
  await assert.rejects(
    service.action({ type: 'package.save', package: { ...ponytail, id: 'lazy-dev', repo: 'https://github.com/acme/other', plugin: { name: 'other', marketplace: 'other-market' } } }),
    { status: 409, message: /请重命名/ },
  );

  const scan = await service.action({ type: 'local.scan' });
  assert.equal(scan.report.harnesses['claude-code'].plugins.find(p => p.name === 'ponytail').managedBy, 'lazy-dev');
  assert.equal(scan.report.harnesses['claude-code'].plugins.find(p => p.name === 'other').managedBy, null);

  // 升级才刷新市场并更新
  await service.action({ type: 'package.upgrade', id: 'lazy-dev', harnesses: ['codex'] });
  assert.deepEqual(executed, ['codex plugin marketplace upgrade ponytail && codex plugin add ponytail@ponytail']);

  executed.length = 0;
  const removed = await service.action({ type: 'package.uninstall', id: 'lazy-dev', harnesses: ['codex', 'antigravity'] });
  assert.deepEqual(executed, ['codex plugin remove ponytail@ponytail', 'agy plugin uninstall ponytail']);
  assert.equal(removed.state.packages[0].harnessStatuses.codex.status, 'uninstalled');
});

test('Claude Code 命令配置为 reclaude：按其账号配置目录判断已装，插件命令经 reclaude 执行', async t => {
  const base = await mkdtemp(join(tmpdir(), 'ap-reclaude-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const homeDir = join(base, 'home');
  const dataDir = join(base, 'rec-data');
  const accountPlugins = join(dataDir, 'claude', 'accounts', '1001', 'config', 'plugins');
  await mkdir(accountPlugins, { recursive: true });
  await writeFile(join(accountPlugins, 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'ponytail@ponytail': [{ scope: 'user', version: '5.3.3' }] },
  }));
  await writeFile(join(accountPlugins, 'known_marketplaces.json'), JSON.stringify({
    ponytail: { source: { source: 'github', repo: 'DietrichGebert/ponytail' } },
  }));

  const probes = [];
  let probeFails = false;
  const execImpl = async (file, args) => {
    probes.push([file, ...args].join(' '));
    if (file === 'reclaude' && args.join(' ') === 'status --json' && !probeFails) {
      return { stdout: JSON.stringify({ global: { data_dir: dataDir }, claude: { current: { device_id: 1001 } } }), stderr: '' };
    }
    throw new Error(`unexpected exec ${file}`);
  };
  const executed = [];
  const runShell = async command => { executed.push(command); return { stdout: 'ok', stderr: '' }; };
  let claudeCommand = 'reclaude';
  const service = new PackageManagerService({ root: join(base, 'root'), homeDir, dshHome: join(homeDir, '.dsh'), claudeCommand: () => claudeCommand, execImpl, runShell });
  await service.init();

  const ponytail = {
    name: 'ponytail',
    kind: 'plugin',
    repo: 'https://github.com/DietrichGebert/ponytail',
    targets: ['claude-code'],
    plugin: { name: 'ponytail', marketplace: 'ponytail', harnesses: ['claude-code'] },
  };
  // 已装在 reclaude 账号目录：不再执行安装命令，默认 ~/.claude 不会多装一份
  const saved = await service.action({ type: 'package.save', installNow: true, package: ponytail });
  assert.deepEqual(executed, []);
  assert.match(saved.steps[0].detail, /已安装 5\.3\.3，无需重复安装/);
  assert.ok(probes.includes('reclaude status --json'));

  const scan = await service.action({ type: 'local.scan' });
  const accountConfigDir = join(dataDir, 'claude', 'accounts', '1001', 'config');
  assert.equal(scan.report.harnesses['claude-code'].plugins.find(p => p.name === 'ponytail').managedBy, 'ponytail');
  assert.equal(scan.report.harnesses['claude-code'].skillsDir, join(accountConfigDir, 'skills'));
  assert.equal(scan.report.harnesses['claude-code'].mcpFile, join(accountConfigDir, '.claude.json'));

  // 插件命令使用 reclaude，市场已在该账号登记时只刷新市场
  await service.action({ type: 'package.upgrade', id: 'ponytail', harnesses: ['claude-code'] });
  await service.action({ type: 'package.uninstall', id: 'ponytail', harnesses: ['claude-code'] });
  assert.deepEqual(executed, [
    'reclaude plugin marketplace update ponytail && reclaude plugin update ponytail@ponytail',
    'reclaude plugin uninstall ponytail@ponytail',
  ]);

  // 账号目录未登记该插件市场时，经 reclaude 添加市场并安装
  await writeFile(join(accountPlugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {} }));
  await writeFile(join(accountPlugins, 'known_marketplaces.json'), '{}');
  executed.length = 0;
  await service.action({ type: 'package.install', id: 'ponytail', harnesses: ['claude-code'] });
  assert.deepEqual(executed, ["reclaude plugin marketplace add 'DietrichGebert/ponytail' && reclaude plugin install ponytail@ponytail"]);

  // reclaude 状态探测失败：命令仍用 reclaude，已装判断保持默认配置目录（此处为空）
  probeFails = true;
  await writeFile(join(accountPlugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'ponytail@ponytail': [{ scope: 'user', version: '5.3.3' }] } }));
  executed.length = 0;
  await service.action({ type: 'package.install', id: 'ponytail', harnesses: ['claude-code'] });
  assert.deepEqual(executed, ["reclaude plugin marketplace add 'DietrichGebert/ponytail' && reclaude plugin install ponytail@ponytail"]);
  probeFails = false;

  // 设置改回空值后回落到 claude 与默认配置目录（此处为空），按未安装执行 claude 命令
  claudeCommand = '';
  executed.length = 0;
  await service.action({ type: 'package.install', id: 'ponytail', harnesses: ['claude-code'] });
  assert.deepEqual(executed, ["claude plugin marketplace add 'DietrichGebert/ponytail' && claude plugin install ponytail@ponytail"]);
  const defaultState = await service.state();
  const defaultClaude = defaultState.harnesses.find(h => h.id === 'claude-code');
  assert.equal(defaultClaude.skillsDir, join(homeDir, '.claude', 'skills'));
  assert.equal(defaultClaude.mcpFile, join(homeDir, '.claude.json'));
});

test('dsh-harness-provider 显式配置 claudeConfigDir：优先级高于 reclaude 探测，统一对齐 skills、.claude.json 与 CLAUDE_CONFIG_DIR', async t => {
  const base = await mkdtemp(join(tmpdir(), 'ap-claude-dir-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const upstream = await createSampleSkillsRepo(base);
  const homeDir = join(base, 'home');
  const dshHome = join(homeDir, '.dsh');
  const expectedConfigDir = join(homeDir, '.rec', 'claude', 'accounts', '2048', 'config');

  let probeCount = 0;
  const execImpl = async (file, args, options) => {
    if (file === 'reclaude') {
      probeCount++;
      throw new Error('显式配置 claudeConfigDir 时不应探测 reclaude');
    }
    return execFileAsync(file, args, options);
  };
  const shellCalls = [];
  const runShell = async (command, options) => {
    shellCalls.push({ command, claudeConfigDir: options?.env?.CLAUDE_CONFIG_DIR });
    return { stdout: 'ok', stderr: '' };
  };

  let configuredDir = '~/.rec/claude/accounts/2048/config';
  const service = new PackageManagerService({
    root: join(base, 'root'),
    homeDir,
    dshHome,
    claudeCommand: () => 'reclaude',
    claudeConfigDir: () => configuredDir,
    execImpl,
    runShell,
  });
  await service.init();

  // 1. state 与 local.scan 均反映展开后的配置目录，且不触发 reclaude 探测
  const state = await service.state();
  const claudeHarness = state.harnesses.find(h => h.id === 'claude-code');
  assert.equal(claudeHarness.skillsDir, join(expectedConfigDir, 'skills'));
  assert.equal(claudeHarness.mcpFile, join(expectedConfigDir, '.claude.json'));
  assert.equal(probeCount, 0);

  // 2. 安装 Skills 到 <claudeConfigDir>/skills，不落到默认 ~/.claude/skills
  await service.action({
    type: 'package.save',
    installNow: true,
    package: {
      id: 'dir-skills',
      name: 'Dir Skills',
      kind: 'skills-repo',
      repo: upstream,
      ref: 'v1.0.0',
      targets: ['claude-code'],
    },
  });
  assert.equal((await lstat(join(expectedConfigDir, 'skills', 'alpha'))).isSymbolicLink(), true);
  await assert.rejects(() => lstat(join(homeDir, '.claude', 'skills', 'alpha')));

  // 3. 安装 MCP 到 <claudeConfigDir>/.claude.json，不落到默认 ~/.claude.json
  await service.action({
    type: 'package.save',
    installNow: true,
    package: {
      id: 'dir-mcp',
      name: 'Dir MCP',
      kind: 'mcp',
      repo: 'https://github.com/example/dir-mcp',
      version: '1.2.3',
      targets: ['claude-code'],
      mcp: { serverName: 'dir-mcp', transport: 'stdio', command: 'npx', args: ['-y', 'dir-mcp@{{version}}'] },
    },
  });
  const mcpServers = await readJsonMcpServers(join(expectedConfigDir, '.claude.json'));
  assert.deepEqual(mcpServers['dir-mcp'].args, ['-y', 'dir-mcp@1.2.3']);
  await assert.rejects(() => lstat(join(homeDir, '.claude.json')));

  // 4. 插件与自定义命令仅对 claude-code 透传 CLAUDE_CONFIG_DIR，不影响 codex
  await service.action({
    type: 'package.save',
    installNow: true,
    package: {
      id: 'dir-installer',
      name: 'Dir Installer',
      kind: 'installer',
      repo: 'https://github.com/example/dir-installer',
      targets: ['codex', 'claude-code'],
      commands: {
        codex: { install: 'echo codex-install' },
        'claude-code': { install: 'echo claude-install' },
      },
    },
  });
  assert.deepEqual(shellCalls, [
    { command: 'echo codex-install', claudeConfigDir: undefined },
    { command: 'echo claude-install', claudeConfigDir: expectedConfigDir },
  ]);
  assert.equal(probeCount, 0);

  // 5. 动态清空配置后立即回落
  configuredDir = '';
  const fallbackService = new PackageManagerService({
    root: join(base, 'root2'),
    homeDir,
    dshHome,
    claudeConfigDir: () => configuredDir,
  });
  await fallbackService.init();
  const fallbackClaude = (await fallbackService.state()).harnesses.find(h => h.id === 'claude-code');
  assert.equal(fallbackClaude.skillsDir, join(homeDir, '.claude', 'skills'));
  assert.equal(fallbackClaude.mcpFile, join(homeDir, '.claude.json'));
});

test('读取 harness-provider 的 claudeCommand 与 claudeConfigDir：缺少设置服务或读取出错时回落为空', async () => {
  const { readHarnessClaudeCommand, readHarnessClaudeConfigDir } = await import('../src/claude-command.mjs');
  const settings = rows => () => ({ describe: () => rows });
  assert.equal(readHarnessClaudeCommand(settings([{ ns: 'harness-plugin', value: { claudeCommand: ' reclaude ' } }])), 'reclaude');
  assert.equal(readHarnessClaudeCommand(settings([{ ns: 'other', value: { claudeCommand: 'x' } }])), '');
  assert.equal(readHarnessClaudeCommand(settings([{ ns: 'harness-plugin', value: { claudeCommand: 1 } }])), '');
  assert.equal(readHarnessClaudeCommand(() => undefined), '');
  assert.equal(readHarnessClaudeCommand(() => { throw new Error('no settings'); }), '');

  assert.equal(
    readHarnessClaudeConfigDir(settings([{ ns: 'harness-plugin', value: { claudeConfigDir: ' ~/.rec/claude/accounts/1001/config ' } }])),
    '~/.rec/claude/accounts/1001/config',
  );
  assert.equal(readHarnessClaudeConfigDir(settings([{ ns: 'other', value: { claudeConfigDir: '/tmp/x' } }])), '');
  assert.equal(readHarnessClaudeConfigDir(settings([{ ns: 'harness-plugin', value: { claudeConfigDir: null } }])), '');
  assert.equal(readHarnessClaudeConfigDir(() => undefined), '');
  assert.equal(readHarnessClaudeConfigDir(() => { throw new Error('no settings'); }), '');
});

test('版本展示摘要：统一格式化语义版本、分支+提交、多端版本不一致与更新对比', () => {
  assert.equal(formatVersion('5.3.3'), 'v5.3.3');
  assert.equal(formatVersion('v1.4.0'), 'v1.4.0');
  assert.equal(formatVersion('abcdef1234567890abcdef1234567890abcdef12'), 'abcdef1');
  assert.equal(formatVersion('main'), 'main');

  assert.equal(formatHarnessVersion({ status: 'installed', installedVersion: '5.3.3', installedCommit: '' }), 'v5.3.3');
  assert.equal(formatHarnessVersion({ status: 'installed', installedVersion: 'main', installedCommit: 'abcdef1234567890' }), 'main (abcdef1)');
  assert.equal(formatHarnessVersion({ status: 'not-installed', installedVersion: '5.3.3' }), '');

  const uniform = summarizePackageVersions({
    version: '',
    ref: '',
    lock: { resolvedVersion: '5.3.3', latestVersion: '5.3.3', updateAvailable: false, checkedAt: '2026-11-26T00:00:00Z' },
    harnessStatuses: {
      codex: { status: 'installed', installedVersion: '5.3.3' },
      'claude-code': { status: 'installed', installedVersion: '5.3.3' },
      antigravity: { status: 'installed', installedVersion: '5.3.3' },
      dsh: { status: 'unselected' },
    },
  });
  assert.equal(uniform.currentLabel, 'v5.3.3');
  assert.equal(uniform.mixedVersions, false);
  assert.equal(uniform.hasUpdate, false);
  assert.equal(uniform.isUpToDate, true);

  const mixed = summarizePackageVersions({
    version: '',
    ref: '',
    lock: { latestVersion: '5.4.0', updateAvailable: true },
    harnessStatuses: {
      codex: { status: 'installed', installedVersion: '5.3.2' },
      'claude-code': { status: 'installed', installedVersion: '5.3.3' },
      antigravity: { status: 'not-installed' },
      dsh: { status: 'unselected' },
    },
  });
  assert.equal(mixed.currentLabel, 'v5.3.2 / v5.3.3');
  assert.equal(mixed.mixedVersions, true);
  assert.equal(mixed.hasUpdate, true);
  assert.equal(mixed.latestLabel, 'v5.4.0');
});

test('未锁定版本的插件也能从本机各端实时读回版本号并参与更新检查', async t => {
  const base = await mkdtemp(join(tmpdir(), 'ap-live-ver-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const homeDir = join(base, 'home');
  const claudePlugins = join(homeDir, '.claude', 'plugins');
  await mkdir(claudePlugins, { recursive: true });
  await writeFile(join(claudePlugins, 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'ponytail@ponytail': [{ scope: 'user', version: '5.3.3' }] },
  }));
  await writeFile(join(claudePlugins, 'known_marketplaces.json'), JSON.stringify({
    ponytail: { source: { source: 'github', repo: 'DietrichGebert/ponytail' } },
  }));

  // Codex 缓存目录名为 local，真实版本号在 .codex-plugin/plugin.json 内
  const codexCache = join(homeDir, '.codex', 'plugins', 'cache', 'ponytail', 'ponytail', 'local', '.codex-plugin');
  await mkdir(codexCache, { recursive: true });
  await writeFile(join(homeDir, '.codex', 'config.toml'), '[marketplaces.ponytail]\nsource = "https://github.com/DietrichGebert/ponytail"\n\n[plugins."ponytail@ponytail"]\nenabled = true\n');
  await writeFile(join(codexCache, 'plugin.json'), JSON.stringify({ name: 'ponytail', version: '5.3.2' }));

  const agyPlugin = join(homeDir, '.gemini', 'config', 'plugins', 'ponytail', '.claude-plugin');
  await mkdir(agyPlugin, { recursive: true });
  await writeFile(join(agyPlugin, 'plugin.json'), JSON.stringify({ name: 'ponytail', version: '5.3.3' }));

  // 远端无 Release，只有默认分支 .claude-plugin/plugin.json 标明 5.4.0
  const mockFetch = async url => {
    const u = String(url);
    if (u.endsWith('/repos/DietrichGebert/ponytail')) return { ok: true, json: async () => ({ default_branch: 'main', name: 'ponytail' }) };
    if (u.endsWith('/releases/latest')) return { ok: false, status: 404, json: async () => ({}) };
    if (u.includes('/commits/main')) return { ok: true, json: async () => ({ sha: '1234567890abcdef1234567890abcdef12345678' }) };
    if (u.endsWith('/.claude-plugin/plugin.json')) return { ok: true, text: async () => JSON.stringify({ name: 'ponytail', version: '5.4.0' }) };
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };

  const service = new PackageManagerService({
    root: join(base, 'root'),
    homeDir,
    dshHome: join(homeDir, '.dsh'),
    fetchImpl: mockFetch,
    githubToken: '',
    runShell: async () => ({ stdout: 'ok', stderr: '' }),
  });
  await service.init();

  const saved = await service.action({
    type: 'package.save',
    installNow: true,
    package: {
      id: 'ponytail',
      name: 'ponytail',
      kind: 'plugin',
      repo: 'https://github.com/DietrichGebert/ponytail',
      targets: ['codex', 'claude-code', 'antigravity'],
      plugin: { name: 'ponytail', marketplace: 'ponytail', harnesses: ['codex', 'claude-code', 'antigravity'] },
    },
  });

  const pkg = saved.state.packages[0];
  assert.equal(pkg.harnessStatuses.codex.installedVersion, '5.3.2');
  assert.equal(pkg.harnessStatuses['claude-code'].installedVersion, '5.3.3');
  assert.equal(pkg.harnessStatuses.antigravity.installedVersion, '5.3.3');
  assert.ok(pkg.lock.resolvedVersion, '安装回写时应记录读回的版本号');

  const checked = await service.action({ type: 'packages.checkUpdates', ids: ['ponytail'] });
  const after = checked.state.packages[0];
  assert.equal(after.lock.latestVersion, '5.4.0');
  assert.equal(after.lock.updateAvailable, true);
});

test('自带 CLI 与多端安装器的仓库（如 codegraph）：不误判开发自用 .claude/skills，自动生成全局与分端命令', () => {
  const codegraphReadme = [
    '# CodeGraph',
    'Already installed? Run `codegraph upgrade`',
    '## Get Started',
    '### 1. Install the CLI',
    '```bash',
    'curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh',
    '```',
    '<details>',
    '```bash',
    'npm i -g @colbymchenry/codegraph',
    '```',
    '</details>',
    '### 2. Wire up your agent(s)',
    '```bash',
    'codegraph install',
    '```',
    '### Uninstall',
    '```bash',
    'codegraph uninstall',
    '```',
    'Pass `--keep-cli` to remove only the agent configurations and keep the CLI installed.',
    'Use `--target` to remove from specific agents, or `--yes` to run non-interactively.',
    '## CLI Reference',
    '```bash',
    'codegraph upgrade [version]  # Update to the latest release',
    'codegraph version            # Print installed version',
    '```',
    '## Supported Agents',
    '- **Claude Code**',
    '- **Codex CLI**',
    '- **Antigravity IDE**',
    '- **DeepSeek Harness** (`dsh`)',
  ].join('\n');

  const { draft, evidence } = inferPackageFromRepoMeta({
    slug: { owner: 'colbymchenry', repo: 'codegraph' },
    repoUrl: 'https://github.com/colbymchenry/codegraph',
    repoInfo: { name: 'codegraph', default_branch: 'main', description: 'Semantic code intelligence' },
    latestRelease: { tag_name: 'v1.6.4' },
    treePaths: [
      'README.md',
      'package.json',
      'install.sh',
      '.claude/skills/add-lang/SKILL.md',
      '.claude/skills/agent-eval/SKILL.md',
      'src/installer/targets/claude.ts',
      'src/installer/targets/codex.ts',
      'src/installer/targets/antigravity.ts',
      'src/installer/targets/dsh.ts',
    ],
    packageJson: {
      name: '@colbymchenry/codegraph',
      version: '1.6.4',
      bin: { codegraph: './dist/bin/codegraph.js' },
      dependencies: { commander: '^14.0.0' },
    },
    readme: codegraphReadme,
  });

  assert.equal(draft.kind, 'installer');
  assert.equal(draft.npmPackage, '@colbymchenry/codegraph');
  assert.equal(draft.version, '1.6.4');
  assert.equal(draft.ref, 'v1.6.4');
  assert.deepEqual(evidence.discoveredSkills, [], 'CLI 工具仓库自用的 .claude/skills 不应误判为对外分发 Skills');
  assert.equal(evidence.cliBin, 'codegraph');
  assert.equal(evidence.npmPackage, '@colbymchenry/codegraph');
  assert.deepEqual(draft.targets, ['codex', 'claude-code', 'antigravity', 'dsh']);
  assert.deepEqual(draft.commands.shared, {
    install: 'curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh',
    upgrade: 'codegraph upgrade {{version}}',
    uninstall: 'codegraph uninstall --yes',
    version: 'codegraph --version',
  });
  assert.deepEqual(draft.commands.codex, {
    install: 'codegraph install --target codex --yes',
    uninstall: 'codegraph uninstall --target codex --yes --keep-cli',
  });
  assert.deepEqual(draft.commands['claude-code'], {
    install: 'codegraph install --target claude --yes',
    uninstall: 'codegraph uninstall --target claude --yes --keep-cli',
  });
  assert.deepEqual(draft.commands.antigravity, {
    install: 'codegraph install --target antigravity --yes',
    uninstall: 'codegraph uninstall --target antigravity --yes --keep-cli',
  });
  assert.deepEqual(draft.commands.dsh, {
    install: 'codegraph install --target dsh --yes',
    uninstall: 'codegraph uninstall --target dsh --yes --keep-cli',
  });

  // 通用无 --target 拆端的 CLI 安装器：合并进全局命令，避免重复跑多遍
  const globalOnly = inferPackageFromRepoMeta({
    slug: { owner: 'acme', repo: 'agent-kit' },
    repoUrl: 'https://github.com/acme/agent-kit',
    repoInfo: { name: 'agent-kit', default_branch: 'main' },
    latestRelease: { tag_name: 'v0.3.0' },
    treePaths: ['README.md', 'package.json', '.claude/skills/internal-helper/SKILL.md'],
    packageJson: { name: 'agent-kit', version: '0.3.0', bin: { 'agent-kit': './cli.js' } },
    readme: '# Agent Kit\n```bash\nnpm i -g agent-kit\nagent-kit setup\n```\nSupports Claude Code and Codex.\n',
  });
  assert.equal(globalOnly.draft.kind, 'installer');
  assert.equal(globalOnly.draft.commands.shared.install, 'npm i -g agent-kit && agent-kit setup');
  assert.equal(globalOnly.draft.commands.shared.version, 'agent-kit --version');
  assert.deepEqual(globalOnly.draft.targets, ['codex', 'claude-code']);

  // 非 CLI 项目的纯 .claude/skills 仓库仍可兼容识别为 skills-repo
  const pureHiddenSkills = inferPackageFromRepoMeta({
    slug: { owner: 'user', repo: 'claude-skills' },
    repoUrl: 'https://github.com/user/claude-skills',
    repoInfo: { name: 'claude-skills', default_branch: 'main' },
    treePaths: ['README.md', '.claude/skills/my-skill/SKILL.md'],
  });
  assert.equal(pureHiddenSkills.draft.kind, 'skills-repo');
  assert.deepEqual(pureHiddenSkills.evidence.discoveredSkills, ['my-skill']);
});

test('带全局 CLI 命令的安装器端到端：全局命令只跑一次、版本探测、升级、单端/全端卸载与失败短路', async t => {
  const base = await mkdtemp(join(tmpdir(), 'ap-cli-installer-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const homeDir = join(base, 'home');
  const dshHome = join(homeDir, '.dsh');
  const claudeConfigDir = join(homeDir, '.rec', 'claude', 'accounts', '3001', 'config');

  let currentCliVersion = '1.5.0';
  let failShared = false;
  const calls = [];
  const runShell = async (command, options) => {
    calls.push({ command, claudeConfigDir: options?.env?.CLAUDE_CONFIG_DIR });
    if (command === 'codegraph --version') return { stdout: `${currentCliVersion}\n`, stderr: '' };
    if (failShared && command.includes('install.sh')) throw new Error('network error');
    if (command.startsWith('codegraph upgrade ')) currentCliVersion = command.split(/\s+/).pop();
    return { stdout: 'ok', stderr: '' };
  };
  const mockFetch = async url => {
    const u = String(url);
    if (u.includes('registry.npmjs.org')) return { ok: true, json: async () => ({ version: '1.6.4' }) };
    if (u.endsWith('/releases/latest')) return { ok: true, json: async () => ({ tag_name: 'v1.6.4' }) };
    if (u.includes('/commits/')) return { ok: true, json: async () => ({ sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }) };
    return { ok: true, json: async () => ({ default_branch: 'main', name: 'codegraph' }) };
  };

  const service = new PackageManagerService({
    root: join(base, 'root'),
    homeDir,
    dshHome,
    claudeConfigDir,
    fetchImpl: mockFetch,
    githubToken: '',
    runShell,
  });
  await service.init();

  const pkgDef = {
    name: 'codegraph',
    kind: 'installer',
    repo: 'https://github.com/colbymchenry/codegraph',
    ref: 'v1.5.0',
    version: '1.5.0',
    npmPackage: '@colbymchenry/codegraph',
    targets: ['codex', 'claude-code', 'dsh'],
    commands: {
      shared: {
        install: 'curl -fsSL https://example.com/install.sh | sh',
        upgrade: 'codegraph upgrade {{version}}',
        uninstall: 'codegraph uninstall --yes',
        version: 'codegraph --version',
      },
      codex: {
        install: 'codegraph install --target codex --yes',
        uninstall: 'codegraph uninstall --target codex --yes --keep-cli',
      },
      'claude-code': {
        install: 'codegraph install --target claude --yes',
        uninstall: 'codegraph uninstall --target claude --yes --keep-cli',
      },
      dsh: {
        install: 'codegraph install --target dsh --yes',
        uninstall: 'codegraph uninstall --target dsh --yes --keep-cli',
      },
    },
  };

  // 1. Dry-run 预览不执行真实命令
  const preview = await service.action({ type: 'package.save', installNow: true, dryRun: true, package: pkgDef });
  assert.deepEqual(calls, []);
  assert.deepEqual(preview.steps.map(s => [s.harness, s.status]), [
    ['shared', 'preview'],
    ['codex', 'preview'],
    ['claude-code', 'preview'],
    ['dsh', 'preview'],
  ]);

  // 2. 实际安装：全局脚本只执行 1 次，claude-code 透传 CLAUDE_CONFIG_DIR，并探测回写 1.5.0
  const installed = await service.action({ type: 'package.install', id: 'codegraph' });
  assert.deepEqual(calls, [
    { command: 'curl -fsSL https://example.com/install.sh | sh', claudeConfigDir: undefined },
    { command: 'codegraph install --target codex --yes', claudeConfigDir: undefined },
    { command: 'codegraph install --target claude --yes', claudeConfigDir },
    { command: 'codegraph install --target dsh --yes', claudeConfigDir: undefined },
    { command: 'codegraph --version', claudeConfigDir: undefined },
  ]);
  const pkgAfterInstall = installed.state.packages[0];
  assert.equal(pkgAfterInstall.lock.resolvedVersion, '1.5.0');
  assert.equal(pkgAfterInstall.harnessStatuses['claude-code'].installedVersion, '1.5.0');

  // 3. 检查更新：对比实测版本 1.5.0 与远端 1.6.4
  calls.length = 0;
  const checked = await service.action({ type: 'packages.checkUpdates', ids: ['codegraph'] });
  assert.equal(checked.state.packages[0].lock.updateAvailable, true);
  assert.equal(checked.state.packages[0].lock.latestVersion, '1.6.4');

  // 4. 升级：全局 upgrade 只跑 1 次并刷新各端，探测版本更新为 1.6.4
  calls.length = 0;
  const upgraded = await service.action({ type: 'package.upgrade', id: 'codegraph' });
  assert.deepEqual(calls.map(c => c.command), [
    'codegraph upgrade 1.6.4',
    'codegraph install --target codex --yes',
    'codegraph install --target claude --yes',
    'codegraph install --target dsh --yes',
    'codegraph --version',
  ]);
  assert.equal(upgraded.state.packages[0].version, '1.6.4');
  assert.equal(upgraded.state.packages[0].lock.resolvedVersion, '1.6.4');
  assert.equal(upgraded.state.packages[0].harnessStatuses.codex.installedVersion, '1.6.4');

  // 5. 仅卸载单个端（codex）：保留 CLI，不触发 shared.uninstall
  calls.length = 0;
  await service.action({ type: 'package.uninstall', id: 'codegraph', harnesses: ['codex'] });
  assert.deepEqual(calls.map(c => c.command), ['codegraph uninstall --target codex --yes --keep-cli']);

  // 6. 卸载剩余所有已装端：先按端清理（带 CLAUDE_CONFIG_DIR），最后触发 1 次 shared.uninstall
  calls.length = 0;
  await service.action({ type: 'package.uninstall', id: 'codegraph', harnesses: ['claude-code', 'dsh'] });
  assert.deepEqual(calls, [
    { command: 'codegraph uninstall --target claude --yes --keep-cli', claudeConfigDir },
    { command: 'codegraph uninstall --target dsh --yes --keep-cli', claudeConfigDir: undefined },
    { command: 'codegraph uninstall --yes', claudeConfigDir: undefined },
  ]);

  // 7. 全局命令失败时短路，不继续执行分端命令
  failShared = true;
  calls.length = 0;
  const failed = await service.action({ type: 'package.install', id: 'codegraph' });
  assert.deepEqual(calls.map(c => c.command), ['curl -fsSL https://example.com/install.sh | sh']);
  assert.equal(failed.steps.length, 1);
  assert.equal(failed.steps[0].harness, 'shared');
  assert.equal(failed.steps[0].status, 'error');
  assert.equal(failed.state.packages[0].harnessStatuses.codex.status, 'failed');
  assert.match(failed.state.packages[0].harnessStatuses.codex.lastError, /全局命令失败/);
});

test('全局解析配置持久化与三端可用模型探测（Codex / Claude Code / Antigravity）', async t => {
  const base = await mkdtemp(join(tmpdir(), 'ap-analyzer-models-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const homeDir = join(base, 'home');
  const codexDir = join(homeDir, '.codex');
  const claudeDir = join(homeDir, '.claude');
  await mkdir(codexDir, { recursive: true });
  await mkdir(claudeDir, { recursive: true });

  await writeFile(join(codexDir, 'config.toml'), 'model = "gpt-6.2-sol"\n');
  await writeFile(join(codexDir, 'models_cache.json'), JSON.stringify({
    models: [
      { slug: 'gpt-6.2-sol', display_name: 'GPT-6.2-Sol', visibility: 'list' },
      { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide' },
      { slug: 'o4-mini', display_name: 'o4-mini', visibility: 'list' },
    ],
  }));
  await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({ model: 'claude-sonnet-custom' }));

  const execImpl = async (file, args) => {
    if (file === 'agy' && args[0] === 'models') {
      return {
        stdout: 'Fetching available models...\ngemini-4-neon-high\tGemini 4 Neon (High)\nclaude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)\n',
        stderr: '',
      };
    }
    throw new Error(`unexpected exec ${file}`);
  };

  const service = new PackageManagerService({
    root: join(base, 'root'),
    homeDir,
    dshHome: join(homeDir, '.dsh'),
    execImpl,
  });
  await service.init();

  // 1. 探测三端模型
  const codexModels = await service.action({ type: 'analyzer.models', harness: 'codex' });
  assert.equal(codexModels.defaultModel, 'gpt-6.2-sol');
  assert.deepEqual(codexModels.models.map(m => m.id), ['gpt-6.2-sol', 'o4-mini']);

  const claudeModels = await service.action({ type: 'analyzer.models', harness: 'claude-code' });
  assert.equal(claudeModels.defaultModel, 'claude-sonnet-custom');
  assert.ok(claudeModels.models.some(m => m.id === 'claude-sonnet-custom'));
  assert.ok(claudeModels.models.some(m => m.id === 'sonnet'));

  const agyModels = await service.action({ type: 'analyzer.models', harness: 'antigravity' });
  assert.deepEqual(agyModels.models, [
    { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
    { id: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High)' },
  ]);

  // 2. 全局解析配置持久化，且后续保存包不会覆盖清空 settings
  const savedSettings = await service.action({
    type: 'settings.save',
    analyzer: { harness: 'codex', model: 'gpt-6.2-sol' },
  });
  assert.deepEqual(savedSettings.state.settings, { analyzer: { harness: 'codex', model: 'gpt-6.2-sol' } });

  await service.action({
    type: 'package.save',
    package: {
      id: 'demo-pkg',
      name: 'Demo',
      kind: 'installer',
      repo: 'https://github.com/acme/demo',
      targets: ['codex'],
      commands: { codex: { install: 'echo ok' } },
    },
  });
  const stateAfterPkgSave = await service.state();
  assert.deepEqual(stateAfterPkgSave.settings, { analyzer: { harness: 'codex', model: 'gpt-6.2-sol' } });

  // 切换回静态规则后自动清空模型
  const reset = await service.action({ type: 'settings.save', analyzer: { harness: '', model: 'gpt-6.2-sol' } });
  assert.deepEqual(reset.state.settings, { analyzer: { harness: '', model: '' } });
});

test('深度仓库分析端到端：三端只读参数、临时克隆清理、结构化合并与 GitHub API 失败降级', async t => {
  const base = await mkdtemp(join(tmpdir(), 'ap-deep-analyze-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const upstream = await createSampleSkillsRepo(base);
  const homeDir = join(base, 'home');
  const claudeConfigDir = join(homeDir, '.rec', 'claude', 'accounts', '8801', 'config');

  const analysisPayload = {
    kind: 'installer',
    name: 'combo-tool',
    description: 'Skills + MCP 组合工具',
    version: '2.1.0',
    npmPackage: '@acme/combo-tool',
    targets: ['codex', 'claude-code', 'antigravity', 'dsh'],
    skills: { include: [], mode: 'symlink' },
    plugin: { name: '', marketplace: '', harnesses: [] },
    mcp: { serverName: 'combo-tool', transport: 'stdio', command: '', args: [], url: '', envRefs: [] },
    commands: {
      shared: {
        install: 'curl -fsSL https://example.com/install.sh | sh',
        upgrade: 'combo upgrade {{version}}',
        uninstall: 'combo uninstall --yes',
        version: 'combo --version',
      },
      codex: { install: 'combo setup --target codex --yes', upgrade: '', uninstall: 'combo uninstall --target codex --yes --keep-cli' },
      'claude-code': { install: 'combo setup --target claude --yes', upgrade: '', uninstall: 'combo uninstall --target claude --yes --keep-cli' },
      antigravity: { install: 'combo setup --target antigravity --yes', upgrade: '', uninstall: 'combo uninstall --target antigravity --yes --keep-cli' },
      dsh: { install: 'combo setup --target dsh --yes', upgrade: '', uninstall: 'combo uninstall --target dsh --yes --keep-cli' },
    },
    summary: '该仓库同时包含 CLI、MCP 服务与内置规则块，建议通过官方脚本安装并按端非交互接入。',
    warnings: ['安装完成后需重开会话加载 MCP 工具'],
  };

  const spawnCalls = [];
  const clonedDirs = [];
  const execImpl = async (file, args, options) => {
    if (file === 'git' && args[0] === 'clone') {
      // 将远端仓库地址改写为本地临时仓库以实现完全离线测试
      const dest = args[args.length - 1];
      clonedDirs.push(dest);
      return execFileAsync('git', ['clone', '--depth', '1', '--quiet', upstream, dest], options);
    }
    return execFileAsync(file, args, options);
  };

  const spawnImpl = async (file, args, options) => {
    spawnCalls.push({ file, args, cwd: options.cwd, claudeConfigDir: options.env?.CLAUDE_CONFIG_DIR, input: options.input });
    if (file === 'codex') {
      const outIdx = args.indexOf('-o');
      assert.ok(outIdx > 0, 'codex 应通过 -o 写入结构化结果');
      await writeFile(args[outIdx + 1], JSON.stringify(analysisPayload), 'utf8');
      return { stdout: '', stderr: '' };
    }
    if (file === 'reclaude') {
      return { stdout: JSON.stringify({ type: 'result', structured_output: analysisPayload }), stderr: '' };
    }
    if (file === 'agy') {
      return { stdout: JSON.stringify({ response: '```json\n' + JSON.stringify(analysisPayload) + '\n```' }), stderr: '' };
    }
    throw new Error(`unexpected spawn ${file}`);
  };

  const service = new PackageManagerService({
    root: join(base, 'root'),
    homeDir,
    dshHome: join(homeDir, '.dsh'),
    claudeCommand: () => 'reclaude',
    claudeConfigDir: () => claudeConfigDir,
    // 故意让 GitHub API 返回 404，验证深度模式仍可直接基于克隆源码完成分析
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }),
    githubToken: '',
    execImpl,
    spawnImpl,
  });
  await service.init();

  // 1. Codex 深度分析
  await service.action({ type: 'settings.save', analyzer: { harness: 'codex', model: 'gpt-6.2-sol' } });
  const codexRes = await service.action({ type: 'repo.inspect', repo: 'https://github.com/acme/combo-tool.git' });
  assert.equal(codexRes.draft.kind, 'installer');
  assert.equal(codexRes.draft.npmPackage, '@acme/combo-tool');
  assert.equal(codexRes.draft.commands.shared.version, 'combo --version');
  assert.equal(codexRes.draft.commands.dsh.install, 'combo setup --target dsh --yes');
  assert.equal(codexRes.evidence.ai.harness, 'codex');
  assert.equal(codexRes.evidence.ai.model, 'gpt-6.2-sol');
  assert.match(codexRes.evidence.ai.summary, /CLI/);
  assert.ok(codexRes.evidence.ai.warnings.some(w => w.includes('GitHub API 元信息获取失败')));
  assert.ok(spawnCalls[0].args.includes('--sandbox') && spawnCalls[0].args.includes('read-only'));
  assert.ok(spawnCalls[0].args.includes('-m') && spawnCalls[0].args.includes('gpt-6.2-sol'));
  // 临时克隆目录应在分析后被自动清理
  await assert.rejects(() => lstat(clonedDirs[0]));

  // 2. Claude Code（reclaude）深度分析，验证只读工具白名单与 CLAUDE_CONFIG_DIR 透传
  await service.action({ type: 'settings.save', analyzer: { harness: 'claude-code', model: 'sonnet' } });
  const claudeRes = await service.action({ type: 'repo.inspect', repo: 'acme/combo-tool' });
  assert.equal(claudeRes.evidence.ai.harness, 'claude-code');
  assert.equal(spawnCalls[1].file, 'reclaude');
  assert.equal(spawnCalls[1].claudeConfigDir, claudeConfigDir);
  assert.ok(spawnCalls[1].args.includes('--permission-mode') && spawnCalls[1].args.includes('plan'));
  assert.ok(spawnCalls[1].args.includes('--allowedTools') && spawnCalls[1].args.includes('Read,Glob,Grep'));
  assert.ok(spawnCalls[1].args.includes('--model') && spawnCalls[1].args.includes('sonnet'));

  // 3. Antigravity 深度分析，验证 --sandbox / --mode plan 与 fenced JSON 提取
  await service.action({ type: 'settings.save', analyzer: { harness: 'antigravity', model: 'gemini-4-neon-high' } });
  const agyRes = await service.action({ type: 'repo.inspect', repo: 'acme/combo-tool' });
  assert.equal(agyRes.evidence.ai.harness, 'antigravity');
  assert.equal(spawnCalls[2].file, 'agy');
  assert.ok(spawnCalls[2].args.includes('--sandbox') && spawnCalls[2].args.includes('--mode') && spawnCalls[2].args.includes('plan'));
  assert.ok(spawnCalls[2].args.includes('--model') && spawnCalls[2].args.includes('gemini-4-neon-high'));
});

test('深度分析 plugin（如 ponytail）：保留定制卸载清理命令、空命令自动补全、{{claude}} 插值与卸载期 {{dir}} 自动检出', async t => {
  const base = await mkdtemp(join(tmpdir(), 'ap-deep-plugin-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const upstream = await createSampleSkillsRepo(base);
  const homeDir = join(base, 'home');
  const claudeConfigDir = join(homeDir, '.rec', 'claude', 'accounts', '9001', 'config');
  const claudePlugins = join(claudeConfigDir, 'plugins');
  await mkdir(claudePlugins, { recursive: true });
  await writeFile(join(claudePlugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {} }));
  await writeFile(join(claudePlugins, 'known_marketplaces.json'), '{}');

  let returnEmptyCommands = false;
  const execImpl = async (file, args, options) => {
    if (file === 'git' && args[0] === 'clone') {
      const dest = args[args.length - 1];
      const isShallow = args.includes('--depth');
      return execFileAsync('git', isShallow ? ['clone', '--depth', '1', '--quiet', upstream, dest] : ['clone', '--quiet', upstream, dest], options);
    }
    return execFileAsync(file, args, options);
  };
  const spawnImpl = async () => ({
    stdout: JSON.stringify({
      type: 'result',
      structured_output: {
        kind: 'plugin',
        name: 'ponytail',
        description: 'Lazy senior dev plugin',
        version: '5.3.3',
        npmPackage: '',
        targets: ['codex', 'claude-code', 'antigravity'],
        skills: { include: [], mode: 'symlink' },
        plugin: { name: 'ponytail', marketplace: 'ponytail', harnesses: ['codex', 'claude-code', 'antigravity'] },
        mcp: { serverName: 'ponytail', transport: 'stdio', command: '', args: [], url: '', envRefs: [] },
        commands: returnEmptyCommands
          ? {
              shared: { install: '', upgrade: '', uninstall: '', version: '' },
              codex: { install: '', upgrade: '', uninstall: '' },
              'claude-code': { install: '', upgrade: '', uninstall: '' },
              antigravity: { install: '', upgrade: '', uninstall: '' },
              dsh: { install: '', upgrade: '', uninstall: '' },
            }
          : {
              shared: { install: '', upgrade: '', uninstall: '', version: '' },
              codex: {
                install: "codex plugin marketplace add 'DietrichGebert/ponytail' && codex plugin add ponytail@ponytail",
                upgrade: 'codex plugin marketplace upgrade ponytail && codex plugin add ponytail@ponytail',
                uninstall: 'node {{dir}}/scripts/uninstall.js && codex plugin remove ponytail@ponytail',
              },
              'claude-code': {
                install: "{{claude}} plugin marketplace add 'DietrichGebert/ponytail' && {{claude}} plugin install ponytail@ponytail",
                upgrade: '{{claude}} plugin marketplace update ponytail && {{claude}} plugin update ponytail@ponytail',
                uninstall: 'node {{dir}}/scripts/uninstall.js && {{claude}} plugin uninstall ponytail@ponytail',
              },
              antigravity: {
                install: "agy plugin install 'https://github.com/DietrichGebert/ponytail'",
                upgrade: '',
                uninstall: 'agy plugin uninstall ponytail',
              },
              dsh: { install: '', upgrade: '', uninstall: '' },
            },
        summary: '标准插件市场仓库，卸载前需执行 scripts/uninstall.js 清理状态文件。',
        warnings: ['Codex 需在 /hooks 信任插件 Hook'],
      },
    }),
    stderr: '',
  });

  const executed = [];
  const runShell = async (command, options) => {
    executed.push({ command, claudeConfigDir: options?.env?.CLAUDE_CONFIG_DIR });
    if (command.includes('reclaude plugin install ponytail@ponytail')) {
      await writeFile(join(claudePlugins, 'installed_plugins.json'), JSON.stringify({
        version: 2,
        plugins: { 'ponytail@ponytail': [{ scope: 'user', version: '5.3.3' }] },
      }));
    }
    return { stdout: 'ok', stderr: '' };
  };

  const service = new PackageManagerService({
    root: join(base, 'root'),
    homeDir,
    dshHome: join(homeDir, '.dsh'),
    claudeCommand: () => 'reclaude',
    claudeConfigDir: () => claudeConfigDir,
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }),
    githubToken: '',
    execImpl,
    spawnImpl,
    runShell,
  });
  await service.init();
  await service.action({ type: 'settings.save', analyzer: { harness: 'claude-code', model: 'opus' } });

  // 1. 模型返回定制卸载脚本时，完整保留并补全缺失的 antigravity upgrade
  const customRes = await service.action({ type: 'repo.inspect', repo: 'https://github.com/DietrichGebert/ponytail' });
  assert.equal(customRes.draft.kind, 'plugin');
  assert.equal(customRes.draft.commands['claude-code'].uninstall, 'node {{dir}}/scripts/uninstall.js && {{claude}} plugin uninstall ponytail@ponytail');
  assert.equal(customRes.draft.commands.antigravity.upgrade, "agy plugin uninstall ponytail && agy plugin install 'https://github.com/DietrichGebert/ponytail'");

  // 2. 即使模型返回空 commands，也自动补全 3 端可执行命令模板
  returnEmptyCommands = true;
  const fallbackRes = await service.action({ type: 'repo.inspect', repo: 'https://github.com/DietrichGebert/ponytail' });
  assert.equal(fallbackRes.draft.commands['claude-code'].install, "{{claude}} plugin marketplace add 'DietrichGebert/ponytail' && {{claude}} plugin install ponytail@ponytail");
  assert.equal(fallbackRes.draft.commands.codex.uninstall, 'codex plugin remove ponytail@ponytail');
  assert.equal(fallbackRes.draft.commands.antigravity.install, "agy plugin install 'https://github.com/DietrichGebert/ponytail'");

  // 3. 保存并安装 claude-code：{{claude}} 自动插值为 reclaude，透传 CLAUDE_CONFIG_DIR 并读回版本 5.3.3
  const saved = await service.action({
    type: 'package.save',
    installNow: true,
    package: { ...customRes.draft, targets: ['claude-code'] },
  });
  assert.deepEqual(executed, [{
    command: "reclaude plugin marketplace add 'DietrichGebert/ponytail' && reclaude plugin install ponytail@ponytail",
    claudeConfigDir,
  }]);
  assert.equal(saved.state.packages[0].harnessStatuses['claude-code'].installedVersion, '5.3.3');

  // 4. 卸载：命令含 {{dir}}，即使此前未克隆过 repos/ponytail 也会自动检出再执行卸载清理命令
  executed.length = 0;
  const uninstalled = await service.action({ type: 'package.uninstall', id: 'ponytail', harnesses: ['claude-code'] });
  assert.equal(uninstalled.steps[0].harness, 'repo');
  assert.equal(uninstalled.steps[0].action, 'git-sync');
  assert.equal(executed.length, 1);
  assert.match(executed[0].command, /^node .+repos\/ponytail\/scripts\/uninstall\.js && reclaude plugin uninstall ponytail@ponytail$/);
  assert.equal(executed[0].claudeConfigDir, claudeConfigDir);
});
