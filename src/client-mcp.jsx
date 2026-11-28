import { Fragment, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { isPlainObject } from './shared.mjs';
import { renderMcpForHarness } from './mcp-render.mjs';
import { HARNESS_IDS, IconButton, MatrixGroup, RowMeta, RowToggle, ToggleCells, harnessLabel } from './client-ui.jsx';

const TRANSPORT_OPTIONS = [
  { value: 'stdio', label: 'Stdio（本地命令）' },
  { value: 'http', label: 'HTTP（远程地址）' },
];

function specSummary(spec) {
  if (!spec) return '没有';
  return spec.transport === 'http' ? spec.url : [spec.command, ...spec.args].join(' ');
}

const specText = spec => JSON.stringify(spec ?? null);

// 分组：插件带来的单独成组；其余按是否需要处理（只在部分可写端、或各端配置不同）
export function mcpGroups(state, rows = state.mcp.rows) {
  const writable = state.harnesses.filter(h => h.supportsMcp).map(h => h.id);
  const owned = rows.filter(row => row.providedBy?.length);
  const free = rows.filter(row => !row.providedBy?.length);
  const attn = free.filter(row => !row.consistent || writable.some(h => !row.harnesses[h]));
  return { attn, owned, settled: free.filter(row => !attn.includes(row)), writable };
}

function draftFromSpec(key, spec, harnesses, { baseHarness = '', inconsistent = false, row = null } = {}) {
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
    row,
  };
}

function specFromDraft(draft) {
  const env = {};
  const envRefs = [];
  for (const item of draft.envRows) {
    const k = item.key.trim();
    if (!k) continue;
    if (item.value === '') envRefs.push(k);
    else env[k] = item.value;
  }
  return { transport: draft.transport, command: draft.command, args: draft.argsText.split(/\s+/).filter(Boolean), url: draft.url, env, envRefs };
}

// 「将写入」预览：与服务端同一份渲染函数；Codex 以 TOML 示意，其余端为 JSON
const tomlKey = key => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key));
function previewText(harnessId, key, config) {
  if (harnessId !== 'codex') return `"${key}": ${JSON.stringify(config, null, 2)}`;
  const table = `mcp_servers.${tomlKey(key)}`;
  const lines = [`[${table}]`];
  const tables = [];
  for (const [field, value] of Object.entries(config)) {
    if (isPlainObject(value)) {
      tables.push(`\n[${table}.${tomlKey(field)}]\n${Object.entries(value).map(([k, v]) => `${tomlKey(k)} = ${JSON.stringify(v)}`).join('\n')}`);
    } else {
      lines.push(`${tomlKey(field)} = ${JSON.stringify(value)}`);
    }
  }
  return lines.join('\n') + tables.join('\n');
}

function targetNote(draft, harnessId) {
  const row = draft.row;
  if (!row) return '将新增';
  const entry = row.harnesses[harnessId];
  if (!entry) return '未配置 · 将新增';
  if (harnessId === draft.baseHarness) return '底稿所在端 · 已配置';
  return specText(entry.spec) === specText(row.harnesses[draft.baseHarness]?.spec) ? '已配置' : '配置不同 · 勾选会覆盖为此配置';
}

