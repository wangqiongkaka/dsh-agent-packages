import { useEffect, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { HARNESS_IDS, MatrixGroup, RowToggle, ToggleCells, harnessLabel } from './client-ui.jsx';

const MARKETPLACE_HARNESSES = ['claude-code', 'codex'];

function versionText(row) {
  const versions = [...new Set(Object.values(row.harnesses).map(item => item.version).filter(Boolean))];
  return versions.length ? versions.map(v => (/^\d/.test(v) ? `v${v}` : v)).join(' / ') : '';
}

const CATALOG_LIMIT = 50;

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
  const { busy, run, pendingKey } = ctx;
  const [source, setSource] = useState('');
  const [harnesses, setHarnesses] = useState(MARKETPLACE_HARNESSES);
  return (
    <section className="ap-card ap-editor" aria-label="添加市场">
      <div className="ap-editor-head"><h3>添加市场</h3></div>
      <div className="ap-field">
        <label htmlFor="ap-mp-source">市场来源</label>
        <input id="ap-mp-source" className="ap-input" placeholder="owner/repo、Git 地址或本地路径，如 anthropics/claude-plugins-official" value={source} onChange={e => setSource(e.target.value)} />
      </div>
      <div className="ap-field">
        <span className="ap-field-label" id="ap-mp-targets">添加到</span>
        <div className="ap-check-group" role="group" aria-labelledby="ap-mp-targets">
          {MARKETPLACE_HARNESSES.map(h => (
            <label key={h} className="ap-check-item">
              <input type="checkbox" checked={harnesses.includes(h)} onChange={() => setHarnesses(harnesses.includes(h) ? harnesses.filter(x => x !== h) : [...harnesses, h])} />
              <span>{harnessLabel(h)}</span>
            </label>
          ))}
        </div>
        <p className="ap-help">分别执行各端的「plugin marketplace add」。Antigravity 没有添加市场的命令，其插件直接用本地目录安装。</p>
      </div>
      <div className="ap-editor-footer">
        <Button variant="outline" disabled={busy} onClick={onClose}>取消</Button>
        <Button variant="outline" disabled={busy || !source.trim() || !harnesses.length} onClick={() => run({ type: 'marketplace.add', source: source.trim(), harnesses }, 'marketplace.add', onClose)}>
          {pendingKey === 'marketplace.add' ? '添加中…' : '添加市场'}
        </Button>
      </div>
    </section>
  );
}

