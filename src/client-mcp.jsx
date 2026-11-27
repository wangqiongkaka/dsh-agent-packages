import { useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { HARNESS_IDS, MatrixGroup, RowToggle, Select, ToggleCells, harnessLabel } from './client-ui.jsx';

const TRANSPORT_OPTIONS = [
  { value: 'stdio', label: 'Stdio（本地命令）' },
  { value: 'http', label: 'HTTP（远程地址）' },
];

function specSummary(spec) {
  if (!spec) return '没有';
  return spec.transport === 'http' ? spec.url : [spec.command, ...spec.args].join(' ');
}

function draftFromSpec(key, spec, harnesses, baseHarness = '', inconsistent = false) {
  const envRows = [
    ...Object.entries(spec?.env ?? {}).map(([k, v]) => ({ key: k, value: v })),
    ...(spec?.envRefs ?? []).map(k => ({ key: k, value: '' })),
  ];
  return {
    key,
    transport: spec?.transport || 'stdio',
    command: spec?.command || '',
    argsText: (spec?.args ?? []).join(' '),
    url: spec?.url || '',
    envRows: envRows.length ? envRows : [{ key: '', value: '' }],
    harnesses,
    baseHarness,
    inconsistent,
  };
}

function McpForm({ ctx, initial, editing, onClose }) {
  const { state, busy, run, pendingKey } = ctx;
  const [draft, setDraft] = useState(initial);
  const writable = state.harnesses.filter(h => h.supportsMcp);
  const set = patch => setDraft(prev => ({ ...prev, ...patch }));
  const setEnv = (index, patch) => set({ envRows: draft.envRows.map((row, i) => (i === index ? { ...row, ...patch } : row)) });
  const save = () => {
    const env = {};
    const envRefs = [];
    for (const row of draft.envRows) {
      const k = row.key.trim();
      if (!k) continue;
      if (row.value === '') envRefs.push(k);
      else env[k] = row.value;
    }
    run({
      type: 'mcp.save',
      key: draft.key.trim(),
      harnesses: draft.harnesses,
      spec: { transport: draft.transport, command: draft.command, args: draft.argsText.split(/\s+/).filter(Boolean), url: draft.url, env, envRefs },
    }, 'mcp.save', onClose);
  };
  const canSave = draft.key.trim() && draft.harnesses.length && (draft.transport === 'http' ? draft.url.trim() : draft.command.trim());
  return (
    <section className="ap-card ap-editor" aria-label={editing ? `编辑 MCP ${draft.key}` : '添加 MCP'}>
      <div className="ap-editor-head">
        <h3>{editing ? `编辑 ${draft.key}` : '添加 MCP'}</h3>
      </div>
      <div className="ap-grid">
        <div className="ap-field">
          <label htmlFor="ap-mcp-key">Server key</label>
          <input id="ap-mcp-key" className="ap-input" placeholder="如 playwright" value={draft.key} disabled={editing} onChange={e => set({ key: e.target.value })} />
        </div>
        <div className="ap-field">
          <label htmlFor="ap-mcp-transport">传输方式</label>
          <Select id="ap-mcp-transport" ariaLabel="传输方式" value={draft.transport} options={TRANSPORT_OPTIONS} onChange={transport => set({ transport })} />
        </div>
        {draft.transport === 'stdio' ? (
          <>
            <div className="ap-field">
              <label htmlFor="ap-mcp-command">命令</label>
              <input id="ap-mcp-command" className="ap-input" placeholder="如 npx" value={draft.command} onChange={e => set({ command: e.target.value })} />
            </div>
            <div className="ap-field">
              <label htmlFor="ap-mcp-args">参数</label>
              <input id="ap-mcp-args" className="ap-input" placeholder="空格分隔，如 -y @playwright/mcp@latest" value={draft.argsText} onChange={e => set({ argsText: e.target.value })} />
            </div>
          </>
        ) : (
          <div className="ap-field">
            <label htmlFor="ap-mcp-url">地址</label>
            <input id="ap-mcp-url" className="ap-input" placeholder="https://example.com/mcp" value={draft.url} onChange={e => set({ url: e.target.value })} />
          </div>
        )}
      </div>
      {draft.transport === 'stdio' && (
        <div className="ap-field ap-kv-field">
          <div className="ap-kv-head">
            <label htmlFor="ap-mcp-env-key-0">环境变量</label>
            <Button variant="outline" onClick={() => set({ envRows: [...draft.envRows, { key: '', value: '' }] })}>添加变量</Button>
          </div>
          <div className="ap-kv-list">
            {draft.envRows.map((row, index) => (
              <div key={index} className="ap-kv-row">
                <label htmlFor={`ap-mcp-env-key-${index}`} className="ap-sr-only">变量名 {index + 1}</label>
                <input id={`ap-mcp-env-key-${index}`} className="ap-input ap-kv-key" placeholder="变量名" value={row.key} onChange={e => setEnv(index, { key: e.target.value })} />
                <label htmlFor={`ap-mcp-env-val-${index}`} className="ap-sr-only">变量值 {index + 1}</label>
                <input id={`ap-mcp-env-val-${index}`} className="ap-input ap-kv-val" placeholder="值（留空则引用宿主机变量）" value={row.value} onChange={e => setEnv(index, { value: e.target.value })} />
                <Button variant="outline" aria-label={`删除第 ${index + 1} 行环境变量`} onClick={() => set({ envRows: draft.envRows.filter((_, i) => i !== index) })}>删除</Button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="ap-field">
        <span className="ap-field-label" id="ap-mcp-targets">写入到</span>
        <div className="ap-check-group" role="group" aria-labelledby="ap-mcp-targets">
          {writable.map(h => (
            <label key={h.id} className="ap-check-item">
              <input
                type="checkbox"
                checked={draft.harnesses.includes(h.id)}
                onChange={() => set({ harnesses: draft.harnesses.includes(h.id) ? draft.harnesses.filter(x => x !== h.id) : [...draft.harnesses, h.id] })}
              />
              <span>{h.label}</span>
            </label>
          ))}
        </div>
        <p className="ap-help">
          {draft.baseHarness ? `底稿取自 ${harnessLabel(draft.baseHarness)}。` : ''}
          {draft.inconsistent ? '各端配置不同（可能是有意的），默认只写回底稿所在的端；勾选其他端会用这份配置覆盖它们。' : ''}
          写入时保留各端原有的其他字段（如 alwaysLoad）；没勾选的端不改动。
        </p>
      </div>
      <div className="ap-editor-footer">
        <Button variant="outline" disabled={busy} onClick={onClose}>取消</Button>
        <Button variant="outline" disabled={busy || !canSave} onClick={save}>{pendingKey === 'mcp.save' ? '保存中…' : '保存并写入'}</Button>
      </div>
    </section>
  );
}

export function McpView({ ctx, form, setForm }) {
  const { state, busy, pendingKey, search, run, ask, confirmFor, expanded, toggleExpanded, openMenuId, setOpenMenuId } = ctx;
  const needle = search.trim().toLowerCase();
  const rows = state.mcp.rows.filter(row => !needle || row.key.toLowerCase().includes(needle));
  const writable = new Set(state.harnesses.filter(h => h.supportsMcp).map(h => h.id));
  const errors = Object.entries(state.mcp.errors ?? {});

  const toggle = (row, harness, on) => {
    const key = `mcp:${row.key}:${harness}`;
    const exec = () => run({ type: 'mcp.toggle', key: row.key, harness, on }, key);
    if (on) return void exec();
    ask(`mcp:${row.key}`, `将从 ${harnessLabel(harness)} 的 MCP 配置移除「${row.key}」，其他条目不受影响。`, '确认移除', exec);
  };

  const openEdit = row => {
    setOpenMenuId('');
    const present = HARNESS_IDS.filter(h => row.harnesses[h]);
    // 各端配置不同时默认只写回底稿所在的端，避免一次编辑抹平各端有意保留的差异
    setForm({ editing: true, initial: draftFromSpec(row.key, row.harnesses[present[0]].spec, row.consistent ? present : [present[0]], present[0], !row.consistent) });
  };

  const renderRow = row => {
    if (form?.editing && form.initial.key === row.key) {
      return <McpForm key={`edit:${row.key}`} ctx={ctx} initial={form.initial} editing onClose={() => setForm(null)} />;
    }
    const open = Boolean(expanded[`mcp:${row.key}`]);
    const menuOpen = openMenuId === `mcp:${row.key}`;
    const first = Object.values(row.harnesses)[0]?.spec;
    return (
      <article key={row.key} className="ap-matrix-row ap-pkg-card">
        <div className="ap-row-main">
          <div className="ap-pkg-title-row">
            <RowToggle open={open} title={row.key} controls={`ap-mcp-${row.key}`} onClick={() => toggleExpanded(`mcp:${row.key}`)} />
            <span className="ap-badge">{first?.transport === 'http' ? 'HTTP' : 'Stdio'}</span>
            {!row.consistent && <span className="ap-badge" title="各端的命令、参数或环境变量不同">各端配置不同</span>}
          </div>
        </div>
        <ToggleCells
          ariaLabel={`${row.key} 各端开关`}
          disabled={busy}
          cells={HARNESS_IDS.map(h => ({
            harnessId: h,
            on: Boolean(row.harnesses[h]),
            status: row.harnesses[h] ? 'installed' : 'unselected',
            label: `${harnessLabel(h)}：${row.harnesses[h] ? specSummary(row.harnesses[h].spec) : '没有'}`,
            disabledReason: writable.has(h) ? '' : `${harnessLabel(h)} 没有可写入的 MCP 配置文件`,
            busy: pendingKey === `mcp:${row.key}:${h}`,
            onToggle: on => toggle(row, h, on),
          }))}
        />
        <div className="ap-pkg-actions">
          <div className="ap-menu-wrap">
            <Button variant="outline" disabled={busy} aria-haspopup="menu" aria-expanded={menuOpen} aria-label={`${row.key} 更多操作`} onClick={() => setOpenMenuId(menuOpen ? '' : `mcp:${row.key}`)}>更多 ▾</Button>
            {menuOpen && (
              <div className="ap-menu-pop" role="menu" aria-label={`${row.key} 操作菜单`}>
                <button type="button" role="menuitem" className="ap-menu-item" onClick={() => openEdit(row)}>编辑</button>
              </div>
            )}
          </div>
        </div>
        {confirmFor(`mcp:${row.key}`)}
        {open && (
          <ul id={`ap-mcp-${row.key}`} className="ap-row-detail ap-mini-list ap-detail-harness">
            {HARNESS_IDS.filter(h => writable.has(h)).map(h => (
              <li key={h}>
                <span className="ap-detail-name">{harnessLabel(h)}</span>
                <span className="ap-detail-state">
                  <code>{specSummary(row.harnesses[h]?.spec)}</code>
                  {row.harnesses[h] && (Object.keys(row.harnesses[h].spec.env).length + row.harnesses[h].spec.envRefs.length) > 0 && (
                    <span className="ap-detail-sub">环境变量：{[...Object.keys(row.harnesses[h].spec.env), ...row.harnesses[h].spec.envRefs.map(k => `${k}（引用）`)].join('、')}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </article>
    );
  };

  return (
    <>
      {form && !form.editing && <McpForm key="new" ctx={ctx} initial={form.initial} onClose={() => setForm(null)} />}
      {errors.length > 0 && (
        <ul className="ap-mini-list ap-warning-list" aria-label="配置读取失败">
          {errors.map(([h, message]) => <li key={h}><span><span className="ap-badge ap-badge-err" style={{ marginRight: 8 }}>{harnessLabel(h)}</span>{message}</span></li>)}
        </ul>
      )}
      {rows.length ? (
        <div className="ap-list ap-matrix">
          <MatrixGroup title="MCP Servers" count={rows.length} labels />
          {rows.map(renderRow)}
        </div>
      ) : (
        <div className="ap-empty">
          <p>{needle ? '没有符合搜索条件的 MCP。' : '3 端的 MCP 配置里还没有 Server。手工添加一个，或在各端装好后刷新。'}</p>
        </div>
      )}
    </>
  );
}

export function newMcpForm(state) {
  return { editing: false, initial: draftFromSpec('', null, state.harnesses.filter(h => h.supportsMcp).map(h => h.id)) };
}
