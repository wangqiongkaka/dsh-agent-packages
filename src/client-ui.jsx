import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { HARNESS_IDS, HARNESS_META } from './shared.mjs';

export function stepBadgeClass(status) {
  if (status === 'ok') return 'ap-badge ap-badge-ok';
  if (status === 'error') return 'ap-badge ap-badge-err';
  if (status === 'preview') return 'ap-badge ap-badge-kind';
  return 'ap-badge';
}

// 对齐状态列的表头只有约 44px 宽，用短名；完整端名放在每格的 aria-label / title 里
export const HARNESS_SHORT = { codex: 'Codex', 'claude-code': 'Claude', antigravity: 'Agy', dsh: 'DSH' };

const STEP_STATUS_LABELS = {
  ok: '成功',
  error: '失败',
  failed: '失败',
  preview: '预览',
  skipped: '跳过',
  installed: '已安装',
  uninstalled: '已卸载',
};

function glyphKind(status) {
  if (status === 'installed' || status === 'managed') return 'ok';
  if (status === 'failed') return 'fail';
  if (status === 'not-installed') return 'pending';
  if (status === 'unmanaged') return 'present';
  if (status === 'uninstalled') return 'idle';
  return 'none';
}

// 形状 + 颜色双重编码：实心点=已装（诊断里中性色实心点=未纳管），空心环=待装/已卸载，✕=失败，短横=未启用
export function Glyph({ status }) {
  const kind = glyphKind(status);
  return (
    <svg className={`ap-glyph ap-glyph-${kind}`} viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      {(kind === 'ok' || kind === 'present') && <circle cx="6" cy="6" r="4.5" fill="currentColor" />}
      {(kind === 'pending' || kind === 'idle') && <circle cx="6" cy="6" r="3.75" fill="none" stroke="currentColor" strokeWidth="1.6" />}
      {kind === 'fail' && <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
      {kind === 'none' && <path d="M3.5 6h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
    </svg>
  );
}

// 分组标题行与数据行共用三列网格；第一个分组带端名表头，与标题同一行对齐
export function MatrixGroup({ title, count, labels = false, children }) {
  return (
    <div className="ap-matrix-group">
      <div className="ap-group-title">
        <h3>{title}{count != null && <span className="ap-group-count">{count}</span>}</h3>
        {children}
      </div>
      {labels ? (
        <div className="ap-cells ap-col-head" aria-hidden="true">
          {HARNESS_IDS.map(h => (
            <span key={h} className="ap-cell" title={HARNESS_META[h].label}>{HARNESS_SHORT[h]}</span>
          ))}
        </div>
      ) : <span />}
      <span />
    </div>
  );
}

// cells: [{ harnessId, status, label, text? }]，text 用于展示数量等非状态值
export function MatrixCells({ cells, ariaLabel }) {
  return (
    <div className="ap-cells" role="group" aria-label={ariaLabel}>
      {cells.map(cell => (
        <span
          key={cell.harnessId}
          role="img"
          className={`ap-cell ${cell.muted ? 'is-muted' : ''}`.trim()}
          aria-label={cell.label}
          title={cell.label}
        >
          {cell.text != null ? <span className="ap-cell-num">{cell.text}</span> : <Glyph status={cell.status} />}
          <span className="ap-cell-label" aria-hidden="true">{HARNESS_SHORT[cell.harnessId]}</span>
        </span>
      ))}
    </div>
  );
}

// 可点的端开关：cells 为 [{ harnessId, status, on, text?, label, disabledReason, busy, onToggle }]
export function ToggleCells({ cells, ariaLabel, disabled }) {
  return (
    <div className="ap-cells" role="group" aria-label={ariaLabel}>
      {cells.map(cell => {
        const blocked = Boolean(cell.disabledReason);
        const hint = blocked ? `不可用：${cell.disabledReason}` : cell.hint || (cell.on ? '点击关闭' : '点击开启');
        return (
          <button
            key={cell.harnessId}
            type="button"
            role="switch"
            aria-checked={cell.on}
            aria-label={`${cell.label}，${hint}`}
            title={`${cell.label} · ${hint}`}
            disabled={disabled || blocked}
            className={`ap-cell ap-switch ${cell.on ? 'is-on' : ''} ${blocked ? 'is-blocked' : ''} ${cell.busy ? 'is-busy' : ''}`.trim()}
            onClick={() => cell.onToggle(!cell.on)}
          >
            {cell.text != null
              ? <span className="ap-cell-num">{cell.text}</span>
              : <Glyph status={cell.busy ? 'not-installed' : cell.status} />}
            <span className="ap-cell-label" aria-hidden="true">{HARNESS_SHORT[cell.harnessId]}</span>
          </button>
        );
      })}
    </div>
  );
}

export function LogPanel({ log, onClear }) {
  const failed = log.steps.filter(step => step.status === 'error' || step.status === 'failed').length;
  const summary = failed
    ? `${failed} 步失败`
    : log.preview ? '仅预览，未写入' : '全部完成';
  return (
    // 失败或主动预览时默认展开：这两种情况用户需要读具体内容
    <details key={log.id} className="ap-logs ap-advanced" open={failed > 0 || log.preview}>
      <summary>
        执行记录
        <span className={failed ? 'ap-logs-sum is-error' : 'ap-help'}>{log.steps.length} 步 · {summary}</span>
      </summary>
      <div className="ap-log-list">
        {log.steps.map((step, index) => (
          <div key={index} className="ap-log-item">
            <div className="ap-log-top">
              <span className={stepBadgeClass(step.status)}>{STEP_STATUS_LABELS[step.status] || step.status}</span>
              {step.packageName && <strong>{step.packageName}</strong>}
              <span className="ap-badge">
                {step.harness === 'shared'
                  ? '全局 CLI'
                  : step.harness === 'repo'
                    ? '仓库'
                    : step.harness === 'instructions'
                      ? '全局指令'
                      : (HARNESS_META[step.harness]?.label || step.harness)}
              </span>
              <span>{step.detail}</span>
            </div>
            {step.command && <pre className="ap-log-out">$ {step.command}</pre>}
            {step.output && <pre className="ap-log-out">{step.output}</pre>}
            {step.warnings?.length > 0 && (
              <p className="ap-help" style={{ color: 'var(--ap-warn)' }}>
                提示：{step.warnings.join('；')}
              </p>
            )}
          </div>
        ))}
      </div>
      <div className="ap-logs-foot">
        <Button variant="outline" onClick={onClear}>清空记录</Button>
      </div>
    </details>
  );
}

// 需要处理的包给出一句原因与一个修复动作；返回 null 表示已就绪

export function Select({
  id,
  value,
  options,
  onChange,
  ariaLabel,
  className = '',
  menuAlign = 'left',
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const listId = useId();

  const selectedIndex = Math.max(0, options.findIndex(opt => opt.value === value));
  const selectedOption = options[selectedIndex] || options[0] || null;

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = event => {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function openMenu() {
    if (disabled || !options.length) return;
    setActiveIndex(selectedIndex);
    setOpen(true);
  }

  function commit(index) {
    const opt = options[index];
    if (!opt) return;
    if (opt.value !== value) onChange(opt.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function handleTriggerKeyDown(event) {
    if (disabled || !options.length) return;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex(i => (i + 1) % options.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(i => (i - 1 + options.length) % options.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(options.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      commit(activeIndex >= 0 ? activeIndex : selectedIndex);
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  }

  return (
    <div
      ref={wrapRef}
      className={`ap-select-wrap ${open ? 'is-open' : ''} ${className}`.trim()}
    >
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined}
        className="ap-select-trigger"
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="ap-select-value">{selectedOption?.label ?? ''}</span>
        <svg className="ap-select-chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M4.25 6.25L8 10l3.75-3.75"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.65"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className={`ap-select-menu ${menuAlign === 'right' ? 'ap-select-menu-right' : ''}`.trim()}
        >
          {options.map((opt, idx) => {
            const selected = opt.value === value;
            const active = idx === activeIndex;
            return (
              <button
                key={opt.value}
                id={`${listId}-opt-${idx}`}
                type="button"
                role="option"
                aria-selected={selected}
                className={`ap-select-option ${active ? 'is-active' : ''}`.trim()}
                onMouseEnter={() => setActiveIndex(idx)}
                onMouseDown={e => e.preventDefault()}
                onClick={() => commit(idx)}
              >
                <span className="ap-select-option-label">{opt.label}</span>
                <span className="ap-select-option-tail">
                  {opt.meta && <span className="ap-select-option-meta">{opt.meta}</span>}
                  <span className="ap-select-check-slot" aria-hidden="true">
                    {selected && (
                      <svg className="ap-select-check" viewBox="0 0 16 16" width="14" height="14">
                        <path
                          d="M3.5 8.5L6.5 11.5L12.5 4.75"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.75"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}


// 行内确认条：破坏性操作先写明后果，确认后才执行
export function ConfirmBar({ confirm, busy, onCancel, onConfirm }) {
  return (
    <div className="ap-confirm" role="group" aria-label={confirm.button}>
      <p>{confirm.text}</p>
      <div className="ap-actions">
        <Button variant="outline" disabled={busy} autoFocus onClick={onCancel}>取消</Button>
        <Button
          variant="outline"
          style={{ color: 'var(--ap-error)', borderColor: 'color-mix(in srgb, var(--ap-error) 55%, transparent)' }}
          disabled={busy}
          onClick={onConfirm}
        >
          {confirm.button}
        </Button>
      </div>
    </div>
  );
}

export function RowToggle({ open, onClick, title, controls, mono = false }) {
  return (
    <button type="button" className="ap-row-toggle" aria-expanded={open} aria-controls={controls} onClick={onClick}>
      <svg className="ap-row-chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className={mono ? 'ap-pkg-title ap-mono-title' : 'ap-pkg-title'} title={title}>{title}</span>
    </button>
  );
}

export const harnessLabel = id => HARNESS_META[id]?.label ?? id;
export { HARNESS_IDS };