export function PluginsView({ ctx, form, setForm }) {
  const { state, busy, pendingKey, search, run, ask, confirmFor, expanded, toggleExpanded, openMenuId, setOpenMenuId, request, catalogs, setCatalogs } = ctx;
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
    const menuOpen = openMenuId === rowKey;
    const version = versionText(row);
    return (
      <article key={row.id} className="ap-matrix-row ap-pkg-card">
        <div className="ap-row-main">
          <div className="ap-pkg-title-row">
            <span className="ap-pkg-title" title={row.id}>{row.name}</span>
            {row.marketplace && <span className="ap-badge" title="所属市场">@{row.marketplace}</span>}
            {version && <span className="ap-badge ap-badge-ver">{version}</span>}
          </div>
        </div>
        <ToggleCells ariaLabel={`${row.name} 各端开关`} disabled={busy} cells={pluginCells(row, rowKey)} />
        <div className="ap-pkg-actions">
          {row.harnesses['claude-code'] && (
            <div className="ap-menu-wrap">
              <Button variant="outline" disabled={busy} aria-haspopup="menu" aria-expanded={menuOpen} aria-label={`${row.name} 更多操作`} onClick={() => setOpenMenuId(menuOpen ? '' : rowKey)}>更多 ▾</Button>
              {menuOpen && (
                <div className="ap-menu-pop" role="menu" aria-label={`${row.name} 操作菜单`}>
                  <button type="button" role="menuitem" className="ap-menu-item" onClick={() => { setOpenMenuId(''); run({ type: 'plugin.update', id: row.id }, `plugin.update:${row.id}`); }}>更新（Claude Code）</button>
                </div>
              )}
            </div>
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

  const renderMarketplace = row => {
    const rowKey = `marketplace:${row.name}`;
    const open = Boolean(expanded[rowKey]);
    const menuOpen = openMenuId === rowKey;
    const catalog = catalogs[row.name];
    const refreshable = MARKETPLACE_HARNESSES.some(h => row.harnesses[h]);
    const installedByName = new Map(plugins.filter(p => p.marketplace === row.name || !p.marketplace).map(p => [p.name, p]));
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
            {row.builtin
              ? <span className="ap-badge">{row.harnesses.antigravity?.builtin ? 'Antigravity 内置' : '内置'}</span>
              : row.source && !row.source.startsWith('/') && <span className="ap-badge ap-badge-source" title={row.source}>{row.source.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')}</span>}
          </div>
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
            <div className="ap-menu-wrap">
              <Button variant="outline" disabled={busy} aria-haspopup="menu" aria-expanded={menuOpen} aria-label={`${row.name} 更多操作`} onClick={() => setOpenMenuId(menuOpen ? '' : rowKey)}>更多 ▾</Button>
              {menuOpen && (
                <div className="ap-menu-pop" role="menu" aria-label={`${row.name} 操作菜单`}>
                  <button type="button" role="menuitem" className="ap-menu-item" onClick={() => { setOpenMenuId(''); run({ type: 'marketplace.refresh', name: row.name }, `marketplace.refresh:${row.name}`); }}>刷新市场</button>
                </div>
              )}
            </div>
          )}
        </div>
        {confirmFor(rowKey)}
        {open && (
          <div id={`ap-mp-${row.name}`} className="ap-row-detail ap-catalog">
            {!catalog || catalog.loading ? <p className="ap-help">正在读取市场里的插件…</p>
              : catalog.error ? <p className="ap-field-error" role="alert">{catalog.error}</p>
                : !catalog.plugins.length ? <p className="ap-help">市场目录里没有找到 marketplace.json。</p>
                  : (
                    <div className="ap-catalog-list">
                      {(() => {
                        const matched = catalog.plugins.filter(p => match(p.name) || match(row.name));
                        return matched.length > CATALOG_LIMIT
                          ? <p className="ap-help ap-catalog-more">共 {matched.length} 个插件，只显示前 {CATALOG_LIMIT} 个；用上方搜索缩小范围。</p>
                          : null;
                      })()}
                      {catalog.plugins.filter(p => match(p.name) || match(row.name)).slice(0, CATALOG_LIMIT).map(plugin => {
                        const installed = installedByName.get(plugin.name);
                        const localDir = plugin.localDir || installed?.harnesses['claude-code']?.installPath || installed?.harnesses.codex?.installPath || '';
                        const itemKey = `${rowKey}:${plugin.name}`;
                        return (
                          <div key={plugin.name} className="ap-matrix-row ap-catalog-row">
                            <div className="ap-row-main">
                              <span className="ap-skill-name" title={plugin.description || plugin.name}>{plugin.name}</span>
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
                    </div>
                  )}
          </div>
        )}
      </article>
    );
  };

  return (
    <>
      {form && <MarketplaceForm ctx={ctx} onClose={() => setForm(null)} />}
      <div className="ap-list ap-matrix">
        <MatrixGroup title="已安装" count={installedRows.length} labels />
        {installedRows.length ? installedRows.map(renderPlugin) : <p className="ap-matrix-empty">还没有第三方插件。展开下方的市场浏览并安装。</p>}
        {builtinRows.length > 0 && (
          <MatrixGroup title="内置插件" count={builtinRows.length}>
            {!needle && (
              <button type="button" className="ap-link-btn" aria-expanded={builtinOpen} onClick={() => toggleExpanded('plugins:builtin')}>{builtinOpen ? '收起' : '展开'}</button>
            )}
          </MatrixGroup>
        )}
        {builtinOpen && builtinRows.map(renderPlugin)}
        <MatrixGroup title="市场" count={marketplaceRows.length} />
        {marketplaceRows.map(renderMarketplace)}
      </div>
    </>
  );
}
