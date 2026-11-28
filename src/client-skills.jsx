import { Fragment } from 'react';
import { HARNESS_IDS, MatrixGroup, RowMeta, RowToggle, ToggleCells, harnessLabel } from './client-ui.jsx';

function entryLabel(entry) {
  if (!entry) return '没有';
  if (entry.broken) return '失效软链';
  return entry.isSymlink ? `软链 → ${entry.real}` : `实体目录 ${entry.path}`;
}

const isBroken = row => Object.values(row.harnesses).some(e => e.broken);

// 分组：插件带来的单独成组；其余按是否需要处理（只在部分端、各端内容不同、有失效软链）
export function skillGroups(state, rows = state.skills.rows) {
  const owned = rows.filter(row => row.providedBy?.length);
  const free = rows.filter(row => !row.providedBy?.length);
  const attn = free.filter(row => !row.complete || !row.consistent || isBroken(row));
  return { attn, owned, settled: free.filter(row => !attn.includes(row)) };
}

function rowMeta(row) {
  if (row.providedBy?.length) return `随插件 ${row.providedBy.join('、')} 安装，不能单独同步；需要在其他端使用请在该端手工安装插件`;
  const present = HARNESS_IDS.filter(h => row.harnesses[h]);
  if (isBroken(row)) return `${HARNESS_IDS.filter(h => row.harnesses[h]?.broken).map(harnessLabel).join('、')} 的软链目标已不存在，可关闭清理`;
  if (!row.consistent) return `${present.length} 端 · 各端是不同的副本，展开查看路径`;
  const real = Object.values(row.harnesses)[0]?.real || Object.values(row.harnesses)[0]?.path;
  return row.complete ? `4 端 → ${real}` : `仅 ${present.map(harnessLabel).join('、')} · ${real}`;
}

export function SkillsView({ ctx }) {
  const { state, busy, pendingKey, search, filter, run, ask, confirmFor, expanded, toggleExpanded } = ctx;
  const needle = search.trim().toLowerCase();
  const rows = state.skills.rows.filter(row => !needle || row.name.toLowerCase().includes(needle));
  const { attn, owned, settled } = skillGroups(state, rows);
  const show = id => filter === 'all' || filter === id;
  const settledOpen = Boolean(expanded['skills:settled']) || Boolean(needle) || filter === 'settled';

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
        : `将把 ${label} 的实体目录 ${entry.path} 移入回收目录 ${state.trashDir}，可从回收目录手工恢复。`;
    ask(`skill:${row.name}`, text, entry.isSymlink || entry.broken ? '确认删除' : '确认移入回收目录', exec);
  };

  const renderRow = row => {
    const open = Boolean(expanded[`skill:${row.name}`]);
    const detailId = `ap-skill-${row.name}`;
    const broken = isBroken(row);
    const ownedBy = row.providedBy?.length ? row.providedBy.join('、') : '';
    return (
      <article key={row.name} className="ap-matrix-row ap-pkg-card">
        <div className="ap-row-main">
          <div className="ap-pkg-title-row">
            <RowToggle open={open} title={row.name} controls={detailId} mono onClick={() => toggleExpanded(`skill:${row.name}`)} />
            {ownedBy && <span className="ap-badge ap-badge-kind" title="由插件安装与清理，不能在这里单独同步">插件 {ownedBy}</span>}
            {!ownedBy && !row.consistent && <span className="ap-badge ap-badge-kind" title="各端的真实路径不同，内容可能不一样">各端内容不同</span>}
            {!ownedBy && broken && <span className="ap-badge ap-badge-warn">失效软链</span>}
          </div>
          <RowMeta indent>{rowMeta(row)}</RowMeta>
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
              disabledReason: ownedBy ? `由插件 ${ownedBy} 提供，跟随插件安装，不能单独同步；${h === 'dsh' ? 'DSH 原生没有插件机制' : '需要在其他端使用请在该端手工安装插件'}` : '',
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

  const groups = [
    show('attn') && attn.length > 0 && { id: 'attn', title: '需处理', note: '只在部分端、各端内容不同或有失效软链', rows: attn },
    show('owned') && owned.length > 0 && { id: 'owned', title: '由插件提供', note: '开关已锁定：关闭会删掉插件自己的文件', rows: owned },
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
