import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { PackageManagerService } from '../src/service.mjs';
import { apiHandler, ENDPOINT } from '../src/api.mjs';

const execFileAsync = promisify(execFile);
// 验收只用临时目录，避免经环境变量读到本机真实的 Claude / Codex 配置
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;

async function makeTempSkillsRepo(base) {
  const dir = join(base, 'firecrawl-skills-upstream');
  await mkdir(join(dir, 'skills', 'firecrawl-search'), { recursive: true });
  await mkdir(join(dir, 'skills', 'firecrawl-scrape'), { recursive: true });
  await writeFile(join(dir, 'skills', 'firecrawl-search', 'SKILL.md'), '---\nname: firecrawl-search\n---\n# Search\n');
  await writeFile(join(dir, 'skills', 'firecrawl-scrape', 'SKILL.md'), '---\nname: firecrawl-scrape\n---\n# Scrape\n');
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'ui@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'UI Test'], { cwd: dir });
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: dir });
  await execFileAsync('git', ['tag', 'v1.4.0'], { cwd: dir });
  return dir;
}

const base = await mkdtemp(join(tmpdir(), 'ap-ui-'));
const homeDir = join(base, 'home');
const dshHome = join(homeDir, '.dsh');
const root = join(dshHome, 'dsh-agent-packages');
let server;
let browser;

