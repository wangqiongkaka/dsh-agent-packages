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
  await writeFile(join(homeDir, '.codex', 'models_cache.json'), JSON.stringify({
    models: [
      { slug: 'gpt-6.2-sol', display_name: 'GPT-6.2-Sol', visibility: 'list' },
      { slug: 'o4-mini', display_name: 'o4-mini', visibility: 'list' },
    ],
  }));
  await mkdir(join(homeDir, '.gemini', 'skills', 'legacy-firecrawl'), { recursive: true });
  await mkdir(join(homeDir, '.gemini', 'config', 'skills'), { recursive: true });
  await symlink(join(base, 'deleted-skill'), join(homeDir, '.gemini', 'config', 'skills', 'stale-link'));

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
    runShell: async cmd => ({ stdout: `模拟执行成功：${cmd}`, stderr: '' }),
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

  // 0. 编辑已有包时原位展开，不在下方重复展示该包的摘要卡片
  await page.locator('.ap-pkg-card').nth(1).getByRole('button', { name: '编辑' }).click();
  await page.getByRole('heading', { name: '编辑 hindsight' }).waitFor();
  assert.equal(await page.locator('.ap-list > .ap-editor').count(), 1, '编辑已有包应在列表原位展开');
  assert.equal(await page.locator('.ap-pkg-card').count(), 1, '编辑时不应重复展示当前包的摘要卡片');
  assert.equal(await page.locator('.ap-pkg-card', { hasText: 'Hindsight Memory' }).count(), 0);
  const firstCardBox = await page.locator('.ap-pkg-card').first().boundingBox();
  const inlineEditorBox = await page.locator('.ap-list > .ap-editor').boundingBox();
  assert.ok(firstCardBox && inlineEditorBox && firstCardBox.y < inlineEditorBox.y, '编辑第 2 个包时应保持原位置顺序');
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
  assert.match(await page.locator('.ap-advanced summary').innerText(), /0\.0\.28/);
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
  await narrow.evaluate(el => el.remove());

  await page.getByRole('button', { name: '保存并安装' }).click();
  await page.getByText('playwright-mcp').first().waitFor();

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
  await page.getByText('全局 CLI').first().waitFor();
  await page.getByRole('button', { name: '收起' }).click();
  // 删除测试中保存的 codegraph 预览项，保持后续包数量断言一致
  await page.getByRole('button', { name: 'codegraph 更多操作' }).click();
  await page.getByRole('menuitem', { name: '从清单移除' }).click();

  // 1c. 全局解析设置：切换为 Codex + 选择模型 → 深度分析仓库 → 校验 AI 摘要与提示 → 切回静态规则
  await page.getByRole('button', { name: '解析设置' }).click();
  await page.getByRole('heading', { name: '全局解析设置' }).waitFor();
  await page.locator('#ap-analyzer-harness').click();
  await page.getByRole('option', { name: /Codex/ }).click();
  await page.locator('#ap-analyzer-model').waitFor();
  await page.locator('#ap-analyzer-model').click();
  await page.getByRole('option', { name: /GPT-6\.2-Sol/ }).click();
  await page.screenshot({ path: 'artifacts/packages-analyzer-settings.png', fullPage: true });
  await page.getByRole('button', { name: '保存设置' }).click();
  await page.getByText(/已保存全局解析配置：Codex · gpt-6\.2-sol/).waitFor();

  await page.getByRole('button', { name: '添加包' }).click();
  await page.getByText(/当前解析：Codex · gpt-6\.2-sol（深度模式）/).waitFor();
  await page.locator('#ap-repo').fill('https://github.com/colbymchenry/codegraph.git');
  await page.getByRole('button', { name: '解析仓库' }).click();
  await page.locator('.ap-ai-evidence').waitFor();
  assert.match(await page.locator('.ap-ai-evidence').innerText(), /深度分析 · Codex \(gpt-6\.2-sol\)/);
  assert.match(await page.locator('.ap-ai-evidence').innerText(), /首次接入后请重启对应 Harness 会话/);
  await page.screenshot({ path: 'artifacts/packages-ai-analysis.png', fullPage: true });
  await page.getByRole('button', { name: '收起' }).click();

  // 恢复默认静态规则设置，确保后续用例洁净
  await page.getByRole('button', { name: '解析设置' }).click();
  await page.locator('#ap-analyzer-harness').click();
  await page.getByRole('option', { name: /静态规则/ }).click();
  await page.getByRole('button', { name: '保存设置' }).click();

  // 2. 检查更新并验证出现版本对比徽章与状态化主按钮，再点击升级
  await page.getByRole('button', { name: '检查更新' }).click();
  await page.getByText('v0.0.28 → v0.0.29').waitFor();
  await page.screenshot({ path: 'artifacts/packages-outdated.png', fullPage: true });

  await page.getByRole('button', { name: '升级', exact: true }).click();
  await page.getByText('v0.0.29').first().waitFor();
  // 所有目标端已装齐且无更新时，卡片不再显示多余的「安装」按钮
  assert.equal(await page.getByRole('button', { name: '安装', exact: true }).count(), 0);

  // 打开「更多」菜单验证清晰的卸载/移除区分
  await page.getByRole('button', { name: 'playwright-mcp 更多操作' }).click();
  await page.getByRole('menuitem', { name: '卸载并移除' }).waitFor();
  await page.keyboard.press('Escape');

  // 3. 切换本机诊断，验证只读告警与单 Harness 下拉框切换；本机导入已移除
  await page.getByRole('tab', { name: '本机诊断' }).click();
  await page.getByText(/检测到旧版目录/).waitFor();
  await page.getByText('codegraph').waitFor();
  assert.equal(await page.locator('.ap-doctor-card').count(), 1, '本机诊断一次应仅展示一个 Harness 卡片');
  assert.match(await page.locator('#ap-doctor-harness').innerText(), /Codex/);
  assert.equal(await page.getByRole('button', { name: '导入清单' }).count(), 0);
  await page.screenshot({ path: 'artifacts/packages-doctor.png', fullPage: true });

  // 通过自定义下拉框切换 Harness，验证单卡片内容同步更新
  await page.locator('#ap-doctor-harness').click();
  assert.equal(await page.getByRole('option').count(), 4, 'Harness 下拉框应列出全部 4 个端');
  await page.getByRole('option', { name: /DSH 原生/ }).click();
  assert.equal(await page.locator('.ap-doctor-card').count(), 1);
  assert.match(await page.locator('#ap-doctor-harness').innerText(), /DSH 原生/);
  assert.equal(await page.getByText('codegraph').count(), 0, '切换到 DSH 原生后不应再显示 Codex 的 MCP');
  await page.getByText('该端暂无已配置的 MCP Server 或已装插件。').waitFor();

  // 4. 窄屏移动端检查无横向溢出（涵盖本机诊断与包清单）
  await page.setViewportSize({ width: 390, height: 844 });
  const doctorOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(doctorOverflow <= 2, `移动端本机诊断页出现横向溢出：${doctorOverflow}px`);
  await page.getByRole('tab', { name: /包清单/ }).click();
  await page.getByText('Firecrawl Skills').waitFor();
  // 验证包清单筛选自定义下拉框可展开与筛选
  await page.locator('#ap-filter-kind').click();
  await page.getByRole('option', { name: 'MCP Server' }).click();
  assert.equal(await page.locator('.ap-pkg-card').count(), 1, '按 MCP Server 筛选应只展示 1 个包');
  await page.locator('#ap-filter-kind').click();
  await page.getByRole('option', { name: '全部类型' }).click();
  assert.equal(await page.locator('.ap-pkg-card').count(), 3, '切回全部类型应恢复全部包');
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
