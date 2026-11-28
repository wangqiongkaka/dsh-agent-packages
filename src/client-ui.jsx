import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { HARNESS_IDS, HARNESS_META } from './shared.mjs';

export function stepBadgeClass(status) {
  if (status === 'ok') return 'ap-badge ap-badge-ok';
  if (status === 'error') return 'ap-badge ap-badge-err';
  if (status === 'preview') return 'ap-badge ap-badge-kind';
  return 'ap-badge';
}

// 窄面板表头用短名；完整端名放在每格的 aria-label / title 里
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
  if (status === 'installed') return 'ok';
  if (status === 'failed') return 'fail';
  if (status === 'busy') return 'busy';
  if (status === 'not-installed') return 'warn';
  if (status === 'unmanaged') return 'file';
  if (status === 'unselected') return 'add';
  return 'none';
}

// 形状 + 颜色双重编码：✓=已有，+=可开启，✕=损坏/失败，◇=待同步，旋转圈=执行中，文档=未纳管文件，短横=无
export function Glyph({ status }) {
  const kind = glyphKind(status);
  return (
    <svg className={`ap-glyph ap-glyph-${kind}`} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      {kind === 'ok' && <path d="M3.5 8.5l3 3 6-7" strokeWidth="2" />}
      {kind === 'fail' && <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" strokeWidth="2" />}
      {kind === 'busy' && <circle cx="8" cy="8" r="5" strokeWidth="2" strokeDasharray="22 10" />}
      {kind === 'warn' && <path d="M8 3l5 5-5 5-5-5z" strokeWidth="1.6" />}
      {kind === 'file' && <path d="M4 2.5h5l3 3v8H4zM9 2.5v3h3" strokeWidth="1.4" />}
      {kind === 'add' && <path d="M8 4.5v7M4.5 8h7" strokeWidth="1.6" />}
      {kind === 'none' && <path d="M5 8h6" strokeWidth="1.6" />}
    </svg>
  );
}

// 分组标题行与数据行共用三列网格；第一个分组带端名表头，与标题同一行对齐（宽面板显示全称，窄面板显示简称）
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
            <span key={h} className="ap-cell" title={HARNESS_META[h].label}>
              <span className="ap-col-full">{HARNESS_META[h].label}</span>
              <span className="ap-col-short">{HARNESS_SHORT[h]}</span>
            </span>
          ))}
        </div>
      ) : <span />}
      <span />
    </div>
  );
}

// 只读状态格：cells 为 [{ harnessId, status, label, caption? }]，caption 显示在图形下方
export function MatrixCells({ cells, ariaLabel }) {
  return (
    <div className="ap-cells" role="group" aria-label={ariaLabel}>
      {cells.map(cell => (
        <span
          key={cell.harnessId}
          role="img"
          className={`ap-cell ap-cell-static is-${glyphKind(cell.status)}`}
          aria-label={cell.label}
          title={cell.label}
        >
          <Glyph status={cell.status} />
          {cell.caption && <span className="ap-cell-caption">{cell.caption}</span>}
          <span className="ap-cell-label" aria-hidden="true">{HARNESS_SHORT[cell.harnessId]}</span>
        </span>
      ))}
    </div>
  );
}

// 可点的端开关：cells 为 [{ harnessId, status, on, label, disabledReason, busy, onToggle, inert }]
// inert：这一端只是没有该条目、也不能在这里开启（如 MCP 不做同步），画成普通短横而不是「不可用」斜纹
export function ToggleCells({ cells, ariaLabel, disabled }) {
  return (
    <div className="ap-cells" role="group" aria-label={ariaLabel}>
      {cells.map(cell => {
        if (cell.inert) {
          return (
            <span key={cell.harnessId} role="img" className="ap-cell ap-cell-static is-none" aria-label={cell.label} title={cell.label}>
              <Glyph status="none" />
              <span className="ap-cell-label" aria-hidden="true">{HARNESS_SHORT[cell.harnessId]}</span>
            </span>
          );
        }
        const blocked = Boolean(cell.disabledReason);
        const hint = blocked ? `不可用：${cell.disabledReason}` : cell.hint || (cell.on ? '点击关闭' : '点击开启');
        const glyph = cell.busy ? 'busy' : cell.on ? (cell.status === 'failed' ? 'failed' : 'installed') : blocked ? 'none' : 'unselected';
        return (
          <button
            key={cell.harnessId}
            type="button"
            role="switch"
            aria-checked={cell.on}
            aria-label={`${cell.label}，${hint}`}
            title={`${cell.label} · ${hint}`}
            disabled={disabled || blocked}
            className={`ap-cell ap-switch ${cell.on ? 'is-on' : ''} ${cell.status === 'failed' ? 'is-broken' : ''} ${blocked ? 'is-blocked' : ''} ${cell.busy ? 'is-busy' : ''}`.replace(/\s+/g, ' ').trim()}
            onClick={() => cell.onToggle(!cell.on)}
          >
            <Glyph status={glyph} />
            <span className="ap-cell-label" aria-hidden="true">{HARNESS_SHORT[cell.harnessId]}</span>
          </button>
        );
      })}
    </div>
  );
}

const ICONS = {
  edit: 'M10.5 3l2.5 2.5L6 12.5H3.5V10z',
  up: 'M8 13V3M4 7l4-4 4 4',
  down: 'M8 3v10M4 9l4 4 4-4',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5',
  close: 'M4 4l8 8M12 4l-8 8',
  copy: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7',
};

// 行末次要动作：图标按钮，名称写在 aria-label 与 title 里
export function IconButton({ icon, label, className = '', ...props }) {
  return (
    <button type="button" className={`ap-icon-btn ${className}`.trim()} aria-label={label} title={label} {...props}>
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={ICONS[icon]} /></svg>
    </button>
  );
}

// 分组筛选：options 为 [{ id, label, count }]
export function FilterChips({ options, value, onChange }) {
  return (
    <div className="ap-chips" role="group" aria-label="筛选">
      {options.map(option => (
        <button key={option.id} type="button" className="ap-chip" aria-pressed={value === option.id} onClick={() => onChange(option.id)}>
          {option.label}<span className="ap-chip-count">{option.count}</span>
        </button>
      ))}
    </div>
  );
}

export const isFailedStep = step => step.status === 'error' || step.status === 'failed';

export function LogPanel({ log, onClear }) {
  const failed = log.steps.filter(isFailedStep).length;
  // 失败的步骤排在最前，展开即见
  const steps = [...log.steps].sort((a, b) => isFailedStep(b) - isFailedStep(a));
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
        {steps.map((step, index) => (
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

// 名称下方的一行说明（来源、版本、路径等），保持一行，过长截断
export function RowMeta({ children, indent = false }) {
  return children ? <p className={`ap-row-meta ${indent ? 'is-indent' : ''}`.trim()} title={typeof children === 'string' ? children : undefined}>{children}</p> : null;
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