try {
  const upstreamSkills = await makeTempSkillsRepo(base);

  // 造一点本机扫描夹具数据（仅在临时目录，不碰真实本机配置）
  await mkdir(join(homeDir, '.codex'), { recursive: true });
  await writeFile(join(homeDir, '.codex', 'config.toml'), 'model = "gpt-6.2-sol"\n\n[mcp_servers.codegraph]\ncommand = "codegraph"\nargs = ["serve"]\n');
  await writeFile(join(homeDir, '.codex', 'AGENTS.md'), [
    '# 全局协作规则',
    '',
    '- 所有回复使用中文。',
    '- 改动前先核对直接调用方。',
    '',
    '<!-- CODEGRAPH_START -->',
    '## CodeGraph',
    'Use codegraph_explore before grep.',
    '<!-- CODEGRAPH_END -->',
    '',
  ].join('\n'));
  await mkdir(dshHome, { recursive: true });
  await symlink(join(homeDir, '.codex', 'AGENTS.md'), join(dshHome, 'AGENTS.md'));
  await writeFile(join(homeDir, '.codex', 'models_cache.json'), JSON.stringify({
    models: [
      { slug: 'gpt-6.2-sol', display_name: 'GPT-6.2-Sol', visibility: 'list' },
      { slug: 'o4-mini', display_name: 'o4-mini', visibility: 'list' },
    ],
  }));
  await mkdir(join(homeDir, '.gemini', 'skills', 'legacy-firecrawl'), { recursive: true });
  await mkdir(join(homeDir, '.gemini', 'config', 'skills'), { recursive: true });
  await symlink(join(base, 'deleted-skill'), join(homeDir, '.gemini', 'config', 'skills', 'stale-link'));
  // 同一插件装在 Claude Code（带市场名）与 Antigravity（无市场名），诊断矩阵应合并成一行
  await mkdir(join(homeDir, '.claude', 'plugins'), { recursive: true });
  await writeFile(join(homeDir, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'ponytail@ponytail': [{ scope: 'user', version: '1.2.0' }] } }));
  await mkdir(join(homeDir, '.gemini', 'config', 'plugins', 'ponytail'), { recursive: true });
  // 让 Hindsight 的 Claude Code 安装先失败，覆盖失败行、重试与失败记录自动展开
  // 本机未纳管的 Claude Skill，用于验证纳管
  await mkdir(join(homeDir, '.claude', 'skills', 'my-notes'), { recursive: true });
  await writeFile(join(homeDir, '.claude', 'skills', 'my-notes', 'SKILL.md'), '---\nname: my-notes\n---\n');
  let failHindsightClaude = true;

  const mockFetch = async url => {
    const u = String(url);
    if (u.includes('registry.npmjs.org/%40playwright%2Fmcp/latest')) {
      return { ok: true, json: async () => ({ version: '0.0.29' }) };
    }
    if (u.includes('api.github.com/repos/microsoft/playwright-mcp/releases/latest')) {
      return { ok: true, json: async () => ({ tag_name: 'v0.0.29' }) };
    }
    if (u.includes('api.github.com/repos/microsoft/playwright-mcp/commits/')) {
      return { ok: true, json: async () => ({ sha: '1111111222222233333334444444555555566666' }) };
    }
    if (u.includes('api.github.com/repos/microsoft/playwright-mcp/git/trees/')) {
      return { ok: true, json: async () => ({ tree: [{ type: 'blob', path: 'package.json' }, { type: 'blob', path: 'README.md' }] }) };
    }
    if (u.includes('api.github.com/repos/microsoft/playwright-mcp')) {
      return { ok: true, json: async () => ({ name: 'playwright-mcp', default_branch: 'main', description: 'Playwright MCP server for browser automation' }) };
    }
    if (u.includes('raw.githubusercontent.com/microsoft/playwright-mcp/main/package.json')) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          name: '@playwright/mcp',
          version: '0.0.28',
          dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
          bin: { 'playwright-mcp': 'cli.js' },
        }),
      };
    }
    if (u.includes('raw.githubusercontent.com/microsoft/playwright-mcp/main/README.md')) {
      return { ok: true, text: async () => '# Playwright MCP\n\n## Claude Code\n```bash\nclaude mcp add playwright npx @playwright/mcp@latest\n```\n' };
    }
    if (u.includes('api.github.com/repos/colbymchenry/codegraph/releases/latest')) {
      return { ok: true, json: async () => ({ tag_name: 'v1.6.4' }) };
    }
    if (u.includes('api.github.com/repos/colbymchenry/codegraph/commits/')) {
      return { ok: true, json: async () => ({ sha: '2222222333333344444445555555666666677777' }) };
    }
    if (u.includes('api.github.com/repos/colbymchenry/codegraph/git/trees/')) {
      return {
        ok: true,
        json: async () => ({
          tree: [
            { type: 'blob', path: 'package.json' },
            { type: 'blob', path: 'install.sh' },
            { type: 'blob', path: 'README.md' },
            { type: 'blob', path: '.claude/skills/add-lang/SKILL.md' },
            { type: 'blob', path: 'src/installer/targets/claude.ts' },
            { type: 'blob', path: 'src/installer/targets/codex.ts' },
            { type: 'blob', path: 'src/installer/targets/antigravity.ts' },
            { type: 'blob', path: 'src/installer/targets/dsh.ts' },
          ],
        }),
      };
    }
    if (u.includes('api.github.com/repos/colbymchenry/codegraph')) {
      return { ok: true, json: async () => ({ name: 'codegraph', default_branch: 'main', description: 'Local semantic code intelligence graph' }) };
    }
    if (u.includes('raw.githubusercontent.com/colbymchenry/codegraph/main/package.json')) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          name: '@colbymchenry/codegraph',
          version: '1.6.4',
          bin: { codegraph: './dist/bin/codegraph.js' },
        }),
      };
    }
    if (u.includes('raw.githubusercontent.com/colbymchenry/codegraph/main/README.md')) {
      return {
        ok: true,
        text: async () => [
          '# CodeGraph',
          '```bash',
          'curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh',
          '```',
          '```bash',
          'codegraph install',
          'codegraph upgrade [version]',
          'codegraph uninstall',
          '```',
          'Pass `--keep-cli`, `--target`, `--yes`.',
        ].join('\n'),
      };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };

  const service = new PackageManagerService({
    root,
    homeDir,
    dshHome,
    fetchImpl: mockFetch,
    githubToken: '',
    runShell: async cmd => {
      if (failHindsightClaude && cmd.includes('hindsight install --target claude')) throw new Error('hindsight: command not found');
      return { stdout: `模拟执行成功：${cmd}`, stderr: '' };
    },
    execImpl: async (file, args, options) => {
      if (file === 'git' && args[0] === 'clone' && args.includes('--depth')) {
        const dest = args[args.length - 1];
        return execFileAsync('git', ['clone', '--depth', '1', '--quiet', upstreamSkills, dest], options);
      }
      return execFileAsync(file, args, options);
    },
    spawnImpl: async (file, args) => {
      const payload = {
        kind: 'installer',
        name: 'codegraph',
        description: '本地语义代码图谱 CLI 与多端 MCP 工具（由 Codex 深度分析生成）',
        version: '1.6.4',
        npmPackage: '@colbymchenry/codegraph',
        targets: ['codex', 'claude-code', 'antigravity', 'dsh'],
        skills: { include: [], mode: 'symlink' },
        plugin: { name: '', marketplace: '', harnesses: [] },
        mcp: { serverName: 'codegraph', transport: 'stdio', command: '', args: [], url: '', envRefs: [] },
        commands: {
          shared: {
            install: 'curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh',
            upgrade: 'codegraph upgrade {{version}}',
            uninstall: 'codegraph uninstall --yes',
            version: 'codegraph --version',
          },
          codex: { install: 'codegraph install --target codex --yes', upgrade: '', uninstall: 'codegraph uninstall --target codex --yes --keep-cli' },
          'claude-code': { install: 'codegraph install --target claude --yes', upgrade: '', uninstall: 'codegraph uninstall --target claude --yes --keep-cli' },
          antigravity: { install: 'codegraph install --target antigravity --yes', upgrade: '', uninstall: 'codegraph uninstall --target antigravity --yes --keep-cli' },
          dsh: { install: 'codegraph install --target dsh --yes', upgrade: '', uninstall: 'codegraph uninstall --target dsh --yes --keep-cli' },
        },
        summary: '识别为自带 CLI 与多端安装器的复合工具，已生成全局安装/升级/版本探测与 4 端无交互接入方案。',
        warnings: ['首次接入后请重启对应 Harness 会话以加载 MCP 工具'],
      };
      if (file === 'codex') {
        const outIdx = args.indexOf('-o');
        if (outIdx > 0) await writeFile(args[outIdx + 1], JSON.stringify(payload), 'utf8');
      }
      return { stdout: JSON.stringify(payload), stderr: '' };
    },
  });
  await service.init();

  // 预置 2 个不同类型的包，展示初始列表效果
  await service.action({
    type: 'package.save',
    installNow: true,
    package: {
      id: 'firecrawl-skills',
      name: 'Firecrawl Skills',
      kind: 'skills-repo',
      repo: upstreamSkills,
      ref: 'v1.4.0',
      description: '网页抓取、搜索与结构化提取技能包',
      targets: ['codex', 'claude-code', 'antigravity', 'dsh'],
    },
  });
  await service.action({
    type: 'package.save',
    installNow: true,
    package: {
      id: 'hindsight',
      name: 'Hindsight Memory',
      kind: 'installer',
      repo: 'https://github.com/vectorize-io/hindsight',
      version: '0.8.1',
      description: '跨会话代码库记忆与 MCP 插件（按各 Harness 官方安装命令调度）',
      targets: ['codex', 'claude-code', 'antigravity'],
      commands: {
        codex: { install: 'hindsight install --target codex --version {{version}}' },
        'claude-code': { install: 'hindsight install --target claude --version {{version}}' },
        antigravity: { install: 'hindsight install --target antigravity --version {{version}}' },
      },
    },
  });

  await service.action({
    type: 'package.save',
    installNow: true,
    package: {
      id: 'solo-cli',
      name: 'Solo CLI',
      kind: 'installer',
      targets: ['codex'],
      commands: { shared: { install: 'solo install', uninstall: 'solo uninstall --all' } },
    },
  });

  const bundled = await build({
    entryPoints: ['tests/fixtures/preview.jsx'],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    loader: { '.css': 'text' },
    alias: { '@deepseek-ai/dsh-client-ui-primitives': resolve('tests/fixtures/button.jsx') },
  });

  const handler = apiHandler(service);
  server = createServer((req, res) => {
    if (req.url === ENDPOINT) return void handler(req, res);
    if (req.url === '/preview.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      return res.end(bundled.outputFiles[0].contents);
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Skills & MCP 管理验收</title><body style="margin:0;padding:24px;background:#181818;color:#f2f2f2;--dsw-alias-border-l2:#3a3e47;--dsw-alias-label-secondary:#a8b0be;--dsw-alias-label-primary:#f2f2f2;--dsw-alias-bg-layer-1:#22252b;--dsw-alias-state-active-primary:#608dff;--dsw-alias-state-error-primary:#ff8989;--dsw-alias-state-success-primary:#7fd8ab"><div id="app"></div><script src="/preview.js"></script></body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/`;

  await mkdir('artifacts', { recursive: true });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, locale: 'zh-CN', colorScheme: 'dark' });
  const pageErrors = [];
  const failedRequests = [];
  page.on('pageerror', err => pageErrors.push(err.message));
  page.on('requestfailed', req => failedRequests.push(req.url()));

  await page.goto(url);
  await page.getByText('Firecrawl Skills').waitFor();
  const exists = async p => { try { await lstat(p); return true; } catch { return false; } };
  const tabNames = await page.getByRole('tab').allInnerTexts();
  assert.deepEqual(tabNames.map(t => t.replace(/\d+/g, '').trim()), ['Skills', 'MCP', '插件', '规则'], '按资源类型分 4 个视图');
  assert.equal(await page.getByRole('tab', { name: /Skills/ }).getAttribute('aria-selected'), 'true');
  await page.screenshot({ path: 'artifacts/packages-desktop.png', fullPage: true });

  // 0. Skills：来源组头显示各端「已装/总数」，展开后逐个 Skill 开关；关闭先行内确认
  const fcGroup = page.locator('.ap-skill-group', { hasText: 'Firecrawl Skills' });
  assert.equal(await fcGroup.getByRole('switch', { name: /^Codex：已装 2 \/ 共 2/ }).count(), 1);
  assert.equal(await page.locator('.ap-skill-row').count(), 0, '来源分组默认收起');
  await fcGroup.getByRole('button', { name: 'Firecrawl Skills', exact: true }).click();
  const searchRow = page.locator('.ap-skill-row', { hasText: 'firecrawl-search' });
  await searchRow.waitFor();
  assert.equal(await page.locator('.ap-skill-row').count(), 2);
  const codexSearch = searchRow.getByRole('switch', { name: /^Codex：/ });
  assert.equal(await codexSearch.getAttribute('aria-checked'), 'true');
  await codexSearch.click();
  await searchRow.locator('.ap-confirm').getByText(/将从 Codex 移除 Skill「firecrawl-search」/).waitFor();
  assert.equal(await exists(join(homeDir, '.codex', 'skills', 'firecrawl-search')), true, '确认前不执行');
  await page.getByRole('button', { name: '确认移除' }).click();
  await page.getByText(/已从 Codex 移除「firecrawl-search」/).waitFor();
  assert.equal(await exists(join(homeDir, '.codex', 'skills', 'firecrawl-search')), false);
  assert.equal(await exists(join(homeDir, '.codex', 'skills', 'firecrawl-scrape')), true, '同组其他 Skill 不受影响');
  assert.equal(await page.locator('.ap-skill-row', { hasText: 'firecrawl-search' }).getByRole('switch', { name: /^Codex：/ }).getAttribute('aria-checked'), 'false');
  assert.equal(await fcGroup.getByRole('switch', { name: /^Codex：已装 1 \/ 共 2.*点击开启全部/ }).count(), 1, '部分开启时组头提示与动作一致');
  await page.screenshot({ path: 'artifacts/packages-skills.png', fullPage: true });
  // 点亮立即安装，不需要确认
  await page.locator('.ap-skill-row', { hasText: 'firecrawl-search' }).getByRole('switch', { name: /^Codex：/ }).click();
  await page.getByText(/已在 Codex 启用「firecrawl-search」/).waitFor();
  assert.equal(await exists(join(homeDir, '.codex', 'skills', 'firecrawl-search')), true);

  // 本机未纳管的 Skill：纳管只登记不改文件，之后可同步到其他端
  const notesRow = page.locator('.ap-unmanaged-row', { hasText: 'my-notes' });
  await notesRow.waitFor();
  assert.equal(await notesRow.getByRole('img', { name: /^Claude Code：本机存在/ }).count(), 1);
  await notesRow.getByRole('button', { name: '纳管' }).click();
  await page.getByText(/已纳管 Skill「my-notes」/).waitFor();
  assert.equal(await page.locator('.ap-unmanaged-row', { hasText: 'my-notes' }).count(), 0);
  const localGroup = page.locator('.ap-skill-group', { hasText: '本机 Skills' });
  await localGroup.getByRole('button', { name: '本机 Skills', exact: true }).click();
  await page.locator('.ap-skill-row', { hasText: 'my-notes' }).getByRole('switch', { name: /^Codex：/ }).click();
  await page.getByText(/已在 Codex 启用「my-notes」/).waitFor();
  assert.equal((await lstat(join(homeDir, '.codex', 'skills', 'my-notes'))).isSymbolicLink(), true);
  // 诊断提示并入 Skills 视图
  await page.locator('.ap-warning-list').getByText(/失效软链接/).waitFor();
  await page.locator('.ap-warning-list').getByText(/检测到旧版目录/).waitFor();

  // 1. 插件视图：失败行写明原因并给出「重试安装」；跳过时开关不翻转；未纳管插件跨端合并、可纳管
  await page.getByRole('tab', { name: /插件/ }).click();
  assert.equal(await page.locator('.ap-logs').count(), 0, '执行记录不跨视图');
  assert.equal(await page.locator('.ap-banner-notice').count(), 0, '提示不跨视图');
  const hindsightRow = page.locator('.ap-pkg-card', { hasText: 'Hindsight Memory' });
  assert.match(await hindsightRow.getAttribute('class'), /is-error/);
  assert.match(await hindsightRow.locator('.ap-row-reason').innerText(), /Claude Code 安装失败：hindsight: command not found/);
  assert.match(await hindsightRow.locator('.ap-badge-kind').innerText(), /CLI 工具/);
  await page.getByRole('button', { name: '全部同步' }).waitFor();
  await hindsightRow.getByRole('button', { name: '重试安装' }).click();
  await page.locator('.ap-logs[open]').waitFor();
  assert.match(await page.locator('.ap-logs summary').innerText(), /1 步失败/);
  assert.match(await page.locator('.ap-banner-notice').getAttribute('class'), /is-warn/, '部分失败的提示不应使用成功色');
  await page.setViewportSize({ width: 585, height: 1000 });
  await page.screenshot({ path: 'artifacts/packages-failed-panel.png', fullPage: true });
  await page.setViewportSize({ width: 1360, height: 1000 });
  failHindsightClaude = false;
  await hindsightRow.getByRole('button', { name: '重试安装' }).click();
  await page.getByText(/「Hindsight Memory」安装完成/).waitFor();
  assert.doesNotMatch(await hindsightRow.getAttribute('class'), /is-error/);
  assert.equal(await page.locator('.ap-logs[open]').count(), 0, '全部成功时执行记录默认折叠');
  // DSH 没有配置该安装器的命令：步骤被跳过，开关保持关闭
  const dshSwitch = hindsightRow.getByRole('switch', { name: /^DSH 原生：/ });
  await dshSwitch.click();
  await page.getByText(/在 DSH 原生 未变更/).waitFor();
  assert.equal(await dshSwitch.getAttribute('aria-checked'), 'false');
  // CLI 工具关掉最后一个端：确认条写明会执行全局卸载命令
  const soloRow = page.locator('.ap-pkg-card', { hasText: 'Solo CLI' });
  await soloRow.getByRole('switch', { name: /^Codex：/ }).click();
  await soloRow.locator('.ap-confirm').getByText(/这是最后一个端，会同时执行全局卸载命令：solo uninstall --all/).waitFor();
  await soloRow.locator('.ap-confirm').getByRole('button', { name: '取消' }).click();
  assert.equal(await soloRow.getByRole('switch', { name: /^Codex：/ }).getAttribute('aria-checked'), 'true');
  // ponytail 装在 Claude Code 与 Antigravity，合并为一行；纳管后成为受管插件
  const ponyRow = page.locator('.ap-unmanaged-row', { hasText: 'ponytail' });
  assert.equal(await ponyRow.count(), 1);
  assert.match(await ponyRow.innerText(), /ponytail@ponytail/);
  await ponyRow.getByRole('button', { name: '纳管' }).click();
  await page.getByText(/已纳管插件「ponytail」/).waitFor();
  const ponyManaged = page.locator('.ap-pkg-card', { hasText: 'ponytail' });
  assert.equal(await ponyManaged.getByRole('switch', { name: /^Claude Code：已安装/ }).getAttribute('aria-checked'), 'true');
  assert.equal(await ponyManaged.getByRole('switch', { name: /^DSH 原生：/ }).isDisabled(), true, '插件在 DSH 原生不可用');

  // 2. MCP 视图：添加包 → 解析 GitHub 仓库 → Key-Value 环境变量 → 保存并安装
  await page.getByRole('tab', { name: /MCP/ }).click();
  await page.getByRole('button', { name: '添加 MCP' }).click();
  await page.locator('#ap-repo').fill('microsoft/playwright-mcp');
  await page.getByRole('button', { name: '解析仓库' }).click();
  await page.locator('.ap-evidence').waitFor();
  assert.equal(await page.locator('#ap-version').inputValue(), '0.0.28');
  assert.match(await page.locator('.ap-editor .ap-advanced summary').innerText(), /0\.0\.28/);
  await page.locator('#ap-mcp-env-key-0').fill('FIRECRAWL_API_KEY');
  await page.locator('#ap-mcp-env-val-0').fill('fc-demo-key');
  await page.getByRole('button', { name: '添加变量' }).click();
  await page.locator('#ap-mcp-env-key-1').fill('HTTPS_PROXY');
  await page.getByRole('button', { name: '添加变量' }).click();
  await page.getByRole('button', { name: '删除第 3 行环境变量' }).click();
  assert.equal(await page.locator('.ap-kv-row').count(), 2, '删除后应保留 2 行环境变量');
  // 切到其他视图再回来，填了一半的添加面板仍在；其他视图的「添加」暂时禁用
  await page.getByRole('tab', { name: /Skills/ }).click();
  assert.equal(await page.locator('.ap-editor').count(), 0);
  assert.equal(await page.getByRole('button', { name: '添加 Skills 来源' }).isDisabled(), true);
  await page.getByRole('tab', { name: /MCP/ }).click();
  assert.equal(await page.locator('#ap-mcp-env-val-0').inputValue(), 'fc-demo-key', '切换 Tab 不丢草稿');
  await page.screenshot({ path: 'artifacts/packages-editor.png', fullPage: true });

  // 编辑面板同一行的输入框顶部对齐（宽屏与 DSH 设置页常见的约 560px 宽度各检查一次）
  const misaligned = () => page.evaluate(() => {
    const bad = [];
    for (const grid of document.querySelectorAll('.ap-editor .ap-grid')) {
      const rows = new Map();
      for (const field of grid.children) {
        const control = field.querySelector('input, select, button[role="combobox"]');
        if (!control || !control.offsetHeight) continue;
        const row = Math.round(field.getBoundingClientRect().top);
        rows.set(row, [...(rows.get(row) || []), Math.round(control.getBoundingClientRect().top)]);
      }
      for (const tops of rows.values()) if (new Set(tops).size > 1) bad.push(tops);
    }
    return bad;
  });
  assert.deepEqual(await misaligned(), [], '宽屏编辑面板输入框未对齐');
  const narrow = await page.addStyleTag({ content: '#app > div { max-width: 560px !important; }' });
  assert.deepEqual(await misaligned(), [], '窄面板编辑面板输入框未对齐');
  await page.locator('.ap-editor').screenshot({ path: 'artifacts/packages-editor-panel.png' });
  await narrow.evaluate(el => el.remove());

  await page.getByRole('button', { name: '保存并安装' }).click();
  const pwRow = page.locator('.ap-pkg-card', { hasText: 'playwright-mcp' });
  await pwRow.waitFor();
  assert.equal(await page.getByRole('tab', { name: /MCP/ }).getAttribute('aria-selected'), 'true', '保存后停留在 MCP 视图');
  // 重新打开编辑核对 Key-Value 与留空引用均正确回显；编辑面板原位展开，不重复显示该行
  await page.getByRole('button', { name: 'playwright-mcp 更多操作' }).click();
  await page.getByRole('menuitem', { name: '编辑' }).click();
  assert.equal(await page.locator('.ap-list > .ap-editor').count(), 1, '编辑已有条目应在列表原位展开');
  assert.equal(await page.locator('.ap-pkg-card', { hasText: 'playwright-mcp' }).count(), 0);
  assert.equal(await page.locator('#ap-mcp-env-key-0').inputValue(), 'FIRECRAWL_API_KEY');
  assert.equal(await page.locator('#ap-mcp-env-val-0').inputValue(), 'fc-demo-key');
  assert.equal(await page.locator('#ap-mcp-env-key-1').inputValue(), 'HTTPS_PROXY');
  assert.equal(await page.locator('#ap-mcp-env-val-1').inputValue(), '');
  await page.getByRole('button', { name: '收起' }).click();
  // DSH 原生没有 MCP 配置文件：开关不可用；关闭 Antigravity 需确认，确认后移除配置条目
  assert.equal(await pwRow.getByRole('switch', { name: /^DSH 原生：/ }).isDisabled(), true);
  await pwRow.getByRole('switch', { name: /^Antigravity：/ }).click();
  await pwRow.locator('.ap-confirm').getByText(/将从 Antigravity 移除「playwright-mcp」的 MCP 配置条目/).waitFor();
  await page.locator('.ap-confirm').screenshot({ path: 'artifacts/packages-confirm.png' });
  await page.getByRole('button', { name: '确认卸载' }).click();
  await page.getByText(/已从 Antigravity 移除「playwright-mcp」/).waitFor();
  const agyMcp = JSON.parse(await readFile(join(homeDir, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
  assert.equal(agyMcp.mcpServers?.['playwright-mcp'], undefined);

  // 2b. 解析 CodeGraph 类 CLI 安装器仓库：自动识别为 CLI 工具、填充全局与 4 端命令
  await page.getByRole('tab', { name: /插件/ }).click();
  await page.getByRole('button', { name: '添加插件' }).click();
  await page.locator('#ap-repo').fill('https://github.com/colbymchenry/codegraph.git');
  await page.getByRole('button', { name: '解析仓库' }).click();
  await page.locator('.ap-evidence').waitFor();
  assert.match(await page.locator('#ap-kind').innerText(), /自定义安装器/);
  assert.match(await page.locator('.ap-evidence').innerText(), /CLI codegraph/);
  assert.equal(await page.locator('#ap-cmd-shared-install').inputValue(), 'curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh');
  assert.equal(await page.locator('#ap-cmd-shared-upgrade').inputValue(), 'codegraph upgrade {{version}}');
  assert.equal(await page.locator('#ap-cmd-shared-version').inputValue(), 'codegraph --version');
  assert.equal(await page.locator('#ap-cmd-install-claude-code').inputValue(), 'codegraph install --target claude --yes');
  assert.equal(await page.locator('#ap-cmd-install-dsh').inputValue(), 'codegraph install --target dsh --yes');
  assert.deepEqual(await misaligned(), [], 'CLI 安装器编辑面板宽屏输入框未对齐');
  await page.screenshot({ path: 'artifacts/packages-codegraph-editor.png', fullPage: true });
  await page.getByRole('button', { name: '保存并预览' }).click();
  await page.getByText('全局 CLI').first().waitFor();
  assert.match(await page.locator('.ap-logs summary').innerText(), /仅预览，未写入/);
  await page.getByRole('button', { name: '收起' }).click();
  // 预览只保存不安装：写明未安装的端；codegraph 安装器管理同名 MCP，所以 MCP 视图里不再列为未纳管
  const codegraphPkgRow = page.locator('.ap-pkg-card', { hasText: 'codegraph' });
  assert.match(await codegraphPkgRow.locator('.ap-row-reason').innerText(), /尚未安装到 Codex、Claude Code、Antigravity、DSH 原生/);
  await page.getByRole('tab', { name: /MCP/ }).click();
  await page.getByText(/另有 1 项由插件或 CLI 工具管理，不单独纳管：codegraph（codegraph）/).waitFor();
  await page.getByRole('tab', { name: /插件/ }).click();
  await page.getByRole('button', { name: 'codegraph 更多操作' }).click();
  await page.getByRole('menuitem', { name: '从清单移除' }).click();
  await page.locator('.ap-confirm').getByText('将从清单移除「codegraph」').waitFor();
  await page.getByRole('button', { name: '确认移除' }).click();
  await page.locator('.ap-pkg-card', { hasText: 'codegraph' }).waitFor({ state: 'detached' });

  // 2c. 纳管 MCP：codegraph 回到未纳管；纳管不改 Codex 配置
  await page.getByRole('tab', { name: /MCP/ }).click();
  const codexTomlBefore = await readFile(join(homeDir, '.codex', 'config.toml'), 'utf8');
  const cgUnmanaged = page.locator('.ap-unmanaged-row', { hasText: 'codegraph' });
  await cgUnmanaged.getByRole('button', { name: '纳管' }).click();
  await page.getByText(/已纳管 MCP「codegraph」，未改动本机配置/).waitFor();
  assert.equal(await readFile(join(homeDir, '.codex', 'config.toml'), 'utf8'), codexTomlBefore);
  assert.equal(await page.locator('.ap-pkg-card', { hasText: 'codegraph' }).getByRole('switch', { name: /^Codex：已安装/ }).getAttribute('aria-checked'), 'true');

  // 3. 全局解析设置（在添加面板内切换）：Codex + 模型 → 深度分析 → 切回静态规则
  await page.getByRole('button', { name: '添加 MCP' }).click();
  await page.getByRole('button', { name: '切换', exact: true }).click();
  await page.getByRole('heading', { name: '全局解析设置' }).waitFor();
  await page.locator('#ap-analyzer-harness').click();
  await page.getByRole('option', { name: /Codex/ }).click();
  await page.locator('#ap-analyzer-model').waitFor();
  await page.locator('#ap-analyzer-model').click();
  await page.getByRole('option', { name: /GPT-6\.2-Sol/ }).click();
  await page.screenshot({ path: 'artifacts/packages-analyzer-settings.png', fullPage: true });
  await page.getByRole('button', { name: '保存设置' }).click();
  await page.getByText(/已保存全局解析配置：Codex · gpt-6\.2-sol/).waitFor();
  await page.getByText(/当前解析：Codex · gpt-6\.2-sol（深度模式）/).waitFor();
  await page.locator('#ap-repo').fill('https://github.com/colbymchenry/codegraph.git');
  await page.getByRole('button', { name: '解析仓库' }).click();
  await page.locator('.ap-ai-evidence').waitFor();
  assert.match(await page.locator('.ap-ai-evidence').innerText(), /深度分析 · Codex \(gpt-6\.2-sol\)/);
  assert.match(await page.locator('.ap-ai-evidence').innerText(), /首次接入后请重启对应 Harness 会话/);
  await page.screenshot({ path: 'artifacts/packages-ai-analysis.png', fullPage: true });
  await page.getByRole('button', { name: '切换', exact: true }).click();
  await page.locator('#ap-analyzer-harness').click();
  await page.getByRole('option', { name: /静态规则/ }).click();
  await page.getByRole('button', { name: '保存设置' }).click();
  await page.getByText(/当前解析：静态规则/).waitFor();
  await page.getByRole('button', { name: '收起' }).click();

  // 4. 检查更新 → 版本对比徽章 → 升级
  await page.getByRole('button', { name: '检查更新' }).click();
  await page.getByText('v0.0.28 → v0.0.29').waitFor();
  await page.screenshot({ path: 'artifacts/packages-outdated.png', fullPage: true });
  await pwRow.getByRole('button', { name: '升级', exact: true }).click();
  await page.getByText('v0.0.29').first().waitFor();

  // 5. 规则：纳管本机文件（写入结果不变）→ 新建片段 → 开关写入 → 只写变化的端 → 预览
  await page.getByRole('tab', { name: /规则/ }).click();
  await page.getByText('还没有规则片段').waitFor();
  const codexAgentsBefore = await readFile(join(homeDir, '.codex', 'AGENTS.md'), 'utf8');
  // DSH 的 AGENTS.md 是软链：纳管确认条写明会拆分为独立文件
  const dshFileRow = page.locator('.ap-unmanaged-row', { hasText: 'DSH 原生 · AGENTS.md' });
  await dshFileRow.getByRole('button', { name: '纳管' }).click();
  await dshFileRow.locator('.ap-confirm').getByText(/是指向 .* 的软链，写入时会拆分为独立文件/).waitFor();
  await dshFileRow.locator('.ap-confirm').getByRole('button', { name: '取消' }).click();
  const codexFileRow = page.locator('.ap-unmanaged-row', { hasText: 'Codex · AGENTS.md' });
  await codexFileRow.getByRole('button', { name: '纳管' }).click();
  await codexFileRow.locator('.ap-confirm').getByText(/全文导入为只对 Codex 开启的新片段/).waitFor();
  await page.getByRole('button', { name: '确认纳管' }).click();
  await page.getByText(/已把 Codex 的 AGENTS.md 纳管为片段/).waitFor();
  assert.equal(await readFile(join(homeDir, '.codex', 'AGENTS.md'), 'utf8'), codexAgentsBefore, '纳管后 Codex 文件内容不变');
  const importedRow = page.locator('.ap-rule-row', { hasText: 'Codex 现有 AGENTS.md' });
  assert.equal(await importedRow.getByRole('switch', { name: /^Codex：写入/ }).getAttribute('aria-checked'), 'true');

  await page.getByRole('button', { name: '新建片段' }).click();
  await page.locator('#ap-rule-title-__new__').fill('DSH 私有规则');
  await page.locator('#ap-rule-content-__new__').fill('## DSH 原生私有规则\n- 简短汇报执行进展');
  assert.equal(await page.getByRole('tab', { name: /规则.*未保存/ }).count(), 1, 'Tab 标记未保存修改');
  await page.getByRole('button', { name: '添加片段' }).click();
  const dshRule = page.locator('.ap-rule-row', { hasText: 'DSH 私有规则' });
  await dshRule.waitFor();
  assert.equal(await page.getByRole('tab', { name: /未保存/ }).count(), 0);
  // DSH 的 AGENTS.md 原是指向 Codex 文件的软链：开启后拆分为独立文件，不写穿 Codex
  await dshRule.getByRole('switch', { name: /^DSH 原生：/ }).click();
  await page.getByText(/已保存规则并写入 DSH 原生/).waitFor();
  assert.equal((await lstat(join(dshHome, 'AGENTS.md'))).isSymbolicLink(), false);
  assert.equal(await readFile(join(dshHome, 'AGENTS.md'), 'utf8'), '## DSH 原生私有规则\n- 简短汇报执行进展\n');
  assert.equal(await readFile(join(homeDir, '.codex', 'AGENTS.md'), 'utf8'), codexAgentsBefore, '只写变化的端');
  // 预览 DSH 的最终写入内容
  await page.getByText('最终写入预览').click();
  await page.locator('#ap-rule-preview-harness').click();
  await page.getByRole('option', { name: /DSH 原生/ }).click();
  assert.match(await page.locator('.ap-instr-preview').innerText(), /DSH 原生私有规则/);
  // 片段排序：下移导入的片段
  await page.getByRole('button', { name: '下移 Codex 现有 AGENTS.md' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.ap-rule-row')[0]?.textContent.includes('DSH 私有规则'));
  await page.screenshot({ path: 'artifacts/packages-rules.png', fullPage: true });

  // 6. 窄屏 390：各视图无横向溢出，表头隐藏、端名并入格子，菜单不超出视口
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of [/Skills/, /MCP/, /插件/, /规则/]) {
    await page.getByRole('tab', { name }).click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 2, `移动端出现横向溢出（${name}）：${overflow}px`);
  }
  await page.getByRole('tab', { name: /MCP/ }).click();
  assert.equal(await page.locator('.ap-col-head').isVisible(), false, '窄屏隐藏端名表头');
  assert.ok(await page.locator('.ap-pkg-card .ap-cell-label').first().isVisible(), '窄屏格子显示端名');
  await page.getByRole('button', { name: 'playwright-mcp 更多操作' }).click();
  const menuBox = await page.getByRole('menu').boundingBox();
  assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= 390, `移动端菜单超出视口：${JSON.stringify(menuBox)}`);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: 'artifacts/packages-mobile.png', fullPage: true });

  // 7. 面板宽度 585：工具栏一行、表头与分组标题同一行、各行状态列对齐、标题行不换行
  await page.setViewportSize({ width: 585, height: 1000 });
  await page.getByRole('tab', { name: /Skills/ }).click();
  const searchBox = await page.locator('.ap-search').boundingBox();
  const addBox = await page.getByRole('button', { name: '添加 Skills 来源' }).boundingBox();
  assert.ok(Math.abs(searchBox.y + searchBox.height / 2 - (addBox.y + addBox.height / 2)) < 4, '面板宽度下工具栏不应换行');
  const groupTitleBox = await page.locator('.ap-matrix-group').first().locator('h3').boundingBox();
  const colHeadBox = await page.locator('.ap-col-head').first().boundingBox();
  assert.ok(Math.abs(groupTitleBox.y + groupTitleBox.height / 2 - (colHeadBox.y + colHeadBox.height / 2)) < 4, '端名表头应与分组标题同一行');
  const lefts = await page.locator('.ap-matrix .ap-cells').evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().left)));
  assert.equal(new Set(lefts).size, 1, `状态列应对齐：${lefts}`);
  const titleHeights = await page.locator('.ap-pkg-card .ap-pkg-title-row').evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().height)));
  assert.ok(titleHeights.every(h => h <= 28), `标题行不应换行：${titleHeights}`);
  await page.screenshot({ path: 'artifacts/packages-panel.png', fullPage: true });
  await page.getByRole('tab', { name: /插件/ }).click();
  await page.screenshot({ path: 'artifacts/packages-plugins-panel.png', fullPage: true });
  await page.getByRole('tab', { name: /规则/ }).click();
  await page.screenshot({ path: 'artifacts/packages-rules-panel.png', fullPage: true });

  assert.deepEqual(pageErrors, [], `页面报错：${pageErrors.join('; ')}`);
  assert.deepEqual(failedRequests, [], `请求失败：${failedRequests.join('; ')}`);
  console.log('UI 验收全部通过，截图已保存至 artifacts/');
} finally {
  await browser?.close();
  server?.close();
  await rm(base, { recursive: true, force: true });
}
