import { HARNESS_IDS, MatrixGroup, RowToggle, ToggleCells, harnessLabel } from './client-ui.jsx';

function entryLabel(entry) {
  if (!entry) return '没有';
  if (entry.broken) return '失效软链';
  return entry.isSymlink ? `软链 → ${entry.real}` : `实体目录 ${entry.path}`;
}

export function SkillsView({ ctx }) {
  const { state, busy, pendingKey, search, run, ask, confirmFor, expanded, toggleExpanded } = ctx;
  const needle = search.trim().toLowerCase();
  const rows = state.skills.rows.filter(row => !needle || row.name.toLowerCase().includes(needle));
  const attention = rows.filter(row => !row.complete || !row.consistent || Object.values(row.harnesses).some(e => e.broken));
  const settled = rows.filter(row => !attention.includes(row));
  const settledOpen = Boolean(expanded['skills:settled']) || Boolean(needle);

  const toggle = (row, harness, on) => {
    const key = `skill:${row.name}:${harness}`;
    const exec = () => run({ type: 'skill.toggle', name: row.name, harness, on }, key);
    if (on) return void exec();
    const entry = row.harnesses[harness];
    const label = harnessLabel(harness);
    const text = entry.broken
      ? `将删除 ${label} 的失效软链 ${entry.path}。`
      : entry.isSymlink
        ? `将删除 ${label} 的软链 ${entry.path}（源目录不受影响）。`
        : `将把 ${label} 的实体目录 ${entry.path} 移入回收目录，可从回收目录手工恢复。`;
    ask(`skill:${row.name}`, text, entry.isSymlink || entry.broken ? '确认删除' : '确认移入回收目录', exec);
  };

  const renderRow = row => {
    const open = Boolean(expanded[`skill:${row.name}`]);
    const detailId = `ap-skill-${row.name}`;
    const broken = Object.values(row.harnesses).some(e => e.broken);
    return (
      <article key={row.name} className={`ap-matrix-row ap-pkg-card ${broken ? 'is-error' : !row.consistent ? 'is-warn' : ''}`.trim()}>
        <div className="ap-row-main">
          <div className="ap-pkg-title-row">
            <RowToggle open={open} title={row.name} controls={detailId} mono onClick={() => toggleExpanded(`skill:${row.name}`)} />
            {!row.consistent && <span className="ap-badge ap-badge-update" title="各端的真实路径不同，内容可能不一样">各端内容不同</span>}
            {broken && <span className="ap-badge ap-badge-err">失效软链</span>}
          </div>
        </div>
        <ToggleCells
          ariaLabel={`${row.name} 各端开关`}
          disabled={busy}
          cells={HARNESS_IDS.map(h => {
            const entry = row.harnesses[h];
            return {
              harnessId: h,
              on: Boolean(entry),
              status: entry ? (entry.broken ? 'failed' : 'installed') : 'unselected',
              label: `${harnessLabel(h)}：${entryLabel(entry)}`,
              disabledReason: '',
              busy: pendingKey === `skill:${row.name}:${h}`,
              onToggle: on => toggle(row, h, on),
            };
          })}
        />
        <span />
        {confirmFor(`skill:${row.name}`)}
        {open && (
          <ul id={detailId} className="ap-row-detail ap-mini-list ap-detail-harness">
            {HARNESS_IDS.map(h => (
              <li key={h}>
                <span className="ap-detail-name">{harnessLabel(h)}</span>
                <span className="ap-detail-state">{entryLabel(row.harnesses[h])}</span>
              </li>
            ))}
          </ul>
        )}
      </article>
    );
  };

  if (!rows.length) {
    return (
      <div className="ap-empty">
        <p>{needle ? '没有符合搜索条件的 Skill。' : '4 端的 Skills 目录里还没有 Skill。先用你习惯的方式安装（如 npx skills add），刷新后就会出现在这里。'}</p>
      </div>
    );
  }

  return (
    <div className="ap-list ap-matrix">
      {attention.length > 0 && <MatrixGroup title="部分端 / 不一致" count={attention.length} labels />}
      {attention.map(renderRow)}
      {settled.length > 0 && (
        <MatrixGroup title="4 端一致" count={settled.length} labels={!attention.length}>
          {!needle && (
            <button type="button" className="ap-link-btn" aria-expanded={settledOpen} onClick={() => toggleExpanded('skills:settled')}>
              {settledOpen ? '收起' : '展开'}
            </button>
          )}
        </MatrixGroup>
      )}
      {settledOpen && settled.map(renderRow)}
    </div>
  );
}
