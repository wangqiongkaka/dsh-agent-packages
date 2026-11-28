import { HARNESS_IDS, MatrixCells, MatrixGroup, RowMeta, harnessLabel } from './client-ui.jsx';

// 插件由各端原生命令手工安装（各家插件框架不一致，难以做到所有端都兼容），这里只读取各端记录展示
function versionText(row) {
  return HARNESS_IDS.filter(h => row.harnesses[h])
    .map(h => `${harnessLabel(h)}${row.harnesses[h].version ? ` ${row.harnesses[h].version}` : ''}`)
    .join(' · ');
}

function pluginCells(row, supported) {
  return HARNESS_IDS.map(h => {
    const entry = row.harnesses[h];
    const text = entry ? `已安装${entry.version ? ` ${entry.version}` : ''}` : supported.has(h) ? '未安装' : '没有插件机制';
    return { harnessId: h, status: entry ? 'installed' : 'none', label: `${harnessLabel(h)}：${text}` };
  });
}

export function PluginsView({ ctx }) {
  const { state, search, expanded, toggleExpanded } = ctx;
  const needle = search.trim().toLowerCase();
  const supported = new Set(state.harnesses.filter(h => h.supportsPlugins).map(h => h.id));
  const match = text => !needle || String(text).toLowerCase().includes(needle);
  const installedRows = state.plugins.plugins.filter(row => !row.builtin && match(row.id));
  const builtinRows = state.plugins.plugins.filter(row => row.builtin && match(row.id));
  const builtinOpen = Boolean(expanded['plugins:builtin']) || (Boolean(needle) && builtinRows.length > 0);

  const renderPlugin = row => (
    <article key={row.id} className="ap-matrix-row ap-pkg-card">
      <div className="ap-row-main">
        <div className="ap-pkg-title-row">
          <span className="ap-pkg-title" title={row.id}>{row.name}</span>
          {row.marketplace && <span className="ap-row-suffix ap-mono" title="所属市场">@{row.marketplace}</span>}
        </div>
        <RowMeta>{versionText(row)}</RowMeta>
      </div>
      <MatrixCells ariaLabel={`${row.name} 各端安装情况`} cells={pluginCells(row, supported)} />
    </article>
  );

  return (
    <div className="ap-list ap-matrix">
      <MatrixGroup title="已安装" count={installedRows.length} labels>
        <span className="ap-group-note">版本取自各端记录</span>
      </MatrixGroup>
      {installedRows.length ? installedRows.map(renderPlugin) : (
        <p className="ap-matrix-empty">{needle ? '没有符合条件的插件。' : '还没有第三方插件。用各端原生命令安装后，刷新就会出现在这里。'}</p>
      )}
      {builtinRows.length > 0 && (
        <MatrixGroup title="内置插件" count={builtinRows.length}>
          {!needle && (
            <button type="button" className="ap-link-btn" aria-expanded={builtinOpen} onClick={() => toggleExpanded('plugins:builtin')}>{builtinOpen ? '收起' : '展开'}</button>
          )}
        </MatrixGroup>
      )}
      {builtinOpen && builtinRows.map(renderPlugin)}
    </div>
  );
}
