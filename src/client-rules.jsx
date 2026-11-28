import { useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { composeSnippets } from './shared.mjs';
import { HARNESS_IDS, HARNESS_SHORT, IconButton, MatrixCells, MatrixGroup, RowMeta, RowToggle, ToggleCells, harnessLabel, isFailedStep } from './client-ui.jsx';

export function instructionStatusLabel(status) {
  switch (status) {
    case 'synced': return '已同步';
    case 'modified': return '外部修改';
    case 'missing': return '未创建';
    case 'symlink': return '待拆软链';
    case 'error': return '读取异常';
    default: return '不改动';
  }
}

const fileGlyph = status => (status === 'synced' ? 'installed' : status === 'error' ? 'failed' : status === 'empty' ? 'none' : 'not-installed');
// 读取失败时的处理建议：文件不在了（或是失效软链）就刷新，其余重试
const refreshFixes = message => /不存在|失效软链/.test(message);

export function RulesView({ ctx, drafts, setDrafts }) {
  const { state, busy, pendingKey, run, ask, confirmFor, expanded, toggleExpanded, request, refresh, log } = ctx;
  const [previewHarness, setPreviewHarness] = useState(HARNESS_IDS[0]);
  const [adoptError, setAdoptError] = useState(null);
  const instructions = state.instructions;
  const files = instructions.harnesses;
  const snippets = instructions.snippets;
  // 本次写入失败的端：来自本视图最近一次执行记录，下一次写入成功后消失
  const writeFailed = HARNESS_IDS.filter(h => (log?.steps ?? []).some(step => step.harness === h && isFailedStep(step)));

  // 保存片段列表：服务端只写拼接结果变化的端；会覆盖某端外部修改时先确认
  const save = (next, key, onSuccess, options) => {
    const exec = () => run({ type: 'rules.save', snippets: next }, key, onSuccess, options);
    const overwritten = HARNESS_IDS.filter(h => {
      const after = composeSnippets(next, h);
      return after && after !== composeSnippets(snippets, h) && files[h]?.status === 'modified';
    });
    if (!overwritten.length) return void exec();
    ask('rules-files', `${overwritten.map(h => `${files[h].label} 的 ${files[h].fileName}`).join('、')} 已被外部修改，本次保存会按片段重写并覆盖这些改动。`, '确认保存', exec);
  };
  const sync = harnesses => run({ type: 'rules.sync', harnesses }, 'rules.sync');

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

  // 片段已存储即清除草稿，即使某端写入失败（失败的端单独重试写入）
  const saveDraft = id => {
    const draft = drafts[id];
    const next = id === '__new__'
      ? [...snippets, { id: `snippet-${Date.now().toString(36)}`, title: draft.title, content: draft.content, harnesses: [] }]
      : snippets.map(item => (item.id === id ? { ...item, title: draft.title ?? item.title, content: draft.content ?? item.content } : item));
    save(next, `rule-save:${id}`, result => { if (result.saved !== false) dropDraft(id); }, { always: true });
  };

  // 纳管本机指令文件：全文导入为只对该端开启的片段，并在该端关闭其他片段，写入结果与现有文件一致
  const adopt = async harness => {
    setAdoptError(null);
    let res;
    try {
      res = await request({ type: 'rules.import', harness });
    } catch (cause) {
      setAdoptError({ harness, message: cause.message });
      return;
    }
    const next = [
      ...snippets.map(item => ({ ...item, harnesses: item.harnesses.filter(h => h !== harness) })),
      { id: `import-${harness}-${Date.now().toString(36)}`, title: `${files[harness].label} 现有 ${files[harness].fileName}`, content: res.content ?? '', harnesses: [harness] },
    ];
    setPreviewHarness(harness);
    run({ type: 'rules.save', snippets: next }, `adopt:rules:${harness}`);
  };
  const askAdopt = h => ask(
    `rule-adopt:${h}`,
    `将把 ${files[h].targetFile} 全文导入为只对 ${files[h].label} 开启的新片段，并在 ${files[h].label} 上关闭其他片段，文件内容保持不变。${files[h].isSymlink ? `该文件是指向 ${files[h].symlinkTarget} 的软链，写入时会拆分为独立文件，原链接目标不受影响。` : ''}`,
    '确认纳管',
    () => adopt(h),
  );

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
          <label htmlFor={`ap-rule-content-${id}`}>正文（Markdown）</label>
          <textarea id={`ap-rule-content-${id}`} className="ap-textarea ap-instr-editor" placeholder="Markdown 规则正文" value={content} onChange={e => setDraft(id, { title, content: e.target.value })} />
        </div>
        <div className="ap-actions ap-rule-editor-actions">
          <p className="ap-help">保存后写入开启这个片段、且没有外部修改的端。</p>
          <Button variant="outline" disabled={busy} onClick={() => dropDraft(id)}>取消</Button>
          <Button variant="primary" disabled={busy || !drafts[id] || !title.trim()} onClick={() => saveDraft(id)}>
            {pendingKey === `rule-save:${id}` ? '保存中…' : id === '__new__' ? '添加片段' : '保存片段'}
          </Button>
        </div>
      </div>
    );
  };

  const pending = HARNESS_IDS.filter(h => ['modified', 'missing', 'symlink'].includes(files[h].status));
  const adoptable = HARNESS_IDS.filter(h => files[h].exists && files[h].currentLength > 0 && ['empty', 'modified'].includes(files[h].status));
  const active = HARNESS_IDS.includes(previewHarness) ? previewHarness : HARNESS_IDS[0];
  const activeFile = files[active];
  const activeFailure = (log?.steps ?? []).find(step => step.harness === active && isFailedStep(step));
  // 预览跟随未保存的编辑：用草稿替换对应片段后在前端拼接（与服务端同一个 composeSnippets）
  const draftSnippets = snippets.map(item => (drafts[item.id] ? { ...item, title: drafts[item.id].title ?? item.title, content: drafts[item.id].content ?? item.content } : item));
  const previewContent = Object.keys(drafts).some(id => id !== '__new__') ? composeSnippets(draftSnippets, active) : activeFile.composedContent;
  const previewDirty = previewContent !== activeFile.composedContent;
  const previewLines = previewContent ? previewContent.trimEnd().split('\n').length : 0;

  return (
    <div className="ap-rules-layout">
      <div className="ap-list ap-matrix ap-matrix-act ap-rules-main">
        <MatrixGroup title="规则片段" count={snippets.length} labels>
          <span className="ap-group-note">按拼接顺序</span>
        </MatrixGroup>
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
                  {drafts[snippet.id] && <span className="ap-badge ap-badge-warn">未保存</span>}
                </div>
                <RowMeta indent>{`${lines} 行 · ${snippet.harnesses.length ? `写入 ${snippet.harnesses.map(h => HARNESS_SHORT[h]).join('、')}` : '未写入任何端'}`}</RowMeta>
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
                <IconButton icon="up" label={`上移 ${snippet.title}`} disabled={busy || index === 0} onClick={() => move(snippet, -1)} />
                <IconButton icon="down" label={`下移 ${snippet.title}`} disabled={busy || index === snippets.length - 1} onClick={() => move(snippet, 1)} />
                <IconButton icon="trash" label={`删除 ${snippet.title}`} className="is-danger" disabled={busy} onClick={() => remove(snippet)} />
              </div>
              {confirmFor(`rule:${snippet.id}`)}
              {open && <div className="ap-row-detail">{editor(snippet.id, snippet)}</div>}
            </article>
          );
        })}

        <MatrixGroup title="各端文件">
          <span className="ap-group-note">与片段拼接结果对比</span>
          {pending.length > 0 && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => ask('rules-files', `将按片段重写 ${pending.map(h => `${files[h].label} 的 ${files[h].fileName}`).join('、')}，覆盖其中的外部修改。`, '确认同步', () => sync(pending))}
            >
              {pendingKey === 'rules.sync' ? '同步中…' : `同步 ${pending.length} 端`}
            </Button>
          )}
          {writeFailed.length > 0 && (
            <Button variant="primary" disabled={busy} onClick={() => sync(writeFailed)}>
              {pendingKey === 'rules.sync' ? '重试中…' : `重试写入 ${writeFailed.map(h => HARNESS_SHORT[h]).join('、')}`}
            </Button>
          )}
        </MatrixGroup>
        <div className="ap-matrix-row ap-file-row">
          <div className="ap-row-main"><span className="ap-help">写入状态</span></div>
          <MatrixCells
            ariaLabel="各端文件状态"
            cells={HARNESS_IDS.map(h => {
              const failedNow = writeFailed.includes(h);
              return {
                harnessId: h,
                status: failedNow ? 'failed' : fileGlyph(files[h].status),
                caption: failedNow ? '写入失败' : instructionStatusLabel(files[h].status),
                label: `${files[h].label} ${files[h].fileName}：${failedNow ? '写入失败' : instructionStatusLabel(files[h].status)}${files[h].isSymlink ? '（软链，写入时拆分为独立文件）' : ''}`,
              };
            })}
          />
          <span />
          {confirmFor('rules-files')}
        </div>

        {adoptable.length > 0 && (
          <MatrixGroup title="本机文件未纳管" count={adoptable.length}>
            <span className="ap-group-note">纳管后文件内容变成片段，之后用开关和预览管理</span>
          </MatrixGroup>
        )}
        {adoptable.map(h => {
          const failure = adoptError?.harness === h ? adoptError : null;
          const fixByRefresh = failure && refreshFixes(failure.message);
          return (
            <div key={`rule-file:${h}`} className="ap-matrix-row ap-unmanaged-row">
              <div className="ap-row-main">
                <span className="ap-pkg-title">{files[h].label} · {files[h].fileName}</span>
                <RowMeta>{`${files[h].status === 'modified' ? '与片段拼接结果不一致' : '没有对应片段'} · ${files[h].targetFile}`}</RowMeta>
              </div>
              <MatrixCells
                ariaLabel={`${files[h].label} 指令文件`}
                cells={HARNESS_IDS.map(x => ({ harnessId: x, status: x === h ? 'unmanaged' : 'none', label: `${harnessLabel(x)}：${x === h ? '本机文件，未纳管' : '—'}` }))}
              />
              <div className="ap-pkg-actions">
                <Button variant="outline" disabled={busy || Boolean(failure)} onClick={() => askAdopt(h)}>
                  {pendingKey === `adopt:rules:${h}` ? '纳管中…' : '纳管'}
                </Button>
              </div>
              {confirmFor(`rule-adopt:${h}`)}
              {failure && (
                <div className="ap-row-error" role="alert">
                  <p>纳管失败：{failure.message}</p>
                  <p className="ap-help">
                    {fixByRefresh ? '文件可能刚被删除、移动或变成失效软链。没有改动任何片段，刷新后这一行会更新。' : '检查这个文件的读取权限后重试。没有改动任何片段。'}
                  </p>
                  <div className="ap-actions">
                    <Button variant="outline" onClick={() => setAdoptError(null)}>取消</Button>
                    <Button variant="primary" disabled={busy} onClick={() => (fixByRefresh ? (setAdoptError(null), void refresh()) : void adopt(h))}>
                      {fixByRefresh ? '刷新' : '重试'}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <aside className="ap-card ap-rule-preview" aria-label="最终写入预览">
        <div className="ap-preview-head">
          <h3>最终写入预览</h3>
          <span className="ap-help">{previewLines} 行</span>
        </div>
        <div className="ap-seg" role="group" aria-label="预览的端">
          {HARNESS_IDS.map(h => (
            <button
              key={h}
              type="button"
              className={`ap-seg-item ${active === h ? 'is-on' : ''}`.trim()}
              aria-pressed={active === h}
              title={`${files[h].label}：${instructionStatusLabel(files[h].status)}`}
              onClick={() => setPreviewHarness(h)}
            >
              {HARNESS_SHORT[h]}
              {(pending.includes(h) || writeFailed.includes(h)) && <span className="ap-seg-dot" aria-hidden="true" />}
            </button>
          ))}
        </div>
        <code className="ap-instr-path" title="目标文件">
          {activeFile.targetFile}{activeFile.isSymlink ? `（当前是指向 ${activeFile.symlinkTarget} 的软链，写入时拆分为独立文件）` : ''}
        </code>
        {activeFailure && (
          <div className="ap-warnbox is-bad" role="alert">
            <p>{activeFailure.detail}。片段已保存，文件保持原样。</p>
            <Button variant="primary" disabled={busy} onClick={() => sync([active])}>重试写入 {activeFile.label}</Button>
          </div>
        )}
        {!activeFailure && activeFile.status === 'modified' && (
          <div className="ap-warnbox" role="status">
            <p>{activeFile.fileName} 与片段拼接结果不一致（可能被外部修改），开关与保存不会改动它。</p>
            <div className="ap-actions">
              {adoptable.includes(active) && <Button variant="outline" disabled={busy} onClick={() => askAdopt(active)}>纳管为片段</Button>}
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => ask('rules-files', `将按片段重写 ${activeFile.label} 的 ${activeFile.fileName}，覆盖其中的外部修改。`, '确认同步', () => sync([active]))}
              >
                同步覆盖
              </Button>
            </div>
          </div>
        )}
        {previewDirty && <p className="ap-draft-note">预览包含未保存的编辑</p>}
        {previewContent
          ? <pre className="ap-instr-preview">{previewContent}</pre>
          : <p className="ap-help">该端没有开启的片段，同步时跳过写入，不会清空现有文件。</p>}
      </aside>
    </div>
  );
}
