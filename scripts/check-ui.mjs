import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { PackageManagerService } from '../src/service.mjs';
import { apiHandler, ENDPOINT } from '../src/api.mjs';
import { readCodexMcpServers, readJsonMcpServers } from '../src/config-editors.mjs';

// 验收只用临时目录，避免经环境变量读到本机真实的 Claude / Codex 配置
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;

const base = await mkdtemp(join(tmpdir(), 'ap-ui-'));
const homeDir = join(base, 'home');
const dshHome = join(homeDir, '.dsh');
const claudeDir = join(homeDir, '.claude');
const codexDir = join(homeDir, '.codex');
const agyDir = join(homeDir, '.gemini', 'config');
let server;
let browser;

async function makeSkill(dir, name) {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
}

// 模拟三端插件 CLI：真实改写各端记录文件，页面按读回的记录判断是否翻转
const calls = [];
let failCodexMarketplace = false;
async function fakeCli(argv) {
  calls.push(argv.join(' '));
  if (failCodexMarketplace && argv[0] === 'codex' && argv[2] === 'marketplace') {
    throw new Error(`${argv.join(' ')} 退出码 1：fatal: repository 'https://github.com/acme/extras.git/' not found`);
  }
  const [bin, , sub, a, b] = argv;
  if (bin === 'claude' && sub === 'marketplace' && a === 'add') {
    const file = join(claudeDir, 'plugins', 'known_marketplaces.json');
    const known = JSON.parse(await readFile(file, 'utf8'));
    known[b.split('/').pop()] = { source: { source: 'github', repo: b }, installLocation: join(claudeDir, 'plugins', 'marketplaces', b.split('/').pop()) };
    await writeFile(file, JSON.stringify(known));
  } else if (bin === 'claude' && (sub === 'install' || sub === 'uninstall')) {
    const file = join(claudeDir, 'plugins', 'installed_plugins.json');
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (sub === 'install') data.plugins[a] = [{ scope: 'user', version: '1.0.0', installPath: join(claudeDir, 'plugins', 'cache', a) }];
    else delete data.plugins[a];
    await writeFile(file, JSON.stringify(data));
  } else if (bin === 'codex' && sub === 'marketplace' && a === 'add') {
    const file = join(codexDir, 'config.toml');
    await writeFile(file, `${await readFile(file, 'utf8')}\n[marketplaces.${b.split('/').pop()}]\nsource_type = "git"\nsource = "https://github.com/${b}.git"\n`);
  } else if (bin === 'codex' && sub === 'add') {
    const file = join(codexDir, 'config.toml');
    await writeFile(file, `${await readFile(file, 'utf8')}\n[plugins."${a}"]\nenabled = true\n`);
  } else if (bin === 'agy' && sub === 'install') {
    const name = a.split('/').pop().split('@')[0];
    await mkdir(join(agyDir, 'plugins', name), { recursive: true });
    await writeFile(join(agyDir, 'plugins', name, 'plugin.json'), '{"version":"1.0.0"}');
  } else if (bin === 'agy' && sub === 'uninstall') {
    await rm(join(agyDir, 'plugins', a), { recursive: true, force: true });
  }
  return { command: argv.join(' '), stdout: 'ok', stderr: '' };
}

