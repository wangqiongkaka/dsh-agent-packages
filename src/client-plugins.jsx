import { useEffect, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { MARKETPLACE_SOURCE_RE } from './shared.mjs';
import { HARNESS_IDS, IconButton, MatrixGroup, RowMeta, RowToggle, ToggleCells, harnessLabel, isFailedStep } from './client-ui.jsx';

const MARKETPLACE_HARNESSES = ['claude-code', 'codex'];
const CATALOG_LIMIT = 50;
const SOURCE_EXAMPLES = ['anthropics/claude-plugins-official', 'https://github.com/owner/repo.git', '/Users/you/dev/my-plugins'];

function versionText(row) {
  return HARNESS_IDS.filter(h => row.harnesses[h])
    .map(h => `${harnessLabel(h)}${row.harnesses[h].version ? ` ${row.harnesses[h].version}` : ''}`)
    .join(' · ');
}

const sourceLabel = source => source.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');

// 与服务端 MARKETPLACE_SOURCE_RE 同一口径：不合法时不发请求，并给出可操作的原因
export function sourceKind(raw) {
  const value = raw.trim();
  if (!value) return { error: '请填写市场来源' };
  if (/^[~.]/.test(value)) return { error: '本地路径请写绝对路径，例如 /Users/you/dev/my-plugins' };
  if (/^http:\/\//.test(value)) return { error: 'Git 地址只支持 https:// 或 git@ 开头' };
  if (!MARKETPLACE_SOURCE_RE.test(value)) return { error: '市场来源请填写 owner/repo、Git 地址或本地绝对路径' };
  if (value.startsWith('/')) return { label: '本地路径' };
  if (/^(https:|git@)/.test(value)) return { label: 'Git 地址' };
  return { label: `GitHub 仓库 ${value}` };
}

// 按错误原文归类：shell 找不到命令 → 退出码 127；runCommand 超时 → 「命令超时」
function failureKind(step, command) {
  if (/退出码 127/.test(step.detail)) return { label: '找不到命令', hint: `检查 ${harnessLabel(step.harness)} 的命令配置（当前为 ${command}）` };
  if (/命令超时/.test(step.detail)) return { label: '超时', hint: '网络较慢或仓库较大，可稍后重试' };
  return { label: '失败', hint: '' };
}

// 市场浏览行的可用性，与服务端 pluginBlockReason 规则一致：本地目录取清单里的相对路径或其他端已装的目录
function browseBlockReason({ harness, marketplaceRow, localDir, installed }) {
  if (harness === 'dsh') return 'DSH 原生没有插件机制';
  if (installed) return '';
  if (harness === 'antigravity') {
    if (marketplaceRow.harnesses.antigravity) return '';
    return localDir ? '' : '插件源不在本地，先在 Claude Code 或 Codex 安装一次';
  }
  return marketplaceRow.harnesses[harness] ? '' : `${harnessLabel(harness)} 未添加市场 ${marketplaceRow.name}，先在本行开启`;
}

function MarketplaceForm({ ctx, onClose }) {
  const { state, busy, run, pendingKey } = ctx;
  const [source, setSource] = useState('');
  const [harnesses, setHarnesses] = useState(MARKETPLACE_HARNESSES);
  const [tried, setTried] = useState(false);
  const [serverError, setServerError] = useState('');
  // 逐端结果：重试只覆盖失败的端，成功的端保留
  const [results, setResults] = useState(null);
  const commandOf = h => state.harnesses.find(item => item.id === h)?.command || (h === 'claude-code' ? 'claude' : 'codex');
  const kind = sourceKind(source);
  const src = source.trim();
  const failed = results ? harnesses.filter(h => results[h] && isFailedStep(results[h])) : [];
  const targets = failed.length ? failed : harnesses;
  const running = pendingKey === 'marketplace.add';
  const fieldError = tried && kind.error ? kind.error : serverError;

  const reset = () => { setResults(null); setServerError(''); };
  const submit = async event => {
    event.preventDefault();
    setTried(true);
    if (kind.error || !targets.length) return;
    const result = await run({ type: 'marketplace.add', source: src, harnesses: targets }, 'marketplace.add', onClose, { inline: true });
    if (!result) return;
    if (result.error) return void setServerError(result.error);
    setResults(prev => ({
      ...(prev ?? {}),
      ...Object.fromEntries((result.steps ?? []).map(step => [step.harness, { ...step, attempt: (prev?.[step.harness]?.attempt ?? 0) + 1 }])),
    }));
  };

  return (
    <section className="ap-card ap-editor ap-form" aria-label="添加市场">
      <form onSubmit={submit} noValidate>
        <div className="ap-editor-head">
          <h3>添加市场</h3>
          <p className="ap-help">添加后可在市场里浏览插件，并用开关安装到各端。</p>
        </div>
        <div className="ap-form-body">
          <div className="ap-form-main">
            <div className="ap-field">
              <label htmlFor="ap-mp-source">市场来源</label>
              <input
                id="ap-mp-source"
                className={`ap-input ap-mono ${fieldError ? 'is-invalid' : ''}`.trim()}
                placeholder="owner/repo、Git 地址或本地绝对路径"
                value={source}
                aria-invalid={Boolean(fieldError)}
                aria-describedby="ap-mp-source-hint"
                disabled={running}
                onChange={e => { setSource(e.target.value); reset(); }}
              />
              {fieldError && <p className="ap-field-error" role="alert">{fieldError}</p>}
              {!fieldError && kind.label && <span className="ap-kind">识别为 {kind.label}</span>}
              <div className="ap-examples" id="ap-mp-source-hint">
                <span className="ap-help">例如</span>
                {SOURCE_EXAMPLES.map(example => (
                  <button key={example} type="button" className="ap-chip ap-mono" disabled={running} onClick={() => { setSource(example); reset(); }}>{example}</button>
                ))}
              </div>
            </div>
            <fieldset className="ap-field ap-fieldset">
              <legend className="ap-field-label">添加到</legend>
              <div className="ap-targets">
                {HARNESS_IDS.map(h => {
                  const supported = MARKETPLACE_HARNESSES.includes(h);
                  const checked = harnesses.includes(h);
                  return (
                    <label key={h} className={`ap-check-item ap-target ${checked ? 'is-on' : ''} ${supported ? '' : 'is-na'}`.replace(/\s+/g, ' ').trim()}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!supported || running}
                        onChange={() => { setHarnesses(checked ? harnesses.filter(x => x !== h) : [...harnesses, h]); reset(); }}
                      />
                      <span>
                        <b>{harnessLabel(h)}</b>
                        <small>{supported ? `执行 ${commandOf(h)} plugin marketplace add`
                          : h === 'antigravity' ? '没有添加市场的命令；安装插件时直接用本地目录' : '没有插件机制'}</small>
                      </span>
                    </label>
                  );
                })}
              </div>
              {tried && !harnesses.length && <p className="ap-field-error" role="alert">至少选择一个端</p>}
            </fieldset>
          </div>
          <aside className="ap-form-side" aria-label="执行情况" aria-live="polite">
            {!results ? (
              <>
                <h4>将执行</h4>
                <p className="ap-help">按顺序在各端执行，一端失败不影响另一端。</p>
                {harnesses.map(h => (
                  <div key={h} className="ap-preview-item">
                    <span className="ap-preview-title">{harnessLabel(h)}</span>
                    <pre className="ap-code">{`${commandOf(h)} plugin marketplace add ${src || '<来源>'}`}</pre>
                  </div>
                ))}
              </>
            ) : (
              <>
                <h4>{failed.length ? `${failed.length} 端失败` : '已完成'}</h4>
                <ol className="ap-steps">
                  {harnesses.map(h => {
                    const step = results[h];
                    const pending = running && targets.includes(h);
                    const bad = !pending && step && isFailedStep(step);
                    const kindInfo = bad ? failureKind(step, commandOf(h)) : null;
                    return (
                      <li key={h} className={`ap-step ${bad ? 'is-bad' : ''}`.trim()}>
                        <span className={`ap-step-ic ${pending ? 'is-run' : bad ? 'is-bad' : step ? 'is-ok' : ''}`.trim()} aria-hidden="true" />
                        <div className="ap-step-body">
                          <b>{harnessLabel(h)}</b>
                          <span className="ap-step-state">
                            {pending ? '执行中…' : !step ? '等待' : bad ? kindInfo.label : step.attempt > 1 ? `已添加（第 ${step.attempt} 次）` : '已添加'}
                          </span>
                          {bad ? (
                            <>
                              <pre className="ap-code is-bad">{step.detail}</pre>
                              {kindInfo.hint && <p className="ap-step-hint">{kindInfo.hint}</p>}
                              {step.command && (
                                <button type="button" className="ap-link-btn" onClick={() => void navigator.clipboard?.writeText(step.command)}>复制命令</button>
                              )}
                            </>
                          ) : step?.command && <p className="ap-step-cmd ap-mono">{step.command}</p>}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </>
            )}
          </aside>
        </div>
        <div className="ap-editor-footer">
          <Button variant="outline" type="button" disabled={running} onClick={onClose}>取消</Button>
          <Button variant="primary" type="submit" disabled={busy || !targets.length}>
            {running ? '添加中…' : failed.length ? `重试 ${failed.length} 端` : `添加到 ${targets.length} 端`}
          </Button>
        </div>
      </form>
    </section>
  );
}

export function PluginsView({ ctx, form, setForm }) {
  const { state, busy, pendingKey, search, run, ask, confirmFor, expanded, toggleExpanded, request, catalogs, setCatalogs } = ctx;
  const needle = search.trim().toLowerCase();
  const { plugins, marketplaces } = state.plugins;
  const match = text => !needle || String(text).toLowerCase().includes(needle);
  const installedRows = plugins.filter(row => !row.builtin && match(row.id));
  const builtinRows = plugins.filter(row => row.builtin && match(row.id));
  const marketplaceRows = marketplaces.filter(row => match(row.name) || (catalogs[row.name]?.plugins ?? []).some(p => match(p.name)));
  const builtinOpen = Boolean(expanded['plugins:builtin']) || (Boolean(needle) && builtinRows.length > 0);

  const togglePlugin = ({ name, marketplace }, harness, on, rowKey) => {
    const exec = () => run({ type: 'plugin.toggle', name, marketplace, harness, on }, `plugin:${name}@${marketplace}:${harness}`);
    if (on) return void exec();
    ask(rowKey, `将在 ${harnessLabel(harness)} 执行卸载命令，卸载「${name}」（该端注册的 hooks、命令与 Skills 由该端一并清理）。`, '确认卸载', exec);
  };

  const pluginCells = (row, rowKey) => HARNESS_IDS.map(h => {
    const entry = row.harnesses[h];
    return {
      harnessId: h,
      on: Boolean(entry),
      status: entry ? 'installed' : 'unselected',
      label: `${harnessLabel(h)}：${entry ? `已安装${entry.version ? ` ${entry.version}` : ''}` : '未安装'}`,
      disabledReason: row.blocked?.[h] || '',
      busy: pendingKey === `plugin:${row.name}@${row.marketplace}:${h}`,
      onToggle: on => togglePlugin(row, h, on, rowKey),
    };
  });

  const renderPlugin = row => {
    const rowKey = `plugin:${row.id}`;
    return (
      <article key={row.id} className="ap-matrix-row ap-pkg-card">
        <div className="ap-row-main">
          <div className="ap-pkg-title-row">
            <span className="ap-pkg-title" title={row.id}>{row.name}</span>
            {row.marketplace && <span className="ap-row-suffix ap-mono" title="所属市场">@{row.marketplace}</span>}
          </div>
          <RowMeta>{versionText(row)}</RowMeta>
        </div>
        <ToggleCells ariaLabel={`${row.name} 各端开关`} disabled={busy} cells={pluginCells(row, rowKey)} />
        <div className="ap-pkg-actions">
          {row.harnesses['claude-code'] && (
            <IconButton
              icon="update"
              label={`在 Claude Code 中更新 ${row.name}`}
              disabled={busy}
              className={pendingKey === `plugin.update:${row.id}` ? 'is-busy' : ''}
              onClick={() => run({ type: 'plugin.update', id: row.id }, `plugin.update:${row.id}`)}
            />
          )}
        </div>
        {confirmFor(rowKey)}
      </article>
    );
  };

  const loadCatalog = async name => {
    setCatalogs(prev => ({ ...prev, [name]: { loading: true, plugins: [] } }));
    try {
      const res = await request({ type: 'marketplace.plugins', name });
      setCatalogs(prev => ({ ...prev, [name]: { loading: false, plugins: res.plugins ?? [] } }));
    } catch (cause) {
      setCatalogs(prev => ({ ...prev, [name]: { loading: false, plugins: [], error: cause.message } }));
    }
  };

  // 切换视图后回来：已展开但还没读过清单的市场自动加载
  useEffect(() => {
    for (const row of marketplaces) {
      if (expanded[`marketplace:${row.name}`] && !catalogs[row.name]) void loadCatalog(row.name);
    }
  }, [marketplaces, expanded]);

  const toggleMarketplace = (row, harness, on) => {
    const exec = () => run({ type: 'marketplace.toggle', name: row.name, harness, on }, `marketplace:${row.name}:${harness}`);
    if (on) return void exec();
    const affected = plugins.filter(p => p.marketplace === row.name && p.harnesses[harness]).map(p => p.name);
    // Claude Code 官方文档：移除市场会卸载从它安装的所有插件；Codex 的行为未确认
    const text = harness === 'claude-code'
      ? `将从 Claude Code 移除市场「${row.name}」。Claude Code 会同时卸载从该市场安装的所有插件${affected.length ? `（${affected.length} 个：${affected.join('、')}）` : '（当前没有）'}。`
      : `将从 Codex 移除市场「${row.name}」，之后无法再从该市场安装或更新插件。${affected.length ? `Codex 是否连带卸载已装的 ${affected.length} 个插件（${affected.join('、')}）尚未确认。` : ''}`;
    ask(`marketplace:${row.name}`, text, affected.length && harness === 'claude-code' ? `确认移除并卸载 ${affected.length} 个插件` : '确认移除', exec);
  };

  const renderCatalog = (row, catalog, rowKey) => {
    if (!catalog || catalog.loading) return <p className="ap-help">正在读取市场里的插件…</p>;
    if (catalog.error) return <p className="ap-field-error" role="alert">{catalog.error}</p>;
    if (!catalog.plugins.length) return <p className="ap-help">市场目录里没有找到 marketplace.json。</p>;
    const query = (catalog.query ?? '').trim().toLowerCase();
    const installedByName = new Map(plugins.filter(p => p.marketplace === row.name || !p.marketplace).map(p => [p.name, p]));
    const matched = catalog.plugins.filter(p => (match(p.name) || match(row.name)) && (!query || p.name.toLowerCase().includes(query) || (p.description ?? '').toLowerCase().includes(query)));
    return (
      <div className="ap-catalog-list">
        <div className="ap-catalog-top">
          <input
            type="search"
            className="ap-input ap-search"
            aria-label={`在 ${row.name} 中搜索插件`}
            placeholder={`在 ${row.name} 中搜索`}
            value={catalog.query ?? ''}
            onChange={e => setCatalogs(prev => ({ ...prev, [row.name]: { ...prev[row.name], query: e.target.value } }))}
          />
          <span className="ap-help">
            共 {catalog.plugins.length} 个插件{matched.length > CATALOG_LIMIT ? `，只显示前 ${CATALOG_LIMIT} 个；用搜索缩小范围` : ''} · 来自本地 marketplace.json
          </span>
        </div>
        {matched.slice(0, CATALOG_LIMIT).map(plugin => {
          const installed = installedByName.get(plugin.name);
          const localDir = plugin.localDir || installed?.harnesses['claude-code']?.installPath || installed?.harnesses.codex?.installPath || '';
          const itemKey = `${rowKey}:${plugin.name}`;
          return (
            <div key={plugin.name} className="ap-matrix-row ap-catalog-row">
              <div className="ap-row-main">
                <span className="ap-skill-name" title={plugin.description || plugin.name}>
                  {plugin.name}{plugin.version && <span className="ap-row-suffix"> {plugin.version}</span>}
                </span>
                {plugin.description && <span className="ap-help ap-catalog-desc">{plugin.description}</span>}
              </div>
              <ToggleCells
                ariaLabel={`${plugin.name} 各端开关`}
                disabled={busy}
                cells={HARNESS_IDS.map(h => {
                  const entry = installed?.harnesses[h];
                  return {
                    harnessId: h,
                    on: Boolean(entry),
                    status: entry ? 'installed' : 'unselected',
                    label: `${harnessLabel(h)}：${entry ? '已安装' : '未安装'}`,
                    disabledReason: browseBlockReason({ harness: h, marketplaceRow: row, localDir, installed: Boolean(entry) }),
                    busy: pendingKey === `plugin:${plugin.name}@${row.name}:${h}`,
                    onToggle: on => togglePlugin({ name: plugin.name, marketplace: row.name }, h, on, itemKey),
                  };
                })}
              />
              <span />
              {confirmFor(itemKey)}
            </div>
          );
        })}
        {!matched.length && <p className="ap-help">没有符合搜索条件的插件。</p>}
      </div>
    );
  };

  const renderMarketplace = row => {
    const rowKey = `marketplace:${row.name}`;
    const open = Boolean(expanded[rowKey]);
    const catalog = catalogs[row.name];
    const refreshable = MARKETPLACE_HARNESSES.some(h => row.harnesses[h]);
    return (
      <article key={row.name} className="ap-matrix-row ap-pkg-card">
        <div className="ap-row-main">
          <div className="ap-pkg-title-row">
            <RowToggle
              open={open}
              title={row.name}
              controls={`ap-mp-${row.name}`}
              onClick={() => {
                toggleExpanded(rowKey);
                if (!open && !catalog) void loadCatalog(row.name);
              }}
            />
            {row.builtin && <span className="ap-badge">{row.harnesses.antigravity?.builtin ? 'Antigravity 内置' : '内置'}</span>}
          </div>
          <RowMeta indent>{row.source ? sourceLabel(row.source) : row.builtin ? '随该端自带' : '来源未知'}</RowMeta>
        </div>
        <ToggleCells
          ariaLabel={`${row.name} 各端是否添加`}
          disabled={busy}
          cells={HARNESS_IDS.map(h => ({
            harnessId: h,
            on: Boolean(row.harnesses[h]),
            status: row.harnesses[h] ? 'installed' : 'unselected',
            label: `${harnessLabel(h)}：${row.harnesses[h] ? '已添加' : '未添加'}`,
            disabledReason: MARKETPLACE_HARNESSES.includes(h)
              ? (!row.harnesses[h] && !row.source ? '不知道该市场的来源，请用「添加市场」填写' : '')
              : h === 'antigravity' ? 'Antigravity 不支持添加市场，安装插件时直接用本地目录' : 'DSH 原生没有插件机制',
            busy: pendingKey === `marketplace:${row.name}:${h}`,
            onToggle: on => toggleMarketplace(row, h, on),
          }))}
        />
        <div className="ap-pkg-actions">
          {refreshable && (
            <IconButton
              icon="refresh"
              label={`刷新市场 ${row.name}`}
              disabled={busy}
              className={pendingKey === `marketplace.refresh:${row.name}` ? 'is-busy' : ''}
              onClick={() => run({ type: 'marketplace.refresh', name: row.name }, `marketplace.refresh:${row.name}`)}
            />
          )}
        </div>
        {confirmFor(rowKey)}
        {open && <div id={`ap-mp-${row.name}`} className="ap-row-detail ap-catalog">{renderCatalog(row, catalog, rowKey)}</div>}
      </article>
    );
  };

  return (
    <>
      {form && <MarketplaceForm ctx={ctx} onClose={() => setForm(null)} />}
      <div className="ap-list ap-matrix ap-matrix-act">
        <MatrixGroup title="已安装" count={installedRows.length} labels>
          <span className="ap-group-note">版本取自各端记录；只有 Claude Code 提供原生更新命令</span>
        </MatrixGroup>
        {installedRows.length ? installedRows.map(renderPlugin) : <p className="ap-matrix-empty">还没有第三方插件。展开下方的市场浏览并安装。</p>}
        {builtinRows.length > 0 && (
          <MatrixGroup title="内置插件" count={builtinRows.length}>
            {!needle && (
              <button type="button" className="ap-link-btn" aria-expanded={builtinOpen} onClick={() => toggleExpanded('plugins:builtin')}>{builtinOpen ? '收起' : '展开'}</button>
            )}
          </MatrixGroup>
        )}
        {builtinOpen && builtinRows.map(renderPlugin)}
      </div>
      <div className="ap-list ap-matrix ap-matrix-act">
        <MatrixGroup title="市场" count={marketplaceRows.length} labels>
          <span className="ap-group-note">Claude Code / Codex 可添加与移除；Antigravity 只有内置市场</span>
        </MatrixGroup>
        {marketplaceRows.length ? marketplaceRows.map(renderMarketplace) : <p className="ap-matrix-empty">还没有市场。用「添加市场」填写 owner/repo、Git 地址或本地绝对路径。</p>}
      </div>
    </>
  );
}
