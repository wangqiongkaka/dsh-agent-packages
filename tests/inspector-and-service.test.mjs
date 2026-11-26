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
  const again = await service.action({ type: 'package.save', installNow: true, package: { ...ponytail, name: 'Ponytail' } });
  assert.deepEqual(executed, []);
  assert.match(again.message, /已在清单中/);
  assert.deepEqual(again.state.packages.map(p => [p.id, p.name]), [['lazy-dev', 'Ponytail']]);
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
