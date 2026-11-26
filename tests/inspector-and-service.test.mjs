import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inferPackageFromRepoMeta, extractInstallCommandsFromReadme } from '../src/github-inspector.mjs';
import { PackageManagerService } from '../src/service.mjs';
import { apiHandler, ENDPOINT, HEADER_KEY } from '../src/api.mjs';
import { readCodexMcpServers, readJsonMcpServers } from '../src/config-editors.mjs';

const execFileAsync = promisify(execFile);

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

test('MCP 包与自定义安装器端到端：安装、检查更新、升级与本机扫描导入', async t => {
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

  // 4. 本机只读扫描与导入未纳管 MCP
  const scan = await service.action({ type: 'local.scan' });
  assert.ok(scan.report.warnings.some(w => w.kind === 'legacy-dir'));
  assert.ok(scan.report.warnings.some(w => w.kind === 'broken-symlink'));
  const existingCandidate = scan.report.importCandidates.find(c => c.candidateId === 'mcp:existing_tool');
  assert.ok(existingCandidate);
  const imported = await service.action({ type: 'local.import', draft: existingCandidate.draft });
  assert.equal(imported.package.id, 'existing_tool');
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
