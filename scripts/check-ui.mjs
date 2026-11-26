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
  await writeFile(join(homeDir, '.codex', 'config.toml'), '[mcp_servers.codegraph]\ncommand = "codegraph"\nargs = ["serve"]\n');
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
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };

  const service = new PackageManagerService({
    root,
    homeDir,
    dshHome,
    fetchImpl: mockFetch,
    githubToken: '',
    runShell: async cmd => ({ stdout: `模拟执行成功：${cmd}`, stderr: '' }),
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

  // 1. 打开添加包 → 解析 GitHub 仓库 → 截图 → 保存并安装
  await page.getByRole('button', { name: '添加包' }).click();
  await page.getByLabel(/^GitHub 地址/).fill('microsoft/playwright-mcp');
  await page.getByRole('button', { name: '解析仓库' }).click();
  await page.locator('.ap-evidence').waitFor();
  assert.equal(await page.getByLabel('锁定版本号（供 {{version}} 替换）').inputValue(), '0.0.28');
  await page.screenshot({ path: 'artifacts/packages-editor.png', fullPage: true });

  await page.getByRole('button', { name: '保存并安装' }).click();
  await page.getByText('playwright-mcp').first().waitFor();

  // 2. 检查更新并验证出现可升级徽章，再点击升级
  await page.getByRole('button', { name: '检查更新' }).click();
  await page.getByText('可升级 → 0.0.29').waitFor();
  await page.screenshot({ path: 'artifacts/packages-outdated.png', fullPage: true });

  await page.getByRole('button', { name: '升级', exact: true }).click();
  await page.getByText('当前：0.0.29').waitFor();

  // 3. 切换本机扫描与诊断，验证告警和一键导入
  await page.getByRole('tab', { name: '本机扫描与诊断' }).click();
  await page.getByText(/检测到旧版目录/).waitFor();
  await page.getByText('codegraph（STDIO MCP）').waitFor();
  await page.screenshot({ path: 'artifacts/packages-doctor.png', fullPage: true });

  await page.getByRole('button', { name: '导入清单' }).click();
  await page.getByText(/已导入「codegraph」/).waitFor();

  // 4. 窄屏移动端检查无横向溢出
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: /包清单/ }).click();
  await page.getByText('Firecrawl Skills').waitFor();
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
