import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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
  await page.getByText('Hindsight Memory').waitFor();
  await page.screenshot({ path: 'artifacts/packages-desktop.png', fullPage: true });

  // 0. 失败路径：失败行进入「需要处理」，整行写明原因，主按钮为「重试安装」，组头有「全部同步」
  const hindsightRow = page.locator('.ap-pkg-card', { hasText: 'Hindsight Memory' });
  assert.match(await hindsightRow.getAttribute('class'), /is-error/);
  assert.match(await hindsightRow.locator('.ap-row-reason').innerText(), /Claude Code 安装失败：hindsight: command not found/);
  assert.equal(await hindsightRow.getByRole('img', { name: /^Claude Code：安装失败/ }).count(), 1);
  await page.getByRole('button', { name: '全部同步' }).waitFor();
  await hindsightRow.getByRole('button', { name: '重试安装' }).click();
  // 仍然失败：执行记录自动展开并在摘要里写明失败步数
  await page.locator('.ap-logs[open]').waitFor();
  assert.match(await page.locator('.ap-logs summary').innerText(), /1 步失败/);
  assert.match(await page.locator('.ap-banner-notice').getAttribute('class'), /is-warn/, '部分失败的提示不应使用成功色');
  await page.setViewportSize({ width: 585, height: 1000 });
  await page.screenshot({ path: 'artifacts/packages-failed-panel.png', fullPage: true });
  await page.setViewportSize({ width: 1360, height: 1000 });
  // 修复后重试成功，Hindsight 回到「已就绪」
  failHindsightClaude = false;
  await hindsightRow.getByRole('button', { name: '重试安装' }).click();
  await page.locator('.ap-matrix-group', { hasText: '全部已就绪' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '全部同步' }).count(), 0);
  assert.equal(await page.locator('.ap-logs[open]').count(), 0, '全部成功时执行记录默认折叠');

  // 0a. 信息架构：视图内工具栏、按状态分组、4 端状态列对齐且端名只在表头出现一次
  assert.equal(await page.getByRole('button', { name: '解析设置' }).count(), 0, '解析设置已收进添加面板');
  assert.equal(await page.locator('.ap-col-head').count(), 1, '包清单只应有一行端名表头');
  assert.equal(await page.locator('.ap-pkg-card .ap-cell').count(), 8, '每个包 4 个对齐状态格');
  assert.equal(await page.locator('.ap-pkg-card').first().getByRole('img', { name: /^Codex：/ }).count(), 1, '状态格应有可读的端名与状态');
  const cellLefts = await page.locator('.ap-matrix .ap-cells').evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().left)));
  assert.equal(new Set(cellLefts).size, 1, `各行状态列应与表头对齐：${cellLefts}`);
  // 默认收起详情，点包名展开仓库、备注与各端明细
  assert.equal(await page.locator('.ap-row-detail').count(), 0);
  await page.getByRole('button', { name: 'Firecrawl Skills', exact: true }).click();
  await page.locator('.ap-row-detail').getByText('网页抓取、搜索与结构化提取技能包').waitFor();
  assert.equal(await page.locator('.ap-row-detail li').count(), 4, '详情应列出 4 个目标端明细');
  await page.getByRole('button', { name: 'Firecrawl Skills', exact: true }).click();
  assert.equal(await page.locator('.ap-row-detail').count(), 0);

  // 0b. 编辑已有包时原位展开，不在下方重复展示该包的摘要卡片
  const listIndexOf = matcher => page.locator('.ap-list').evaluate((list, m) => [...list.children].findIndex(el => (m.selector ? el.matches(m.selector) : el.textContent.includes(m.text))), matcher);
  const hindsightIndex = await listIndexOf({ text: 'Hindsight Memory' });
  await page.getByRole('button', { name: 'Hindsight Memory 更多操作' }).click();
  await page.getByRole('menuitem', { name: '编辑' }).click();
  await page.getByRole('heading', { name: '编辑 hindsight' }).waitFor();
  assert.equal(await page.locator('.ap-list > .ap-editor').count(), 1, '编辑已有包应在列表原位展开');
  assert.equal(await page.locator('.ap-pkg-card').count(), 1, '编辑时不应重复展示当前包的摘要卡片');
  assert.equal(await page.locator('.ap-pkg-card', { hasText: 'Hindsight Memory' }).count(), 0);
  assert.equal(await listIndexOf({ selector: '.ap-editor' }), hindsightIndex, '编辑面板应占据该包原来的行位置');
  // 编辑期间若被筛选条件排除，仍回落到顶部保留编辑状态
  await page.locator('.ap-search').fill('Firecrawl');
  assert.equal(await page.locator('.ap-editor').count(), 1, '被筛选排除时仍应保留编辑面板');
  assert.equal(await page.locator('.ap-list > .ap-editor').count(), 0);
  await page.locator('.ap-search').fill('');
  assert.equal(await page.locator('.ap-list > .ap-editor').count(), 1);
  await page.getByRole('button', { name: '收起' }).click();
  assert.equal(await page.locator('.ap-editor').count(), 0);
  assert.equal(await page.locator('.ap-pkg-card').count(), 2, '收起后应恢复全部包卡片');

  // 1. 打开添加包 → 解析 GitHub 仓库 → 截图 → 保存并安装
  await page.getByRole('button', { name: '添加包' }).click();
  await page.locator('#ap-repo').fill('microsoft/playwright-mcp');
  await page.getByRole('button', { name: '解析仓库' }).click();
  await page.locator('.ap-evidence').waitFor();
  assert.equal(await page.locator('#ap-version').inputValue(), '0.0.28');
  // 折叠的「高级设置」摘要仍显示解析出的锁定版本
  assert.match(await page.locator('.ap-editor .ap-advanced summary').innerText(), /0\.0\.28/);
  // 验证 MCP 环境变量 Key-Value 表单的新增、输入与删除
  await page.locator('#ap-mcp-env-key-0').fill('FIRECRAWL_API_KEY');
  await page.locator('#ap-mcp-env-val-0').fill('fc-demo-key');
  await page.getByRole('button', { name: '添加变量' }).click();
  await page.locator('#ap-mcp-env-key-1').fill('HTTPS_PROXY');
  await page.getByRole('button', { name: '添加变量' }).click();
  await page.getByRole('button', { name: '删除第 3 行环境变量' }).click();
  assert.equal(await page.locator('.ap-kv-row').count(), 2, '删除后应保留 2 行环境变量');
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
  await page.getByText('playwright-mcp').first().waitFor();
  // 重新打开编辑核对 Key-Value 与留空引用均正确回显
  await page.getByRole('button', { name: 'playwright-mcp 更多操作' }).click();
  await page.getByRole('menuitem', { name: '编辑' }).click();
  assert.equal(await page.locator('#ap-mcp-env-key-0').inputValue(), 'FIRECRAWL_API_KEY');
  assert.equal(await page.locator('#ap-mcp-env-val-0').inputValue(), 'fc-demo-key');
  assert.equal(await page.locator('#ap-mcp-env-key-1').inputValue(), 'HTTPS_PROXY');
  assert.equal(await page.locator('#ap-mcp-env-val-1').inputValue(), '');
  await page.getByRole('button', { name: '收起' }).click();

  // 1b. 解析 CodeGraph 类 CLI 安装器仓库：校验自动识别为自定义安装器、填充全局与 4 端命令及对齐
  await page.getByRole('button', { name: '添加包' }).click();
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
  // 主动预览的执行记录默认展开，状态显示为中文
  await page.getByText('全局 CLI').first().waitFor();
  assert.match(await page.locator('.ap-logs summary').innerText(), /仅预览，未写入/);
  assert.equal(await page.locator('.ap-log-top .ap-badge', { hasText: /^ok$/ }).count(), 0, '执行状态不应显示原始值');
  await page.getByRole('button', { name: '收起' }).click();
  // 预览只保存不安装：codegraph 进入「需要处理」，写明未安装的端，主按钮为「安装」
  const codegraphPkgRow = page.locator('.ap-pkg-card', { hasText: 'codegraph' });
  assert.match(await codegraphPkgRow.locator('.ap-row-reason').innerText(), /尚未安装到 Codex、Claude Code、Antigravity、DSH 原生/);
  assert.equal(await codegraphPkgRow.getByRole('button', { name: '安装', exact: true }).count(), 1);
  // 删除测试中保存的 codegraph 预览项：危险操作先在行内确认，取消不执行
  await page.getByRole('button', { name: 'codegraph 更多操作' }).click();
  await page.getByRole('menuitem', { name: '从清单移除' }).click();
  await page.locator('.ap-confirm').getByText('将从清单移除 codegraph').waitFor();
  assert.equal(await page.locator('.ap-pkg-card', { hasText: 'codegraph' }).count(), 1, '确认前不应移除');
  await page.getByRole('button', { name: '确认移除' }).click();
  await page.locator('.ap-pkg-card', { hasText: 'codegraph' }).waitFor({ state: 'detached' });

  // 1c. 全局解析设置（在添加面板内切换）：Codex + 选择模型 → 深度分析仓库 → 校验 AI 摘要与提示 → 切回静态规则
  await page.getByRole('button', { name: '添加包' }).click();
  await page.getByRole('button', { name: '切换', exact: true }).click();
  await page.getByRole('heading', { name: '全局解析设置' }).waitFor();
  assert.equal(await page.locator('.ap-editor .ap-settings-card').count(), 1, '解析设置应在添加面板内展开');
  await page.locator('#ap-analyzer-harness').click();
  await page.getByRole('option', { name: /Codex/ }).click();
  await page.locator('#ap-analyzer-model').waitFor();
  await page.locator('#ap-analyzer-model').click();
  await page.getByRole('option', { name: /GPT-6\.2-Sol/ }).click();
  await page.screenshot({ path: 'artifacts/packages-analyzer-settings.png', fullPage: true });
  await page.getByRole('button', { name: '保存设置' }).click();
  await page.getByText(/已保存全局解析配置：Codex · gpt-6\.2-sol/).waitFor();
  assert.equal(await page.locator('.ap-settings-card').count(), 0, '保存后收起设置，回到添加面板');
  await page.getByText(/当前解析：Codex · gpt-6\.2-sol（深度模式）/).waitFor();
  await page.locator('#ap-repo').fill('https://github.com/colbymchenry/codegraph.git');
  await page.getByRole('button', { name: '解析仓库' }).click();
  await page.locator('.ap-ai-evidence').waitFor();
  assert.match(await page.locator('.ap-ai-evidence').innerText(), /深度分析 · Codex \(gpt-6\.2-sol\)/);
  assert.match(await page.locator('.ap-ai-evidence').innerText(), /首次接入后请重启对应 Harness 会话/);
  assert.equal(await page.locator('#ap-cmd-install-codex').inputValue(), 'codegraph install --target codex --yes');
  await page.screenshot({ path: 'artifacts/packages-ai-analysis.png', fullPage: true });
  await page.getByRole('button', { name: '收起' }).click();

  // 恢复默认静态规则设置，确保后续用例洁净
  await page.getByRole('button', { name: '添加包' }).click();
  await page.getByRole('button', { name: '切换', exact: true }).click();
  await page.locator('#ap-analyzer-harness').click();
  await page.getByRole('option', { name: /静态规则/ }).click();
  await page.getByRole('button', { name: '保存设置' }).click();
  await page.getByText(/当前解析：静态规则/).waitFor();
  await page.getByRole('button', { name: '收起' }).click();

  // 2. 检查更新并验证出现版本对比徽章与状态化主按钮，再点击升级
  await page.getByRole('button', { name: '检查更新' }).click();
  await page.getByText('v0.0.28 → v0.0.29').waitFor();
  // 有新版本的包进入「需要处理」分组，组头提供批量升级
  const attentionNames = await page.locator('.ap-pkg-card.is-warn, .ap-pkg-card.is-error').allInnerTexts();
  assert.ok(attentionNames.some(text => text.includes('playwright-mcp')), '可升级的包应在需要处理分组');
  await page.getByRole('button', { name: '全部升级（1）' }).waitFor();
  await page.screenshot({ path: 'artifacts/packages-outdated.png', fullPage: true });

  await page.getByRole('button', { name: '升级', exact: true }).click();
  await page.getByText('v0.0.29').first().waitFor();
  // 所有目标端已装齐且无更新时，卡片不再显示多余的「安装」按钮
  assert.equal(await page.getByRole('button', { name: '安装', exact: true }).count(), 0);

  // 打开「更多」菜单验证清晰的卸载/移除区分；确认条写明受影响的端，取消后不执行
  await page.getByRole('button', { name: 'playwright-mcp 更多操作' }).click();
  await page.getByRole('menuitem', { name: '卸载并移除' }).click();
  const confirmText = await page.locator('.ap-confirm').innerText();
  assert.match(confirmText, /Codex、Claude Code、Antigravity/);
  assert.match(confirmText, /确认卸载并移除/);
  await page.locator('.ap-confirm').screenshot({ path: 'artifacts/packages-confirm.png' });
  await page.locator('.ap-confirm').getByRole('button', { name: '取消' }).click();
  assert.equal(await page.locator('.ap-confirm').count(), 0);
  assert.equal(await page.locator('.ap-pkg-card', { hasText: 'playwright-mcp' }).count(), 1, '取消后包仍在');

  // 2b. 全局指令维护：原样导入现有内容、编辑私有内容、查看合并预览、软链拆分同步
  await page.getByRole('tab', { name: '全局指令' }).click();
  await page.getByRole('heading', { name: 'AGENTS.md / CLAUDE.md' }).waitFor();
  // 导入来源收进「从文件导入」菜单，私有内容只用一个 Harness 下拉框切换；不再有按端启用开关
  assert.equal(await page.locator('#ap-instr-import-source, #ap-instr-enabled').count(), 0);
  assert.equal(await page.getByRole('button', { name: /更多操作/ }).count(), 0, '全局指令页不再有「更多」菜单');
  assert.equal(await page.getByText(/外部标记块/).count(), 0, '不再提示自动保留外部标记块');
  assert.equal(await page.getByRole('button', { name: '预览变更' }).count(), 0, '全局指令页不再有「预览变更」');
  // 公共与私有均为空、草稿无修改：没有可同步的内容，不显示同步按钮
  assert.equal(await page.getByRole('button', { name: '同步', exact: true }).count(), 0);
  await page.getByRole('button', { name: '从文件导入 ▾' }).click();
  await page.getByRole('menuitem', { name: /Claude Code/ }).waitFor();
  assert.ok(await page.getByRole('menuitem', { name: /Claude Code/ }).isDisabled(), '未创建文件的端不可导入');
  await page.getByRole('menuitem', { name: /Codex/ }).click();
  await page.getByText('已从 Codex（AGENTS.md）导入到公共内容').waitFor();
  assert.match(await page.locator('#ap-instr-shared').inputValue(), /# 全局协作规则/);
  // 原样导入：外部工具写入的 CODEGRAPH 块也进入公共内容，由用户自行决定去留
  assert.match(await page.locator('#ap-instr-shared').inputValue(), /CODEGRAPH_START/);
  await page.locator('#ap-instr-private').fill('## Codex 私有规则\n- 优先运行最小单测验证');
  // 有未保存修改时，Tab 上带标记，切到其他视图也能看到
  assert.equal(await page.getByRole('tab', { name: /全局指令.*未保存/ }).count(), 1, 'Tab 应标记未保存修改');
  // 最终写入预览默认折叠，展开后实时显示 公共 + 私有
  assert.equal(await page.locator('.ap-instr-preview').isVisible(), false);
  await page.getByText('最终写入预览').click();
  const codexPreview = await page.locator('.ap-instr-preview').innerText();
  assert.match(codexPreview, /# 全局协作规则/);
  assert.match(codexPreview, /## Codex 私有规则/);
  assert.match(codexPreview, /<!-- CODEGRAPH_START -->/);
  await page.screenshot({ path: 'artifacts/packages-instructions.png', fullPage: true });

  // Harness 下拉框与「私有内容」标题同一行，宽度按内容收窄
  const privateTitleBox = await page.getByRole('heading', { name: '私有内容' }).boundingBox();
  const harnessSelectBox = await page.locator('#ap-instr-harness').boundingBox();
  assert.ok(Math.abs(harnessSelectBox.y - privateTitleBox.y) < 12, '下拉框应与私有内容标题对齐');
  assert.ok(harnessSelectBox.width < 220, `下拉框不应拉伸：${harnessSelectBox.width}px`);

  // 切换到 DSH 原生（软链目标），验证软链提示并保存同步
  await page.locator('#ap-instr-harness').click();
  await page.getByRole('option', { name: /DSH 原生/ }).click();
  assert.match(await page.locator('#ap-instr-harness').innerText(), /DSH 原生/);
  await page.getByText(/同步时将拆分为独立文件写入/).waitFor();
  await page.locator('#ap-instr-private').fill('## DSH 原生私有规则\n- 简短汇报执行进展');
  await page.getByRole('button', { name: '保存并同步', exact: true }).click();
  await page.getByText(/已保存并同步指令文件/).waitFor();
  // 全部端已同步且无修改：同步按钮隐藏
  assert.equal(await page.getByRole('button', { name: /同步/ }).count(), 0, '已全部同步时不应显示同步按钮');
  assert.equal(await page.getByText(/同步时将拆分为独立文件写入/).count(), 0, '同步后软链应已拆分为独立文件');
  assert.equal(await page.getByRole('tab', { name: /未保存/ }).count(), 0, '保存后 Tab 标记消失');
  assert.equal(await page.locator('.ap-logs').count(), 1, '同步记录显示在全局指令视图');

  // 3. 切换本机诊断：提示与执行记录不跨视图残留；矩阵汇总 4 端分布；本机导入已移除
  await page.getByRole('tab', { name: '本机诊断' }).click();
  assert.equal(await page.locator('.ap-logs').count(), 0, '执行记录不应跨视图显示');
  assert.equal(await page.locator('.ap-banner-notice').count(), 0, '提示不应跨视图显示');
  // 切换不自动扫描，需手动点击「开始扫描」
  await page.getByText(/尚未扫描/).waitFor();
  assert.equal(await page.locator('.ap-doctor-matrix').count(), 0);
  await page.screenshot({ path: 'artifacts/packages-doctor-idle.png', clip: { x: 0, y: 0, width: 1360, height: 360 } });
  await page.getByRole('button', { name: '开始扫描' }).click();
  await page.getByText(/检测到旧版目录/).waitFor();
  const codegraphRow = page.locator('.ap-doctor-matrix .ap-matrix-row', { hasText: 'codegraph' });
  await codegraphRow.waitFor();
  assert.match(await codegraphRow.innerText(), /未纳管/);
  assert.equal(await codegraphRow.getByRole('img', { name: /^Codex：未纳管/ }).count(), 1);
  assert.equal(await codegraphRow.getByRole('img', { name: /^DSH 原生：未配置/ }).count(), 1);
  const playwrightRow = page.locator('.ap-doctor-matrix .ap-matrix-row', { hasText: 'playwright-mcp' });
  assert.match(await playwrightRow.innerText(), /受管：playwright-mcp/);
  const ponytailRows = page.locator('.ap-doctor-matrix .ap-matrix-row', { hasText: 'ponytail' });
  assert.equal(await ponytailRows.count(), 1, '跨端同名插件应合并为一行');
  assert.match(await ponytailRows.innerText(), /ponytail@ponytail/);
  assert.equal(await ponytailRows.getByRole('img', { name: /^Claude Code：未纳管 1\.2\.0/ }).count(), 1);
  assert.equal(await ponytailRows.getByRole('img', { name: /^Antigravity：未纳管/ }).count(), 1);
  assert.equal(await page.locator('#ap-doctor-harness').count(), 0, '不再需要逐端下拉切换');
  assert.equal(await page.getByRole('button', { name: '导入清单' }).count(), 0);
  const doctorLefts = await page.locator('.ap-doctor-matrix .ap-cells').evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().left)));
  assert.equal(new Set(doctorLefts).size, 1, `诊断矩阵状态列应对齐：${doctorLefts}`);
  await page.screenshot({ path: 'artifacts/packages-doctor.png', fullPage: true });

  // 4. 窄屏移动端检查无横向溢出（涵盖本机诊断、全局指令与包清单）
  await page.setViewportSize({ width: 390, height: 844 });
  const doctorOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(doctorOverflow <= 2, `移动端本机诊断页出现横向溢出：${doctorOverflow}px`);
  await page.getByRole('tab', { name: '全局指令' }).click();
  await page.getByRole('heading', { name: 'AGENTS.md / CLAUDE.md' }).waitFor();
  const instrOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(instrOverflow <= 2, `移动端全局指令页出现横向溢出：${instrOverflow}px`);
  await page.screenshot({ path: 'artifacts/packages-instructions-mobile.png', fullPage: true });
  // 展开的菜单在窄屏下也不能撑出横向滚动
  for (const name of ['从文件导入 ▾']) {
    await page.getByRole('button', { name }).click();
    await page.getByRole('menu').waitFor();
    const menuBox = await page.getByRole('menu').boundingBox();
    assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= 390, `移动端菜单超出视口：${JSON.stringify(menuBox)}`);
    await page.keyboard.press('Escape');
    await page.mouse.click(5, 5);
  }
  // 与设置面板实际宽度（约 585px）一致的截图
  await page.setViewportSize({ width: 585, height: 1000 });
  await page.screenshot({ path: 'artifacts/packages-instructions-panel.png', fullPage: true });
  // 面板宽度下的编辑态：长公共内容（编辑器随内容增高并封顶）、未保存页头与展开的导入菜单
  const longShared = Array.from({ length: 90 }, (_, i) => `- 第 ${i + 1} 条规则`).join('\n');
  await page.locator('#ap-instr-shared').fill(longShared);
  await page.getByText('未保存修改').waitFor();
  // 未保存时标题与「还原 / 仅保存 / 保存并同步」保持同一行
  const instrTitleBox = await page.getByRole('heading', { name: 'AGENTS.md / CLAUDE.md' }).boundingBox();
  const saveSyncBox = await page.getByRole('button', { name: '保存并同步', exact: true }).boundingBox();
  assert.ok(Math.abs(instrTitleBox.y + instrTitleBox.height / 2 - (saveSyncBox.y + saveSyncBox.height / 2)) < 6, '面板宽度下操作按钮不应换行到标题下方');
  const editorHeight = (await page.locator('#ap-instr-shared').boundingBox()).height;
  assert.ok(editorHeight > 300 && editorHeight <= 1000 * 0.6 + 2, `长内容编辑器高度异常：${editorHeight}`);
  await page.getByRole('button', { name: '从文件导入 ▾' }).click();
  await page.getByRole('menu').waitFor();
  await page.screenshot({ path: 'artifacts/packages-instructions-panel-dirty.png' });
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  // 面板宽度下包清单工具栏（搜索、筛选、检查更新、添加包）保持同一行，状态列仍对齐
  await page.getByRole('tab', { name: /包清单/ }).click();
  const searchBox = await page.locator('.ap-search').boundingBox();
  const addBox = await page.getByRole('button', { name: '添加包' }).boundingBox();
  assert.ok(Math.abs(searchBox.y + searchBox.height / 2 - (addBox.y + addBox.height / 2)) < 4, '面板宽度下工具栏不应换行');
  assert.ok(await page.locator('.ap-col-head').isVisible(), '面板宽度下保留端名表头');
  const panelLefts = await page.locator('.ap-matrix .ap-cells').evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().left)));
  assert.equal(new Set(panelLefts).size, 1, `面板宽度下状态列应对齐：${panelLefts}`);
  await page.screenshot({ path: 'artifacts/packages-panel.png', fullPage: true });
  await page.getByRole('tab', { name: '全局指令' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: /包清单/ }).click();
  await page.getByText('Firecrawl Skills').waitFor();
  // 验证包清单筛选自定义下拉框可展开与筛选
  await page.locator('#ap-filter-kind').click();
  await page.getByRole('option', { name: 'MCP Server' }).click();
  assert.equal(await page.locator('.ap-pkg-card').count(), 1, '按 MCP Server 筛选应只展示 1 个包');
  await page.locator('#ap-filter-kind').click();
  await page.getByRole('option', { name: '全部类型' }).click();
  assert.equal(await page.locator('.ap-pkg-card').count(), 3, '切回全部类型应恢复全部包');
  // 无匹配时给出「清除筛选」
  await page.locator('.ap-search').fill('不存在的包');
  await page.getByRole('button', { name: '清除筛选' }).click();
  assert.equal(await page.locator('.ap-pkg-card').count(), 3, '清除筛选应恢复全部包');
  // 窄屏：表头隐藏，状态格换到第二行并显示端名
  assert.equal(await page.locator('.ap-col-head').isVisible(), false, '窄屏隐藏端名表头');
  assert.ok(await page.locator('.ap-pkg-card .ap-cell-label').first().isVisible(), '窄屏状态格应显示端名');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 2, `移动端出现横向溢出：${overflow}px`);
  await page.screenshot({ path: 'artifacts/packages-mobile.png', fullPage: true });

  assert.deepEqual(pageErrors, [], `页面报错：${pageErrors.join('; ')}`);
  assert.deepEqual(failedRequests, [], `请求失败：${failedRequests.join('; ')}`);
  console.log('UI 验收全部通过，截图已保存至 artifacts/');
} finally {
  await browser?.close();
  server?.close();
  await rm(base, { recursive: true, force: true });
}