try {
  // —— Skills：notes 只在 Claude（实体目录）；other 只在 Codex；shared-a / shared-b 四端一致；stale 在 Antigravity 是失效软链
  const source = join(homeDir, '.agents', 'skills');
  await makeSkill(join(claudeDir, 'skills'), 'notes');
  await makeSkill(join(codexDir, 'skills'), 'other');
  for (const name of ['shared-a', 'shared-b']) {
    await makeSkill(source, name);
    for (const dir of [join(codexDir, 'skills'), join(claudeDir, 'skills'), join(agyDir, 'skills'), join(dshHome, 'skills')]) {
      await mkdir(dir, { recursive: true });
      await symlink(join(source, name), join(dir, name));
    }
  }
  await symlink(join(base, 'deleted'), join(agyDir, 'skills', 'stale'));

  // —— MCP：Codex 有 codegraph；Claude 有 playwright（带 alwaysLoad 与环境变量引用）
  await writeFile(join(codexDir, 'config.toml'), [
    'model = "gpt-6.2-sol"',
    '',
    '[mcp_servers.codegraph]',
    'command = "codegraph"',
    'args = ["serve", "--mcp"]',
    '',
    '[mcp_servers.hindsight]',
    'command = "node"',
    'args = ["mcp-server.js"]',
    '',
    '[mcp_servers.hindsight.env]',
    'HINDSIGHT_MCP_HARNESS = "codex"',
    '',
    '[marketplaces.openai-bundled]',
    'source_type = "local"',
    `source = "${join(codexDir, 'bundled')}"`,
    '',
    '[plugins."browser@openai-bundled"]',
    'enabled = true',
    '',
  ].join('\n'));
  await writeFile(join(homeDir, '.claude.json'), JSON.stringify({
    theme: 'dark',
    mcpServers: {
      playwright: { type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'], env: { TOKEN: '${TOKEN}' }, alwaysLoad: true },
      hindsight: { type: 'stdio', command: 'node', args: ['mcp-server.js'], env: { HINDSIGHT_MCP_HARNESS: 'claude-code' } },
    },
  }, null, 2) + '\n');

  // —— 插件：Claude 已添加市场 tools（本地目录含 tidy 与 lint 两个插件），已装 tidy
  const mpRoot = join(claudeDir, 'plugins', 'marketplaces', 'tools');
  await mkdir(join(mpRoot, '.claude-plugin'), { recursive: true });
  for (const name of ['tidy', 'lint']) await mkdir(join(mpRoot, 'plugins', name), { recursive: true });
  await writeFile(join(mpRoot, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'tools',
    plugins: [
      { name: 'tidy', description: '整理代码风格', version: '1.0.0', source: './plugins/tidy' },
      { name: 'lint', description: '静态检查', version: '0.3.0', source: './plugins/lint' },
    ],
  }));
  await writeFile(join(claudeDir, 'plugins', 'known_marketplaces.json'), JSON.stringify({ tools: { source: { source: 'github', repo: 'acme/tools' }, installLocation: mpRoot } }));
  await writeFile(join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'tidy@tools': [{ scope: 'user', version: '1.0.0', installPath: join(mpRoot, 'plugins', 'tidy') }] } }));

  // —— 插件自带的 Skill 与 MCP：tidy 带 tidy-helper 与 tidy-mcp，已落到 DSH Skills 目录与 Codex 配置
  await makeSkill(join(mpRoot, 'plugins', 'tidy', 'skills'), 'tidy-helper');
  await writeFile(join(mpRoot, 'plugins', 'tidy', '.mcp.json'), JSON.stringify({ mcpServers: { 'tidy-mcp': { command: 'tidy-mcp' } } }));
  await makeSkill(join(dshHome, 'skills'), 'tidy-helper');
  await writeFile(join(codexDir, 'config.toml'), `${await readFile(join(codexDir, 'config.toml'), 'utf8')}\n[mcp_servers.tidy-mcp]\ncommand = "tidy-mcp"\n`);

  // —— 规则：Codex 有 AGENTS.md，DSH 的 AGENTS.md 是指向它的软链
  await writeFile(join(codexDir, 'AGENTS.md'), '# 全局协作规则\n\n- 所有回复使用中文。\n');
  await symlink(join(codexDir, 'AGENTS.md'), join(dshHome, 'AGENTS.md'));
  await writeFile(join(claudeDir, 'CLAUDE.md'), '# Claude 规则\n');

  const service = new PackageManagerService({ root: join(dshHome, 'dsh-agent-packages'), homeDir, dshHome, runCommand: fakeCli });
  await service.init();

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
  const exists = async p => { try { await lstat(p); return true; } catch { return false; } };
  const row = (text, extra = '') => page.locator(`.ap-pkg-card${extra}`, { hasText: text }).first();
  const notice = re => page.locator('.ap-banner-notice', { hasText: re }).waitFor();
  const sw = (locator, harness) => locator.getByRole('switch', { name: new RegExp(`^${harness}：`) }).first();

  await page.goto(url);
  await page.getByRole('tab', { name: /Skills/ }).waitFor();
  const tabNames = await page.getByRole('tab').allInnerTexts();
  assert.deepEqual(tabNames.map(t => t.replace(/\d+|需处理|待同步/g, '').trim()), ['Skills', 'MCP', '插件', '规则']);
  assert.equal(await page.getByRole('button', { name: /添加包|解析仓库|检查更新/ }).count(), 0, '不再有清单、解析与版本检查入口');

  // 1. Skills：部分端 / 不一致的排前面，4 端一致的折叠
  await row('notes').waitFor();
  assert.match(await page.locator('.ap-matrix-group').first().innerText(), /需处理\s*3/);
  assert.equal(await page.locator('.ap-pkg-card', { hasText: 'shared-a' }).count(), 0, '4 端一致的默认折叠');
  assert.match(await row('stale').innerText(), /失效软链/);
  // 插件带来的 Skill：单独成组、标注来源插件、开关一律置灰
  const helper = row('tidy-helper');
  assert.match(await page.locator('.ap-matrix-group', { hasText: '由插件提供' }).innerText(), /由插件提供\s*1/);
  assert.match(await helper.innerText(), /插件 tidy/);
  for (const h of ['Codex', 'Claude Code', 'Antigravity', 'DSH 原生']) assert.equal(await sw(helper, h).isDisabled(), true, `${h} 应禁止同步`);
  assert.match(await sw(helper, 'DSH 原生').getAttribute('aria-label'), /由插件 tidy 提供/);
  // 筛选：只看需处理，插件提供的与 4 端一致的组隐藏
  await page.getByRole('group', { name: '筛选' }).getByRole('button', { name: /需处理/ }).click();
  assert.equal(await page.locator('.ap-pkg-card', { hasText: 'tidy-helper' }).count(), 0);
  assert.equal(await page.locator('.ap-matrix-group', { hasText: '4 端一致' }).count(), 0);
  await page.getByRole('group', { name: '筛选' }).getByRole('button', { name: /全部/ }).click();
  await page.screenshot({ path: 'artifacts/packages-desktop.png', fullPage: true });
  // 开启 Codex：建软链指向 Claude 的实体目录
  await sw(row('notes'), 'Codex').click();
  await notice(/已在 Codex 建立软链/);
  assert.equal(await readlink(join(codexDir, 'skills', 'notes')), await realpath(join(claudeDir, 'skills', 'notes')));
  // 关闭源端被拒（Codex 软链指向它），状态不变
  await sw(row('notes'), 'Claude Code').click();
  await row('notes').locator('.ap-confirm p').getByText(/实体目录 .* 移入回收目录/).waitFor();
  await page.getByRole('button', { name: '确认移入回收目录' }).click();
  await notice(/Codex 的软链指向这个目录/);
  assert.match(await page.locator('.ap-banner-notice').getAttribute('class'), /is-warn/);
  assert.equal(await sw(row('notes'), 'Claude Code').getAttribute('aria-checked'), 'true');
  // 关闭 Codex 的软链
  await sw(row('notes'), 'Codex').click();
  await row('notes').locator('.ap-confirm p').getByText(/将删除 Codex 的软链/).waitFor();
  await page.getByRole('button', { name: '确认删除' }).click();
  await notice(/已删除 Codex 的软链/);
  // 成功提示 3 秒后自动消失
  await page.locator('.ap-banner-notice').waitFor({ state: 'detached', timeout: 5000 });
  assert.equal(await exists(join(codexDir, 'skills', 'notes')), false);
  // 展开 4 端一致组
  await page.locator('.ap-matrix-group', { hasText: '4 端一致' }).getByRole('button', { name: '展开' }).click();
  await row('shared-a').waitFor();
  await page.screenshot({ path: 'artifacts/packages-skills.png', fullPage: true });

  // 2. MCP：跨格式复制、DSH 不可用、手工添加、编辑保留未建模字段
  await page.getByRole('tab', { name: /MCP/ }).click();
  assert.equal(await page.locator('.ap-logs').count(), 0, '执行记录不跨视图');
  const pw = row('playwright');
  assert.equal(await sw(pw, 'DSH 原生').isDisabled(), true);
  // 插件带来的 MCP：标注来源插件、禁止同步、没有编辑入口
  const tidyMcp = row('tidy-mcp');
  assert.match(await tidyMcp.innerText(), /插件 tidy/);
  assert.equal(await sw(tidyMcp, 'Claude Code').isDisabled(), true);
  assert.equal(await sw(tidyMcp, 'Codex').isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '编辑 tidy-mcp' }).count(), 0);
  await sw(pw, 'Codex').click();
  await notice(/已把「playwright」从 Claude Code 写入/);
  const codexPw = (await readCodexMcpServers(join(codexDir, 'config.toml'))).playwright;
  assert.equal(codexPw.command, 'npx');
  assert.deepEqual(codexPw.env_vars, ['TOKEN']);
  // 手工添加
  await page.getByRole('button', { name: '添加 MCP' }).click();
  await page.locator('#ap-mcp-key').fill('local-api');
  await page.getByRole('radio', { name: /HTTP/ }).check();
  await page.locator('#ap-mcp-url').fill('https://example.com/mcp');
  for (const label of ['Codex', 'Claude Code']) await page.locator('.ap-editor .ap-check-item', { hasText: label }).locator('input').uncheck();
  assert.match(await page.locator('.ap-form-side').innerText(), /"url": "https:\/\/example.com\/mcp"/);
  await page.screenshot({ path: 'artifacts/packages-mcp-form.png', fullPage: true });
  await page.getByRole('button', { name: /^保存并写入/ }).click();
  await row('local-api').waitFor();
  assert.equal((await readJsonMcpServers(join(agyDir, 'mcp_config.json')))['local-api'].url, 'https://example.com/mcp');
  // 编辑 playwright：只写回 Claude，alwaysLoad 保留
  await page.getByRole('button', { name: '编辑 playwright' }).click();
  assert.equal(await page.locator('#ap-mcp-key').isDisabled(), true);
  // 将写入预览与服务端同一份渲染：Claude Code 保留 alwaysLoad
  assert.match(await page.locator('.ap-form-side').innerText(), /"alwaysLoad": true/);
  await page.locator('#ap-mcp-args').fill('@playwright/mcp@latest --headless');
  await page.locator('.ap-editor .ap-check-item', { hasText: 'Codex' }).locator('input').uncheck();
  await page.getByRole('button', { name: /^保存并写入/ }).click();
  await notice(/已把「playwright」写入 Claude Code/);
  const claudeJson = JSON.parse(await readFile(join(homeDir, '.claude.json'), 'utf8'));
  assert.equal(claudeJson.theme, 'dark');
  assert.equal(claudeJson.mcpServers.playwright.alwaysLoad, true);
  assert.deepEqual(claudeJson.mcpServers.playwright.args, ['@playwright/mcp@latest', '--headless']);
  assert.match(await row('playwright').innerText(), /各端配置不同/);
  // 展开：逐字段对比，参数一行高亮
  await row('playwright').getByRole('button', { name: 'playwright', exact: true }).click();
  assert.match(await row('playwright').locator('.ap-diff tr.is-diff').first().innerText(), /参数/);
  // 各端配置不同时再编辑：默认只写回底稿所在的端，不抹平另一端
  await page.getByRole('button', { name: '编辑 playwright' }).click();
  await page.locator('.ap-editor').getByText(/底稿取自 Codex。各端配置不同/).waitFor();
  assert.equal(await page.locator('.ap-editor .ap-check-item', { hasText: 'Claude Code' }).locator('input').isChecked(), false);
  assert.equal(await page.locator('.ap-editor .ap-check-item', { hasText: 'Codex' }).locator('input').isChecked(), true);
  await page.locator('.ap-editor').getByRole('button', { name: '取消' }).click();
  // 关闭需确认
  await sw(row('codegraph'), 'Codex').click();
  await row('codegraph').locator('.ap-confirm p').getByText(/将从 Codex 的 MCP 配置移除「codegraph」/).waitFor();
  await page.locator('.ap-confirm').screenshot({ path: 'artifacts/packages-confirm.png' });
  await row('codegraph').locator('.ap-confirm').getByRole('button', { name: '取消' }).click();
  // 按端不同的变量：只是值不同不算不一致；编辑时按端填入、全部勾选；新端单独填值，已有端保持各自的值
  assert.doesNotMatch(await row('hindsight').innerText(), /各端配置不同/);
  await page.getByRole('button', { name: '编辑 hindsight' }).click();
  const hsVal = h => page.getByRole('textbox', { name: `HINDSIGHT_MCP_HARNESS 在 ${h} 的值` });
  assert.equal(await hsVal('Codex').inputValue(), 'codex');
  assert.equal(await hsVal('Claude Code').inputValue(), 'claude-code');
  await page.locator('.ap-editor .ap-check-item', { hasText: 'Antigravity' }).locator('input').check();
  await hsVal('Antigravity').fill('antigravity');
  await page.screenshot({ path: 'artifacts/packages-mcp-env-split.png', fullPage: true });
  await page.setViewportSize({ width: 585, height: 1000 });
  await page.screenshot({ path: 'artifacts/packages-mcp-env-split-panel.png', fullPage: true });
  await page.setViewportSize({ width: 1360, height: 1000 });
  await page.getByRole('button', { name: /^保存并写入/ }).click();
  await notice(/已把「hindsight」写入/);
  assert.equal((await readCodexMcpServers(join(codexDir, 'config.toml'))).hindsight.env.HINDSIGHT_MCP_HARNESS, 'codex');
  assert.equal(JSON.parse(await readFile(join(homeDir, '.claude.json'), 'utf8')).mcpServers.hindsight.env.HINDSIGHT_MCP_HARNESS, 'claude-code');
  assert.equal((await readJsonMcpServers(join(agyDir, 'mcp_config.json'))).hindsight.env.HINDSIGHT_MCP_HARNESS, 'antigravity');
  await sw(row('codegraph'), 'Codex').click();
  await row('codegraph').locator('.ap-confirm').getByRole('button', { name: '取消' }).click();
  await page.screenshot({ path: 'artifacts/packages-mcp.png', fullPage: true });

  // 3. 插件：未添加市场的端置灰；先在市场行开启 Codex，再安装；Antigravity 用本地目录
  await page.getByRole('tab', { name: /插件/ }).click();
  const tidy = row('tidy');
  assert.equal(await sw(tidy, 'Codex').isDisabled(), true, 'Codex 未添加市场时不可安装');
  assert.match(await sw(tidy, 'Codex').getAttribute('aria-label'), /Codex 未添加市场 tools/);
  assert.equal(await sw(tidy, 'DSH 原生').isDisabled(), true);
  assert.equal(await page.locator('.ap-pkg-card', { hasText: 'browser' }).count(), 0, '内置插件默认折叠');
  await sw(tidy, 'Antigravity').click();
  await notice(/已在 Antigravity 安装「tidy」/);
  assert.equal(calls.at(-1), `agy plugin install ${join(mpRoot, 'plugins', 'tidy')}`);
  const tools = page.locator('.ap-pkg-card', { has: page.getByRole('button', { name: 'tools', exact: true }) });
  await sw(tools, 'Codex').click();
  await notice(/已在 Codex 添加市场「tools」/);
  assert.equal(calls.at(-1), 'codex plugin marketplace add acme/tools');
  await sw(row('tidy'), 'Codex').click();
  await notice(/已在 Codex 安装「tidy」/);
  assert.equal(calls.at(-1), 'codex plugin add tidy@tools');
  // 展开市场浏览插件，直接在 Claude Code 安装 lint
  await tools.getByRole('button', { name: 'tools', exact: true }).click();
  const lint = page.locator('.ap-catalog-row', { hasText: 'lint' });
  await lint.waitFor();
  assert.match(await lint.innerText(), /静态检查/);
  const cellLeft = loc => loc.locator('.ap-cells').first().evaluate(el => Math.round(el.getBoundingClientRect().left));
  assert.equal(await cellLeft(lint), await cellLeft(row('tidy')), '市场里的插件行与已安装行的状态列对齐');
  await sw(lint, 'Claude Code').click();
  await notice(/已在 Claude Code 安装「lint」/);
  assert.equal(calls.at(-1), 'claude plugin install lint@tools');
  // 在 Claude Code 移除市场：确认条列出会被连带卸载的插件
  await sw(tools, 'Claude Code').click();
  await tools.locator('.ap-confirm p').getByText(/Claude Code 会同时卸载从该市场安装的所有插件（2 个：lint、tidy）/).waitFor();
  await tools.locator('.ap-confirm').getByRole('button', { name: '取消' }).click();
  // 卸载需确认
  await sw(row('tidy'), 'Antigravity').click();
  await page.locator('.ap-confirm p').getByText(/将在 Antigravity 执行卸载命令/).waitFor();
  await page.getByRole('button', { name: '确认卸载' }).click();
  await notice(/已从 Antigravity 卸载「tidy」/);
  assert.equal(calls.at(-1), 'agy plugin uninstall tidy');
  // 添加市场：前端按服务端同一规则校验，不合法不执行命令
  await page.getByRole('button', { name: '添加市场' }).click();
  const callCount = calls.length;
  await page.locator('#ap-mp-source').fill('~/dev/my-plugins');
  await page.locator('.ap-editor').getByRole('button', { name: '添加到 2 端' }).click();
  await page.locator('.ap-editor [role="alert"]').getByText(/本地路径请写绝对路径/).waitFor();
  assert.equal(calls.length, callCount, '校验不通过不执行命令');
  // Codex 失败、Claude 成功：表单保留，失败行写明原因，只重试失败的端
  failCodexMarketplace = true;
  await page.locator('#ap-mp-source').fill('acme/extras');
  await page.locator('.ap-editor').getByText('识别为 GitHub 仓库 acme/extras').waitFor();
  await page.locator('.ap-editor').getByRole('button', { name: '添加到 2 端' }).click();
  await notice(/添加市场 acme\/extras：1 端失败/);
  assert.match(await page.locator('.ap-banner-notice').getAttribute('class'), /is-warn/);
  const badStep = page.locator('.ap-step.is-bad');
  assert.match(await badStep.innerText(), /Codex[\s\S]*退出码 1/);
  assert.deepEqual(calls.slice(callCount), ['claude plugin marketplace add acme/extras', 'codex plugin marketplace add acme/extras']);
  await page.screenshot({ path: 'artifacts/packages-market-fail.png', fullPage: true });
  await page.setViewportSize({ width: 585, height: 1000 });
  await page.screenshot({ path: 'artifacts/packages-market-fail-panel.png', fullPage: true });
  await page.setViewportSize({ width: 1360, height: 1000 });
  // 部分失败的警示提示不自动消失
  await page.waitForTimeout(3500);
  assert.equal(await page.locator('.ap-banner-notice.is-warn').count(), 1, '警示提示应保留到手动关闭');
  failCodexMarketplace = false;
  await page.locator('.ap-editor').getByRole('button', { name: '重试 1 端' }).click();
  await notice(/已添加市场 acme\/extras/);
  assert.equal(await page.locator('.ap-editor').count(), 0, '全部成功后关闭表单');
  assert.deepEqual(calls.slice(callCount + 2), ['codex plugin marketplace add acme/extras'], '只重试失败的端');
  await page.locator('.ap-matrix-group', { hasText: '内置插件' }).getByRole('button', { name: '展开' }).click();
  await row('browser').waitFor();
  await page.screenshot({ path: 'artifacts/packages-plugins.png', fullPage: true });

  // 4. 规则：纳管本机文件（内容不变）→ 新建片段 → 开启 DSH（软链拆分）→ 预览 → 排序
  await page.getByRole('tab', { name: /规则/ }).click();
  await page.getByText('还没有规则片段').waitFor();
  // 纳管读取失败：错误留在该行，什么都没改；刷新后该行消失
  await rm(join(claudeDir, 'CLAUDE.md'));
  const claudeFileRow = page.locator('.ap-unmanaged-row', { hasText: 'Claude Code · CLAUDE.md' });
  await claudeFileRow.getByRole('button', { name: '纳管' }).click();
  await page.getByRole('button', { name: '确认纳管' }).click();
  await claudeFileRow.locator('.ap-row-error').getByText(/纳管失败：目标文件不存在/).waitFor();
  assert.equal(await page.locator('.ap-banner-error').count(), 0, '读取失败不再只显示在页面顶部');
  await page.screenshot({ path: 'artifacts/packages-adopt-fail.png', fullPage: true });
  await claudeFileRow.getByRole('button', { name: '刷新' }).click();
  await claudeFileRow.waitFor({ state: 'detached' });
  const codexAgents = await readFile(join(codexDir, 'AGENTS.md'), 'utf8');
  const dshFileRow = page.locator('.ap-unmanaged-row', { hasText: 'DSH 原生 · AGENTS.md' });
  await dshFileRow.getByRole('button', { name: '纳管' }).click();
  await dshFileRow.locator('.ap-confirm p').getByText(/的软链，写入时会拆分为独立文件/).waitFor();
  await dshFileRow.locator('.ap-confirm').getByRole('button', { name: '取消' }).click();
  const codexFileRow = page.locator('.ap-unmanaged-row', { hasText: 'Codex · AGENTS.md' });
  await codexFileRow.getByRole('button', { name: '纳管' }).click();
  await page.getByRole('button', { name: '确认纳管' }).click();
  await page.locator('.ap-rule-row', { hasText: 'Codex 现有 AGENTS.md' }).waitFor();
  assert.equal(await readFile(join(codexDir, 'AGENTS.md'), 'utf8'), codexAgents, '纳管后 Codex 文件内容不变');
  await page.getByRole('button', { name: '新建片段' }).click();
  await page.locator('#ap-rule-title-__new__').fill('DSH 私有规则');
  await page.locator('#ap-rule-content-__new__').fill('## DSH 原生私有规则\n- 简短汇报执行进展');
  assert.equal(await page.getByRole('tab', { name: /规则.*未保存/ }).count(), 1);
  await page.getByRole('button', { name: '添加片段' }).click();
  const dshRule = page.locator('.ap-rule-row', { hasText: 'DSH 私有规则' });
  await dshRule.waitFor();
  // 写入失败：片段已保存，DSH 标「写入失败」，重试只写这一端
  await chmod(dshHome, 0o555);
  try {
    await sw(dshRule, 'DSH 原生').click();
    await notice(/已保存规则，1 端写入失败/);
  } finally {
    await chmod(dshHome, 0o755);
  }
  assert.match(await page.locator('.ap-banner-notice').getAttribute('class'), /is-warn/);
  assert.match(await page.locator('.ap-file-row').getByRole('img', { name: /^DSH 原生 AGENTS\.md：写入失败/ }).getAttribute('aria-label'), /写入失败/);
  await page.screenshot({ path: 'artifacts/packages-rules-fail.png', fullPage: true });
  await page.setViewportSize({ width: 585, height: 1000 });
  await page.screenshot({ path: 'artifacts/packages-rules-fail-panel.png', fullPage: true });
  await page.setViewportSize({ width: 1360, height: 1000 });
  await page.getByRole('button', { name: '重试写入 DSH', exact: true }).click();
  await notice(/规则同步完成/);
  assert.equal((await lstat(join(dshHome, 'AGENTS.md'))).isSymbolicLink(), false);
  assert.equal(await readFile(join(dshHome, 'AGENTS.md'), 'utf8'), '## DSH 原生私有规则\n- 简短汇报执行进展\n');
  assert.equal(await readFile(join(codexDir, 'AGENTS.md'), 'utf8'), codexAgents, '只写变化的端');
  await page.locator('.ap-rule-preview .ap-seg-item', { hasText: 'DSH' }).click();
  assert.match(await page.locator('.ap-instr-preview').innerText(), /DSH 原生私有规则/);
  // 编辑未保存时预览即时反映，并标注
  await dshRule.getByRole('button', { name: 'DSH 私有规则', exact: true }).click();
  await page.locator('textarea[id^="ap-rule-content-snippet-"]').fill('## DSH 原生私有规则\n- 编辑中的内容');
  await page.locator('.ap-rule-preview').getByText('预览包含未保存的编辑').waitFor();
  assert.match(await page.locator('.ap-instr-preview').innerText(), /编辑中的内容/);
  await dshRule.getByRole('button', { name: '取消' }).click();
  await page.getByRole('button', { name: '下移 Codex 现有 AGENTS.md' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.ap-rule-row')[0]?.textContent.includes('DSH 私有规则'));
  await page.screenshot({ path: 'artifacts/packages-rules.png', fullPage: true });

  // 5. 窄屏 390：无横向溢出，表头隐藏、格子显示端名，菜单不出视口
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of [/Skills/, /MCP/, /插件/, /规则/]) {
    await page.getByRole('tab', { name }).click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 2, `移动端出现横向溢出（${name}）：${overflow}px`);
  }
  await page.getByRole('tab', { name: /MCP/ }).click();
  assert.equal(await page.locator('.ap-col-head').isVisible(), false);
  assert.ok(await page.locator('.ap-pkg-card .ap-cell-label').first().isVisible());
  const editBox = await page.getByRole('button', { name: '编辑 playwright' }).boundingBox();
  assert.ok(editBox.x >= 0 && editBox.x + editBox.width <= 390, `移动端行末按钮超出视口：${JSON.stringify(editBox)}`);
  await page.screenshot({ path: 'artifacts/packages-mobile.png', fullPage: true });

  // 6. 面板宽度 585：状态列对齐、标题行不换行、工具栏一行、表头与分组标题同一行
  await page.setViewportSize({ width: 585, height: 1000 });
  for (const [name, file] of [[/Skills/, 'packages-panel'], [/MCP/, 'packages-mcp-panel'], [/插件/, 'packages-plugins-panel'], [/规则/, 'packages-rules-panel']]) {
    await page.getByRole('tab', { name }).click();
    const lefts = await page.locator('.ap-matrix > .ap-matrix-row > .ap-cells, .ap-matrix > .ap-matrix-group > .ap-cells').evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().left)));
    assert.equal(new Set(lefts).size, 1, `${name} 状态列应对齐：${lefts}`);
    const heights = await page.locator('.ap-pkg-card .ap-pkg-title-row').evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().height)));
    assert.ok(heights.every(h => h <= 28), `${name} 标题行不应换行：${heights}`);
    await page.screenshot({ path: `artifacts/${file}.png`, fullPage: true });
  }
  await page.getByRole('tab', { name: /Skills/ }).click();
  const searchBox = await page.locator('.ap-search').boundingBox();
  const refreshBox = await page.getByRole('button', { name: '刷新' }).boundingBox();
  assert.ok(Math.abs(searchBox.y + searchBox.height / 2 - (refreshBox.y + refreshBox.height / 2)) < 6, '面板宽度下工具栏不应换行');
  const groupTitle = await page.locator('.ap-matrix-group').first().locator('h3').boundingBox();
  const colHead = await page.locator('.ap-col-head').first().boundingBox();
  assert.ok(Math.abs(groupTitle.y + groupTitle.height / 2 - (colHead.y + colHead.height / 2)) < 4, '端名表头与分组标题同一行');

  await page.getByRole('tab', { name: /MCP/ }).click();
  await page.getByRole('button', { name: '添加 MCP' }).click();
  await page.screenshot({ path: 'artifacts/packages-mcp-form-panel.png', fullPage: true });
  await page.locator('.ap-editor').getByRole('button', { name: '取消' }).click();

  // 亮色主题：宿主变量换成亮色值后截图核对
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => document.body.setAttribute('style', 'margin:0;padding:24px;background:#ffffff;color:#202631;--dsw-alias-border-l2:#d9dfe7;--dsw-alias-label-secondary:#5c6573;--dsw-alias-label-primary:#202631;--dsw-alias-bg-layer-1:#ffffff;--dsw-alias-state-active-primary:#386bdd;--dsw-alias-state-error-primary:#b32f35;--dsw-alias-state-success-primary:#18704a'));
  await page.getByRole('tab', { name: /Skills/ }).click();
  await page.screenshot({ path: 'artifacts/packages-light.png', fullPage: true });

  assert.deepEqual(pageErrors, [], `页面报错：${pageErrors.join('; ')}`);
  assert.deepEqual(failedRequests, [], `请求失败：${failedRequests.join('; ')}`);
  console.log('UI 验收全部通过，截图已保存至 artifacts/');
} finally {
  await browser?.close();
  server?.close();
  await rm(base, { recursive: true, force: true });
}