function McpForm({ ctx, initial, editing, onClose }) {
  const { state, busy, run, pendingKey } = ctx;
  const [draft, setDraft] = useState(initial);
  const set = patch => setDraft(prev => ({ ...prev, ...patch }));
  const setEnv = (index, patch) => set({ envRows: draft.envRows.map((row, i) => (i === index ? { ...row, ...patch } : row)) });
  const spec = specFromDraft(draft);
  const save = () => run({ type: 'mcp.save', key: draft.key.trim(), harnesses: draft.harnesses, spec }, 'mcp.save', onClose);
  const canSave = draft.key.trim() && draft.harnesses.length && (draft.transport === 'http' ? draft.url.trim() : draft.command.trim());
  const key = draft.key.trim() || '<key>';
  const previews = draft.harnesses.map(h => {
    const meta = state.harnesses.find(item => item.id === h);
    try {
      return { h, file: meta.mcpFile, text: previewText(h, key, renderMcpForHarness(h, spec, draft.row?.harnesses[h]?.extras)) };
    } catch (cause) {
      return { h, file: meta.mcpFile, error: draft.transport === 'http' ? '填写地址后显示' : '填写命令后显示' };
    }
  });
  return (
    <section className="ap-card ap-editor ap-form" aria-label={editing ? `编辑 MCP ${draft.key}` : '添加 MCP'}>
      <div className="ap-editor-head">
        <h3>{editing ? <>编辑 <span className="ap-mono">{draft.key}</span></> : '添加 MCP'}</h3>
        {draft.baseHarness && !draft.inconsistent && <p className="ap-help">底稿取自 {harnessLabel(draft.baseHarness)}。</p>}
      </div>
      {draft.inconsistent && (
        <p className="ap-info">底稿取自 {harnessLabel(draft.baseHarness)}。各端配置不同（可能是有意的），默认只写回底稿所在的端；勾选其他端会用这份配置覆盖它们。</p>
      )}
      <div className="ap-form-body">
        <div className="ap-form-main">
          <div className="ap-field">
            <label htmlFor="ap-mcp-key">Server key</label>
            <input id="ap-mcp-key" className="ap-input ap-mono" placeholder="如 playwright" value={draft.key} disabled={editing} onChange={e => set({ key: e.target.value })} />
            {editing && <p className="ap-help">编辑时不能修改 Server key。</p>}
          </div>
          <div className="ap-field">
            <span className="ap-field-label" id="ap-mcp-transport">传输方式</span>
            <div className="ap-seg" role="radiogroup" aria-labelledby="ap-mcp-transport">
              {TRANSPORT_OPTIONS.map(option => (
                <label key={option.value} className={`ap-seg-item ${draft.transport === option.value ? 'is-on' : ''}`.trim()}>
                  <input type="radio" name="ap-mcp-transport" value={option.value} checked={draft.transport === option.value} onChange={() => set({ transport: option.value })} />
                  {option.label}
                </label>
              ))}
            </div>
          </div>
          {draft.transport === 'stdio' ? (
            <div className="ap-grid">
              <div className="ap-field">
                <label htmlFor="ap-mcp-command">命令</label>
                <input id="ap-mcp-command" className="ap-input ap-mono" placeholder="如 npx" value={draft.command} onChange={e => set({ command: e.target.value })} />
              </div>
              <div className="ap-field">
                <label htmlFor="ap-mcp-args">参数</label>
                <input id="ap-mcp-args" className="ap-input ap-mono" placeholder="空格分隔，如 -y @playwright/mcp@latest" value={draft.argsText} onChange={e => set({ argsText: e.target.value })} />
              </div>
            </div>
          ) : (
            <div className="ap-field">
              <label htmlFor="ap-mcp-url">地址</label>
              <input id="ap-mcp-url" className="ap-input ap-mono" placeholder="https://example.com/mcp" value={draft.url} onChange={e => set({ url: e.target.value })} />
            </div>
          )}
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
                    <IconButton icon="trash" label={`删除第 ${index + 1} 行环境变量`} className="is-danger" onClick={() => set({ envRows: draft.envRows.filter((_, i) => i !== index) })} />
                  </div>
                ))}
              </div>
              <p className="ap-help">值留空表示引用本机同名环境变量；写入 Codex 时转为 env_vars。</p>
            </div>
          )}
          <fieldset className="ap-field ap-fieldset">
            <legend className="ap-field-label">写入到</legend>
            <div className="ap-targets">
              {state.harnesses.map(h => {
                const checked = draft.harnesses.includes(h.id);
                return (
                  <label key={h.id} className={`ap-check-item ap-target ${checked ? 'is-on' : ''} ${h.supportsMcp ? '' : 'is-na'}`.replace(/\s+/g, ' ').trim()}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!h.supportsMcp}
                      onChange={() => set({ harnesses: checked ? draft.harnesses.filter(x => x !== h.id) : [...draft.harnesses, h.id] })}
                    />
                    <span>
                      <b>{h.label}</b>
                      <small>{h.supportsMcp ? targetNote(draft, h.id) : '没有可写入的 MCP 配置文件'}</small>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        </div>
        <aside className="ap-form-side" aria-label="将写入的配置">
          <h4>将写入</h4>
          <p className="ap-help">只改动这个 key，其他条目与各端原有的其他字段（如 alwaysLoad）原样保留；没勾选的端不改动。</p>
          {previews.length ? previews.map(item => (
            <div key={item.h} className="ap-preview-item">
              <span className="ap-preview-title">{harnessLabel(item.h)} · <span className="ap-mono">{item.file}</span></span>
              {item.error ? <p className="ap-help">{item.error}</p> : <pre className="ap-code">{item.text}</pre>}
            </div>
          )) : <p className="ap-field-error" role="alert">至少选择一个端</p>}
        </aside>
      </div>
      <div className="ap-editor-footer">
        <Button variant="outline" disabled={busy} onClick={onClose}>取消</Button>
        <Button variant="primary" disabled={busy || !canSave} onClick={save}>
          {pendingKey === 'mcp.save' ? '保存中…' : `保存并写入${draft.harnesses.length ? ` ${draft.harnesses.length} 端` : ''}`}
        </Button>
      </div>
    </section>
  );
}

// 展开行：逐字段对比各端配置；环境变量只显示变量名，不在页面上显示值
const FIELDS = [
  ['传输方式', item => (item.spec.transport === 'http' ? 'HTTP' : 'Stdio')],
  ['命令', item => item.spec.command],
  ['参数', item => item.spec.args.join(' ')],
  ['地址', item => item.spec.url],
  ['环境变量', item => [...Object.keys(item.spec.env), ...item.spec.envRefs.map(k => `${k}（引用）`)].join('、'), item => JSON.stringify([item.spec.env, item.spec.envRefs])],
  // 其他字段只显示字段名，开关类的布尔值与数字照常显示；字符串等可能是密钥，不显示值
  ['其他字段', item => Object.entries(item.extras ?? {}).map(([k, v]) => (['boolean', 'number'].includes(typeof v) ? `${k}: ${v}` : k)).join('、')],
];

function McpDiff({ row, id }) {
  const present = HARNESS_IDS.filter(h => row.harnesses[h]);
  const rows = FIELDS.map(([name, show, compare = show]) => {
    const values = present.map(h => show(row.harnesses[h]) || '—');
    const differs = new Set(present.map(h => compare(row.harnesses[h]))).size > 1;
    return { name, values, differs };
  }).filter(item => item.values.some(v => v !== '—'));
  return (
    <div id={id} className="ap-row-detail ap-diff">
      <table>
        <thead><tr><th scope="col">字段</th>{present.map(h => <th key={h} scope="col">{harnessLabel(h)}</th>)}</tr></thead>
        <tbody>
          {rows.map(item => (
            <tr key={item.name} className={item.differs ? 'is-diff' : ''}>
              <th scope="row">{item.name}{item.differs && <span className="ap-sr-only">（各端不同）</span>}</th>
              {item.values.map((value, index) => (
                <td key={present[index]}>
                  <span className="ap-mono">
                    {value}{item.differs && item.name === '环境变量' && value !== '—' ? '（值不同）' : ''}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {present.length > 1 && <p className="ap-help">高亮的字段各端不同。开启新端时从 {harnessLabel(present[0])} 复制（第一个已有该 key 的端）。</p>}
    </div>
  );
}

export function McpView({ ctx, form, setForm }) {
  const { state, busy, pendingKey, search, filter, run, ask, confirmFor, expanded, toggleExpanded } = ctx;
  const needle = search.trim().toLowerCase();
  const rows = state.mcp.rows.filter(row => !needle || row.key.toLowerCase().includes(needle));
  const { attn, owned, settled, writable } = mcpGroups(state, rows);
  const writableSet = new Set(writable);
  const errors = Object.entries(state.mcp.errors ?? {});
  const show = id => filter === 'all' || filter === id;
  const settledOpen = Boolean(expanded['mcp:settled']) || Boolean(needle) || filter === 'settled';

  const toggle = (row, harness, on) => {
    const key = `mcp:${row.key}:${harness}`;
    const exec = () => run({ type: 'mcp.toggle', key: row.key, harness, on }, key);
    if (on) return void exec();
    ask(`mcp:${row.key}`, `将从 ${harnessLabel(harness)} 的 MCP 配置移除「${row.key}」，其他条目不受影响。`, '确认移除', exec);
  };

  const openEdit = row => {
    const present = HARNESS_IDS.filter(h => row.harnesses[h]);
    // 各端配置不同时默认只写回底稿所在的端，避免一次编辑抹平各端有意保留的差异
    setForm({
      editing: true,
      initial: draftFromSpec(row.key, row.harnesses[present[0]].spec, row.consistent ? present : [present[0]], { baseHarness: present[0], inconsistent: !row.consistent, row }),
    });
  };

  const renderRow = row => {
    if (form?.editing && form.initial.key === row.key) {
      return <McpForm key={`edit:${row.key}`} ctx={ctx} initial={form.initial} editing onClose={() => setForm(null)} />;
    }
    const open = Boolean(expanded[`mcp:${row.key}`]);
    const first = Object.values(row.harnesses)[0]?.spec;
    const ownedBy = row.providedBy?.length ? row.providedBy.join('、') : '';
    return (
      <article key={row.key} className="ap-matrix-row ap-pkg-card">
        <div className="ap-row-main">
          <div className="ap-pkg-title-row">
            <RowToggle open={open} title={row.key} controls={`ap-mcp-${row.key}`} mono onClick={() => toggleExpanded(`mcp:${row.key}`)} />
            {ownedBy && <span className="ap-badge ap-badge-kind" title="由插件注册与清理，不能在这里单独同步或编辑">插件 {ownedBy}</span>}
            {!row.consistent && <span className="ap-badge ap-badge-kind" title="各端的命令、参数或环境变量不同">各端配置不同</span>}
          </div>
          <RowMeta indent>{`${first?.transport === 'http' ? 'HTTP' : 'Stdio'} · ${specSummary(first)}`}</RowMeta>
        </div>
        <ToggleCells
          ariaLabel={`${row.key} 各端开关`}
          disabled={busy}
          cells={HARNESS_IDS.map(h => ({
            harnessId: h,
            on: Boolean(row.harnesses[h]),
            status: row.harnesses[h] ? 'installed' : 'unselected',
            label: `${harnessLabel(h)}：${row.harnesses[h] ? specSummary(row.harnesses[h].spec) : '没有'}`,
            disabledReason: ownedBy ? `由插件 ${ownedBy} 提供，请在「插件」视图把插件安装到其他端`
              : writableSet.has(h) ? '' : `${harnessLabel(h)} 没有可写入的 MCP 配置文件`,
            busy: pendingKey === `mcp:${row.key}:${h}`,
            onToggle: on => toggle(row, h, on),
          }))}
        />
        <div className="ap-pkg-actions">
          {!ownedBy && <IconButton icon="edit" label={`编辑 ${row.key}`} disabled={busy} onClick={() => openEdit(row)} />}
        </div>
        {confirmFor(`mcp:${row.key}`)}
        {open && <McpDiff row={row} id={`ap-mcp-${row.key}`} />}
      </article>
    );
  };

  const groups = [
    show('attn') && attn.length > 0 && { id: 'attn', title: '需处理', note: '只在部分端，或各端配置不同', rows: attn },
    show('owned') && owned.length > 0 && { id: 'owned', title: '由插件提供', note: '随插件写入；在「插件」视图把插件装到其他端', rows: owned },
    show('settled') && settled.length > 0 && { id: 'settled', title: `${writable.length} 端一致`, note: '可写入的各端配置相同', rows: settled, collapsible: !needle && filter !== 'settled' },
  ].filter(Boolean);

  return (
    <>
      {form && !form.editing && <McpForm key="new" ctx={ctx} initial={form.initial} onClose={() => setForm(null)} />}
      {errors.length > 0 && (
        <ul className="ap-mini-list ap-warning-list" aria-label="配置读取失败">
          {errors.map(([h, message]) => <li key={h}><span><span className="ap-badge ap-badge-err" style={{ marginRight: 8 }}>{harnessLabel(h)}</span>{message}</span></li>)}
        </ul>
      )}
      {groups.length ? (
        <div className="ap-list ap-matrix ap-matrix-act">
          {groups.map((group, index) => (
            <Fragment key={group.id}>
              <MatrixGroup title={group.title} count={group.rows.length} labels={index === 0}>
                <span className="ap-group-note">{group.note}</span>
                {group.collapsible && (
                  <button type="button" className="ap-link-btn" aria-expanded={settledOpen} onClick={() => toggleExpanded('mcp:settled')}>
                    {settledOpen ? '收起' : '展开'}
                  </button>
                )}
              </MatrixGroup>
              {(group.id !== 'settled' || settledOpen) && group.rows.map(renderRow)}
            </Fragment>
          ))}
        </div>
      ) : (
        <div className="ap-empty">
          <p>{needle || filter !== 'all' ? '没有符合条件的 MCP。' : '3 端的 MCP 配置里还没有 Server。手工添加一个，或在各端装好后刷新。'}</p>
        </div>
      )}
    </>
  );
}

export function newMcpForm(state) {
  return { editing: false, initial: draftFromSpec('', null, state.harnesses.filter(h => h.supportsMcp).map(h => h.id)) };
}
