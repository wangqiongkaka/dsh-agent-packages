import { Fragment } from 'react';
import { HARNESS_IDS, MatrixCells, MatrixGroup, RowMeta, RowToggle, harnessLabel } from './client-ui.jsx';

function entryLabel(entry) {
  if (!entry) return '没有';
  if (entry.broken) return '失效软链';
  return entry.isSymlink ? `软链 → ${entry.real}` : `实体目录 ${entry.path}`;
}

const isBroken = row => Object.values(row.harnesses).some(e => e.broken);

// 分组：只在部分端、各端内容不同或有失效软链的排在前面；页面只读，由用户在各端手工处理
export function skillGroups(state, rows = state.skills.rows) {
  const attn = rows.filter(row => !row.complete || !row.consistent || isBroken(row));
  return { attn, settled: rows.filter(row => !attn.includes(row)) };
}

function rowMeta(row) {
  const present = HARNESS_IDS.filter(h => row.harnesses[h]);
  if (isBroken(row)) return `${HARNESS_IDS.filter(h => row.harnesses[h]?.broken).map(harnessLabel).join('、')} 的软链目标已不存在`;
  if (!row.consistent) return `${present.length} 端 · 各端是不同的副本，展开查看路径`;
  const real = Object.values(row.harnesses)[0]?.real || Object.values(row.harnesses)[0]?.path;
  return row.complete ? `4 端 → ${real}` : `仅 ${present.map(harnessLabel).join('、')} · ${real}`;
}

export function SkillsView({ ctx }) {
  const { state, search, filter, expanded, toggleExpanded } = ctx;
  const needle = search.trim().toLowerCase();
  const rows = state.skills.rows.filter(row => !needle || row.name.toLowerCase().includes(needle));
  const { attn, settled } = skillGroups(state, rows);
  const show = id => filter === 'all' || filter === id;
  const settledOpen = Boolean(expanded['skills:settled']) || Boolean(needle) || filter === 'settled';

  const renderRow = row => {
    const open = Boolean(expanded[`skill:${row.name}`]);
    const detailId = `ap-skill-${row.name}`;
    const broken = isBroken(row);
    return (
      <article key={row.name} className="ap-matrix-row ap-pkg-card">
        <div className="ap-row-main">
          <div className="ap-pkg-title-row">
            <RowToggle open={open} title={row.name} controls={detailId} mono onClick={() => toggleExpanded(`skill:${row.name}`)} />
            {!row.consistent && <span className="ap-badge ap-badge-kind" title="各端的真实路径不同，内容可能不一样">各端内容不同</span>}
            {broken && <span className="ap-badge ap-badge-warn">失效软链</span>}
          </div>
          <RowMeta indent>{rowMeta(row)}</RowMeta>
        </div>
        <MatrixCells
          ariaLabel={`${row.name} 各端情况`}
          cells={HARNESS_IDS.map(h => {
            const entry = row.harnesses[h];
            return { harnessId: h, status: entry ? (entry.broken ? 'failed' : 'installed') : 'none', label: `${harnessLabel(h)}：${entryLabel(entry)}` };
          })}
        />
        <span />
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

  const groups = [
    show('attn') && attn.length > 0 && { id: 'attn', title: '需处理', note: '只在部分端、各端内容不同或有失效软链', rows: attn },
    show('settled') && settled.length > 0 && { id: 'settled', title: '4 端一致', note: '4 端指向同一目录', rows: settled, collapsible: !needle && filter !== 'settled' },
  ].filter(Boolean);

  if (!groups.length) {
    return (
      <div className="ap-empty">
        <p>{needle || filter !== 'all' ? '没有符合条件的 Skill。' : '4 端的 Skills 目录里还没有 Skill。先用你习惯的方式安装（如 npx skills add），刷新后就会出现在这里。'}</p>
      </div>
    );
  }

  return (
    <div className="ap-list ap-matrix">
      {groups.map((group, index) => (
        <Fragment key={group.id}>
          <MatrixGroup title={group.title} count={group.rows.length} labels={index === 0}>
            <span className="ap-group-note">{group.note}</span>
            {group.collapsible && (
              <button type="button" className="ap-link-btn" aria-expanded={settledOpen} onClick={() => toggleExpanded('skills:settled')}>
                {settledOpen ? '收起' : '展开'}
              </button>
            )}
          </MatrixGroup>
          {(group.id !== 'settled' || settledOpen) && group.rows.map(renderRow)}
        </Fragment>
      ))}
    </div>
  );
}
