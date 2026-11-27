import { useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { composeSnippets } from './shared.mjs';
import { HARNESS_IDS, MatrixCells, MatrixGroup, RowToggle, Select, ToggleCells, harnessLabel } from './client-ui.jsx';

export function instructionStatusLabel(status) {
  switch (status) {
    case 'synced': return '已同步';
    case 'modified': return '待同步';
    case 'missing': return '未创建';
    case 'symlink': return '待拆软链';
    case 'error': return '读取异常';
    default: return '没有片段';
  }
}

const fileGlyph = status => (status === 'synced' ? 'installed' : status === 'error' ? 'failed' : status === 'empty' ? 'unselected' : 'not-installed');

export function RulesView({ ctx, drafts, setDrafts }) {
  const { state, busy, pendingKey, run, ask, confirmFor, expanded, toggleExpanded, request } = ctx;
  const [previewHarness, setPreviewHarness] = useState(HARNESS_IDS[0]);
  const instructions = state.instructions;
  const files = instructions.harnesses;
  const snippets = instructions.snippets;

  // 保存片段列表：服务端只写拼接结果变化的端；会覆盖某端外部修改时先确认
  const save = (next, key, onSuccess) => {
    const exec = () => run({ type: 'rules.save', snippets: next }, key, onSuccess);
    const overwritten = HARNESS_IDS.filter(h => {
      const after = composeSnippets(next, h);
      return after && after !== composeSnippets(snippets, h) && files[h]?.status === 'modified';
    });
    if (!overwritten.length) return void exec();
    ask('rules-files', `${overwritten.map(h => `${files[h].label} 的 ${files[h].fileName}`).join('、')} 已被外部修改，本次保存会按片段重写并覆盖这些改动。`, '确认保存', exec);
  };

  const setDraft = (id, patch) => setDrafts(prev => ({ ...prev, [id]: { ...(prev[id] ?? {}), ...patch } }));
  const dropDraft = id => setDrafts(prev => {
    const next = { ...prev };
    delete next[id];
    return next;
  });

  const toggleSnippet = (snippet, harness, on) => {
    const next = snippets.map(item => (item.id === snippet.id
      ? { ...item, harnesses: on ? [...item.harnesses, harness] : item.harnesses.filter(h => h !== harness) }
      : item));
    if (on) return save(next, `rule:${snippet.id}:${harness}`);
    ask(`rule:${snippet.id}`, `将从 ${files[harness].label} 的 ${files[harness].fileName} 移除片段「${snippet.title}」并立即写入；该端没有其他开启的片段时文件保持原样。`, '确认移除', () => save(next, `rule:${snippet.id}:${harness}`));
  };

  const move = (snippet, offset) => {
    const index = snippets.findIndex(item => item.id === snippet.id);
    const target = index + offset;
    if (target < 0 || target >= snippets.length) return;
    const next = [...snippets];
    [next[index], next[target]] = [next[target], next[index]];
    save(next, `rule-move:${snippet.id}`);
  };

  const remove = snippet => ask(
    `rule:${snippet.id}`,
    `将删除片段「${snippet.title}」，并重写开启了它的端（${snippet.harnesses.map(harnessLabel).join('、') || '无'}）。`,
    '确认删除',
    () => save(snippets.filter(item => item.id !== snippet.id), `rule-delete:${snippet.id}`),
  );

  const saveDraft = id => {
    const draft = drafts[id];
    const next = id === '__new__'
      ? [...snippets, { id: `snippet-${Date.now().toString(36)}`, title: draft.title, content: draft.content, harnesses: [] }]
      : snippets.map(item => (item.id === id ? { ...item, title: draft.title ?? item.title, content: draft.content ?? item.content } : item));
    save(next, `rule-save:${id}`, () => dropDraft(id));
  };

  // 纳管本机指令文件：全文导入为只对该端开启的片段，并在该端关闭其他片段，写入结果与现有文件一致
  const adopt = async harness => {
    let res;
    try {
      res = await request({ type: 'rules.import', harness });
    } catch (cause) {
      ctx.fail(cause.message);
      return;
    }
    const next = [
      ...snippets.map(item => ({ ...item, harnesses: item.harnesses.filter(h => h !== harness) })),
      { id: `import-${harness}-${Date.now().toString(36)}`, title: `${files[harness].label} 现有 ${files[harness].fileName}`, content: res.content ?? '', harnesses: [harness] },
    ];
    run({ type: 'rules.save', snippets: next }, `adopt:rules:${harness}`);
  };

  const editor = (id, snippet) => {
    const draft = drafts[id] ?? {};
    const title = draft.title ?? snippet?.title ?? '';
    const content = draft.content ?? snippet?.content ?? '';
    return (
      <div className="ap-rule-editor">
        <div className="ap-field">
          <label htmlFor={`ap-rule-title-${id}`}>标题</label>
          <input id={`ap-rule-title-${id}`} className="ap-input" placeholder="如「全局协作规则」" value={title} onChange={e => setDraft(id, { title: e.target.value, content })} />
        </div>
        <div className="ap-field">
          <label htmlFor={`ap-rule-content-${id}`}>正文</label>
          <textarea id={`ap-rule-content-${id}`} className="ap-textarea ap-instr-editor" placeholder="Markdown 规则正文" value={content} onChange={e => setDraft(id, { title, content: e.target.value })} />
        </div>
        <div className="ap-actions ap-rule-editor-actions">
          <Button variant="outline" disabled={busy} onClick={() => dropDraft(id)}>取消</Button>
          <Button variant="outline" disabled={busy || !drafts[id] || !title.trim()} onClick={() => saveDraft(id)}>
            {pendingKey === `rule-save:${id}` ? '保存中…' : id === '__new__' ? '添加片段' : '保存片段'}
          </Button>
        </div>
      </div>
    );
  };

  const pending = HARNESS_IDS.filter(h => ['modified', 'missing', 'symlink'].includes(files[h].status));
  const adoptable = HARNESS_IDS.filter(h => files[h].exists && files[h].currentLength > 0 && ['empty', 'modified'].includes(files[h].status));
  const active = HARNESS_IDS.includes(previewHarness) ? previewHarness : HARNESS_IDS[0];

  return (
    <>
      <div className="ap-list ap-matrix">
        <MatrixGroup title="规则片段" count={snippets.length} labels />
        {drafts.__new__ && <div className="ap-matrix-row ap-rule-new">{editor('__new__', null)}</div>}
        {!snippets.length && !drafts.__new__ && <p className="ap-matrix-empty">还没有规则片段。新建一个，或把本机现有的指令文件纳管为片段。</p>}
        {snippets.map((snippet, index) => {
          const open = Boolean(expanded[`rule:${snippet.id}`]) || Boolean(drafts[snippet.id]);
          const lines = snippet.content.trim() ? snippet.content.trimEnd().split('\n').length : 0;
          return (
            <article key={snippet.id} className="ap-matrix-row ap-pkg-card ap-rule-row">
              <div className="ap-row-main">
                <div className="ap-pkg-title-row">
                  <RowToggle open={open} title={snippet.title} onClick={() => toggleExpanded(`rule:${snippet.id}`)} />
                  <span className="ap-badge">{lines} 行</span>
                  {drafts[snippet.id] && <span className="ap-badge ap-badge-update">未保存</span>}
                </div>
              </div>
              <ToggleCells
                ariaLabel={`${snippet.title} 写入的端`}
                disabled={busy}
                cells={HARNESS_IDS.map(h => ({
                  harnessId: h,
                  on: snippet.harnesses.includes(h),
                  status: snippet.harnesses.includes(h) ? 'installed' : 'unselected',
                  label: `${harnessLabel(h)}：${snippet.harnesses.includes(h) ? '写入' : '不写入'}`,
                  disabledReason: '',
                  busy: pendingKey === `rule:${snippet.id}:${h}`,
                  onToggle: on => toggleSnippet(snippet, h, on),
                }))}
              />
              <div className="ap-pkg-actions ap-rule-actions">
                <Button variant="outline" disabled={busy || index === 0} aria-label={`上移 ${snippet.title}`} onClick={() => move(snippet, -1)}>↑</Button>
                <Button variant="outline" disabled={busy || index === snippets.length - 1} aria-label={`下移 ${snippet.title}`} onClick={() => move(snippet, 1)}>↓</Button>
                <Button variant="outline" disabled={busy} aria-label={`删除 ${snippet.title}`} onClick={() => remove(snippet)}>删除</Button>
              </div>
              {confirmFor(`rule:${snippet.id}`)}
              {open && <div className="ap-row-detail">{editor(snippet.id, snippet)}</div>}
            </article>
          );
        })}

        <MatrixGroup title="各端文件">
          {pending.length > 0 && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => ask('rules-files', `将按片段重写 ${pending.map(h => `${files[h].label} 的 ${files[h].fileName}`).join('、')}，覆盖其中的外部修改。`, '确认同步', () => run({ type: 'rules.sync', harnesses: pending }, 'rules.sync'))}
            >
              {pendingKey === 'rules.sync' ? '同步中…' : `同步（${pending.length}）`}
            </Button>
          )}
        </MatrixGroup>
        <div className="ap-matrix-row">
          <div className="ap-row-main"><span>写入状态</span></div>
          <MatrixCells
            ariaLabel="各端文件状态"
            cells={HARNESS_IDS.map(h => ({
              harnessId: h,
              status: fileGlyph(files[h].status),
              label: `${files[h].label} ${files[h].fileName}：${instructionStatusLabel(files[h].status)}${files[h].isSymlink ? '（软链，写入时拆分为独立文件）' : ''}`,
            }))}
          />
          <span />
          {confirmFor('rules-files')}
        </div>

        {adoptable.length > 0 && <MatrixGroup title="本机文件未纳管" count={adoptable.length} />}
        {adoptable.map(h => (
          <div key={`rule-file:${h}`} className="ap-matrix-row ap-unmanaged-row">
            <div className="ap-row-main">
              <span className="ap-skill-name">{files[h].label} · {files[h].fileName}</span>
              <span className="ap-help ap-unmanaged-note">{files[h].status === 'modified' ? '与片段拼接结果不一致' : '没有对应片段'}</span>
            </div>
            <MatrixCells
              ariaLabel={`${files[h].label} 指令文件`}
              cells={HARNESS_IDS.map(x => ({ harnessId: x, status: x === h ? 'unmanaged' : 'none', label: `${harnessLabel(x)}：${x === h ? '本机文件' : '—'}` }))}
            />
            <div className="ap-pkg-actions">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => ask(
                  `rule-adopt:${h}`,
                  `将把 ${files[h].targetFile} 全文导入为只对 ${files[h].label} 开启的新片段，并在 ${files[h].label} 上关闭其他片段，文件内容保持不变。${files[h].isSymlink ? `该文件是指向 ${files[h].symlinkTarget} 的软链，写入时会拆分为独立文件，原链接目标不受影响。` : ''}`,
                  '确认纳管',
                  () => adopt(h),
                )}
              >
                {pendingKey === `adopt:rules:${h}` ? '纳管中…' : '纳管'}
              </Button>
            </div>
            {confirmFor(`rule-adopt:${h}`)}
          </div>
        ))}
      </div>

      <details className="ap-section ap-advanced ap-rule-preview">
        <summary>
          最终写入预览
          <span className="ap-help">{files[active].label} · {files[active].fileName}</span>
        </summary>
        <div className="ap-rule-preview-head">
          <Select
            id="ap-rule-preview-harness"
            ariaLabel="预览的端"
            className="ap-instr-harness-select"
            value={active}
            options={HARNESS_IDS.map(h => ({ value: h, label: files[h].label, meta: instructionStatusLabel(files[h].status) }))}
            onChange={setPreviewHarness}
          />
          <code className="ap-instr-path" title="目标文件">{files[active].targetFile}</code>
        </div>
        {files[active].composedContent
          ? <pre className="ap-instr-preview">{files[active].composedContent}</pre>
          : <p className="ap-help">该端没有开启的片段，同步时跳过写入，不会清空现有文件。</p>}
      </details>
    </>
  );
}
