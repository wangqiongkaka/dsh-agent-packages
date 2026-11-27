import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  ANALYZER_HARNESS_IDS,
  CARD_KIND_LABELS,
  ENDPOINT,
  HARNESS_IDS,
  HARNESS_META,
  HEADER_KEY,
  KIND_LABELS,
  PLUGIN_ID,
  composeSnippets,
  formatHarnessVersion,
  formatVersion,
  summarizePackageVersions,
  unsupportedReason,
} from './shared.mjs';
import styles from './client.css';

export const name = `${PLUGIN_ID}-client`;
export const inject = ['slots', 'locale'];

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(PLUGIN_ID, {
    'zh-CN': { title: 'Skills & MCP' },
    'en-US': { title: 'Skills & MCP' },
  }));
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: PLUGIN_ID,
    order: 28,
    label: () => 'Skills & MCP',
    locale: PLUGIN_ID,
  }, PackagesPage)));
}

async function apiRequest(input, key) {
  let response;
  try {
    response = await fetch(
      ENDPOINT,
      input
        ? {
            method: 'POST',
            cache: 'no-store',
            headers: { 'content-type': 'application/json', [HEADER_KEY]: key },
            body: JSON.stringify(input),
          }
        : { cache: 'no-store' }
    );
  } catch {
    throw new Error('无法连接插件后台，请确认 DSH 正在运行后重试');
  }
  let data;
  try { data = await response.json(); }
  catch { throw new Error('插件后台尚未就绪，请稍后重试'); }
  if (!response.ok) {
    const error = new Error(data.error ?? `请求失败（HTTP ${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function emptyDraft() {
  return {
    id: '',
    name: '',
    kind: 'skills-repo',
    repo: '',
    description: '',
    ref: '',
    version: '',
    npmPackage: '',
    targets: ['codex', 'claude-code', 'antigravity', 'dsh'],
    skills: { includeText: '', mode: 'symlink' },
    mcp: {
      serverName: '',
      transport: 'stdio',
      command: 'npx',
      argsText: '',
      url: '',
      envRows: [{ key: '', value: '' }],
    },
    plugin: { name: '', marketplace: '', harnesses: [] },
    commands: {},
  };
}

function packageToDraft(pkg) {
  const envRows = [];
  if (pkg.mcp?.env && typeof pkg.mcp.env === 'object') {
    for (const [key, value] of Object.entries(pkg.mcp.env)) {
      if (key.trim() && typeof value === 'string') {
        envRows.push({ key: key.trim(), value });
      }
    }
  }
  if (Array.isArray(pkg.mcp?.envRefs)) {
    const seen = new Set(envRows.map(row => row.key));
    for (const name of pkg.mcp.envRefs) {
      const key = String(name).trim();
      if (key && !seen.has(key)) {
        seen.add(key);
        envRows.push({ key, value: '' });
      }
    }
  }
  if (!envRows.length) envRows.push({ key: '', value: '' });

  return {
    id: pkg.id || '',
    name: pkg.name || '',
    kind: pkg.kind || 'skills-repo',
    repo: pkg.repo || '',
    description: pkg.description || '',
    ref: pkg.ref || '',
    version: pkg.version || '',
    npmPackage: pkg.npmPackage || '',
    targets: Array.isArray(pkg.targets) ? [...pkg.targets] : ['codex', 'claude-code', 'antigravity'],
    skills: {
      includeText: Array.isArray(pkg.skills?.include) ? pkg.skills.include.join(', ') : '',
      mode: pkg.skills?.mode === 'copy' ? 'copy' : 'symlink',
    },
    mcp: {
      serverName: pkg.mcp?.serverName || pkg.id || '',
      transport: pkg.mcp?.transport === 'http' ? 'http' : 'stdio',
      command: pkg.mcp?.command || '',
      argsText: Array.isArray(pkg.mcp?.args) ? pkg.mcp.args.join(' ') : '',
      url: pkg.mcp?.url || '',
      envRows,
    },
    plugin: { name: pkg.plugin?.name || '', marketplace: pkg.plugin?.marketplace || '', harnesses: pkg.plugin?.harnesses || [] },
    commands: pkg.commands ? JSON.parse(JSON.stringify(pkg.commands)) : {},
  };
}

function draftToPackage(draft) {
  const include = draft.skills.includeText
    .split(/[,，\n]/)
    .map(item => item.trim())
    .filter(Boolean);
  const args = draft.mcp.argsText
    .split(/\s+/)
    .map(item => item.trim())
    .filter(Boolean);
  const env = {};
  const envRefs = [];
  const seenEnvKeys = new Set();
  for (const row of draft.mcp.envRows || []) {
    const key = String(row.key ?? '').trim();
    if (!key) continue;
    const val = String(row.value ?? '');
    if (val.trim() !== '') {
      env[key] = val;
      const refIdx = envRefs.indexOf(key);
      if (refIdx >= 0) envRefs.splice(refIdx, 1);
      seenEnvKeys.add(key);
    } else if (!seenEnvKeys.has(key)) {
      envRefs.push(key);
      seenEnvKeys.add(key);
    }
  }
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    kind: draft.kind,
    repo: draft.repo.trim(),
    description: draft.description.trim(),
    ref: draft.ref.trim(),
    version: draft.version.trim(),
    npmPackage: draft.npmPackage.trim(),
    targets: draft.targets,
    skills: {
      include,
      mode: draft.skills.mode,
    },
    mcp: {
      serverName: draft.mcp.serverName.trim() || draft.id.trim(),
      transport: draft.mcp.transport,
      command: draft.mcp.command.trim(),
      args,
      url: draft.mcp.url.trim(),
      envRefs,
      env,
    },
    plugin: { name: draft.plugin.name.trim(), marketplace: draft.plugin.marketplace.trim(), harnesses: draft.plugin.harnesses },
    commands: draft.commands,
  };
}

function statusLabel(status) {
  switch (status) {
    case 'installed': return '已安装';
    case 'failed': return '安装失败';
    case 'uninstalled': return '已卸载';
    case 'not-installed': return '待安装';
    default: return '未启用';
  }
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value ?? ''));
}

function instructionStatusLabel(status) {
  switch (status) {
    case 'synced': return '已同步';
    case 'modified': return '待同步';
    case 'missing': return '未创建';
    case 'symlink': return '待拆软链';
    case 'disabled': return '未启用';
    case 'error': return '读取异常';
    default: return '未维护';
  }
}

function stepBadgeClass(status) {
  if (status === 'ok') return 'ap-badge ap-badge-ok';
  if (status === 'error') return 'ap-badge ap-badge-err';
  if (status === 'preview') return 'ap-badge ap-badge-kind';
  return 'ap-badge';
}

const TABS = [
  { id: 'skills', label: 'Skills', kinds: ['skills-repo'], addKind: 'skills-repo', addLabel: '添加 Skills 来源' },
  { id: 'mcp', label: 'MCP', kinds: ['mcp'], addKind: 'mcp', addLabel: '添加 MCP' },
  { id: 'plugins', label: '插件', kinds: ['plugin', 'installer'], addKind: 'plugin', addLabel: '添加插件' },
  { id: 'rules', label: '规则' },
];

function tabOfKind(kind) {
  return TABS.find(item => item.kinds?.includes(kind))?.id || 'skills';
}

function kindLabel(kind) {
  return kind === 'installer' ? 'CLI 工具' : (CARD_KIND_LABELS[kind] || kind);
}

// 对齐状态列的表头只有约 44px 宽，用短名；完整端名放在每格的 aria-label / title 里
const HARNESS_SHORT = { codex: 'Codex', 'claude-code': 'Claude', antigravity: 'Agy', dsh: 'DSH' };

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
function Glyph({ status }) {
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
function MatrixGroup({ title, count, labels = false, children }) {
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
function MatrixCells({ cells, ariaLabel }) {
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
function ToggleCells({ cells, ariaLabel, disabled }) {
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

function LogPanel({ log, onClear }) {
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
function packageAttention(pkg, ver) {
  const labelOf = h => HARNESS_META[h]?.label || h;
  const failed = pkg.targets.filter(h => pkg.harnessStatuses[h]?.status === 'failed');
  const pending = pkg.targets.filter(h => ['not-installed', 'uninstalled'].includes(pkg.harnessStatuses[h]?.status));
  if (failed.length) {
    return {
      level: 'error',
      reason: failed.map(h => `${labelOf(h)} 安装失败${pkg.harnessStatuses[h]?.lastError ? `：${pkg.harnessStatuses[h].lastError}` : ''}`).join('；'),
      action: { type: 'package.install', label: '重试安装', busy: '安装中…' },
    };
  }
  if (pending.length) {
    return {
      level: 'warn',
      reason: `尚未安装到 ${pending.map(labelOf).join('、')}`,
      action: { type: 'package.install', label: '安装', busy: '安装中…' },
    };
  }
  if (ver.hasUpdate) {
    return { level: 'warn', reason: '', action: { type: 'package.upgrade', label: '升级', busy: '升级中…' } };
  }
  if (pkg.lock.checkError) {
    return {
      level: 'warn',
      reason: `检查更新失败：${pkg.lock.checkError}`,
      action: { type: 'packages.checkUpdates', label: '重新检查', busy: '检查中…' },
    };
  }
  return null;
}

const KIND_OPTIONS = Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }));

const SKILLS_MODE_OPTIONS = [
  { value: 'symlink', label: '软链接（推荐）' },
  { value: 'copy', label: '复制' },
];

const MCP_TRANSPORT_OPTIONS = [
  { value: 'stdio', label: 'Stdio' },
  { value: 'http', label: 'HTTP' },
];

const ANALYZER_HARNESS_OPTIONS = [
  { value: '', label: '静态规则', meta: '快速' },
  ...ANALYZER_HARNESS_IDS.map(id => ({
    value: id,
    label: HARNESS_META[id].label,
    meta: '深度分析',
  })),
];

const CUSTOM_MODEL_VALUE = '__custom__';

function Select({
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

export function PackagesPage() {
  const [state, setState] = useState(null);
  const [sessionKey, setSessionKey] = useState('');
  const [tab, setTab] = useState('skills');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeWarn, setNoticeWarn] = useState(false);
  // 执行记录与提示只属于触发它的视图：{ id, tab, steps, preview }
  const [log, setLog] = useState(null);
  const [pendingKey, setPendingKey] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [reloadTick, setReloadTick] = useState(0);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTab, setEditorTab] = useState('');
  const [editingOriginalId, setEditingOriginalId] = useState('');
  const [draft, setDraft] = useState(emptyDraft);
  const [nameTouched, setNameTouched] = useState(false);
  const [evidence, setEvidence] = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [openMenuId, setOpenMenuId] = useState('');

  // 规则片段的编辑草稿：{ [片段 id]: { title, content } }，'__new__' 为新建片段
  const [ruleDrafts, setRuleDrafts] = useState({});
  const [previewHarness, setPreviewHarness] = useState(HARNESS_IDS[0]);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [analyzerHarness, setAnalyzerHarness] = useState('');
  const [analyzerModel, setAnalyzerModel] = useState('');
  const [customModelMode, setCustomModelMode] = useState(false);
  const [modelsByHarness, setModelsByHarness] = useState({});
  const [loadingModels, setLoadingModels] = useState(false);

  useEffect(() => {
    if (!openMenuId) return;
    const onPointerDown = event => {
      if (!event.target?.closest?.('.ap-menu-wrap')) setOpenMenuId('');
    };
    const onKeyDown = event => {
      if (event.key === 'Escape') setOpenMenuId('');
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenuId]);

  useEffect(() => {
    let active = true;
    setError('');
    void apiRequest()
      .then(data => {
        if (!active) return;
        setSessionKey(data.key);
        setState(data);
        setAnalyzerHarness(data.settings?.analyzer?.harness || '');
        setAnalyzerModel(data.settings?.analyzer?.model || '');
      })
      .catch(cause => {
        if (active) setError(cause.message);
      });
    return () => { active = false; };
  }, [reloadTick]);

  async function postWithAutoKey(payload) {
    try {
      return await apiRequest(payload, sessionKey);
    } catch (cause) {
      // 服务端 HMR 热重载后会生成新的会话令牌，自动静默拉取新令牌并重试一次，无需手动刷新页面。
      if (cause?.status === 403) {
        const refreshed = await apiRequest();
        setSessionKey(refreshed.key);
        setState(refreshed);
        return apiRequest(payload, refreshed.key);
      }
      throw cause;
    }
  }

  // key 标记正在执行的具体按钮（如 package.install:hindsight），让它显示「安装中…」
  async function runAction(payload, { onSuccess, silentNotice = false, key = '' } = {}) {
    if (!sessionKey) return;
    const originTab = tab;
    setBusy(true);
    setPendingKey(key);
    setError('');
    if (!silentNotice) setNotice('');
    try {
      const result = await postWithAutoKey(payload);
      if (result.state) setState(result.state);
      // 新操作取代旧记录：没有步骤的操作也清掉上一条，避免残留已不相关的记录
      const steps = Array.isArray(result.steps) && result.steps.length ? result.steps : null;
      if (!silentNotice && result.message) {
        setNotice(result.message);
        // 部分失败不能用成功色提示
        setNoticeWarn(Boolean(steps?.some(step => step.status === 'error' || step.status === 'failed')));
      }
      setLog(prev => (steps
        ? { id: (prev?.id ?? 0) + 1, tab: originTab, steps, preview: Boolean(payload.dryRun) }
        : (prev?.tab === originTab ? null : prev)));
      if (onSuccess) onSuccess(result);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
      setPendingKey('');
    }
  }

  function switchTab(next) {
    if (next === tab) return;
    setTab(next);
    setSearch('');
    setNotice('');
    setError('');
    setOpenMenuId('');
    setConfirm(null);
  }

  async function fetchModelsForHarness(harness, { force = false } = {}) {
    if (!harness || !sessionKey) return;
    if (!force && modelsByHarness[harness]) return;
    setLoadingModels(true);
    try {
      const res = await postWithAutoKey({ type: 'analyzer.models', harness });
      setModelsByHarness(prev => ({
        ...prev,
        [harness]: {
          models: Array.isArray(res.models) ? res.models : [],
          defaultModel: res.defaultModel || '',
          error: res.error || '',
        },
      }));
    } catch (cause) {
      setModelsByHarness(prev => ({
        ...prev,
        [harness]: { models: [], defaultModel: '', error: cause.message },
      }));
    } finally {
      setLoadingModels(false);
    }
  }

  function openSettingsPanel() {
    const saved = state?.settings?.analyzer ?? { harness: '', model: '' };
    const nextHarness = saved.harness || '';
    const nextModel = saved.model || '';
    setAnalyzerHarness(nextHarness);
    setAnalyzerModel(nextModel);
    const cached = nextHarness ? modelsByHarness[nextHarness]?.models : null;
    setCustomModelMode(Boolean(nextModel && cached && !cached.some(m => m.id === nextModel)));
    setSettingsOpen(true);
    if (nextHarness) void fetchModelsForHarness(nextHarness);
  }

  function handleSelectAnalyzerHarness(nextHarness) {
    setAnalyzerHarness(nextHarness);
    setAnalyzerModel('');
    setCustomModelMode(false);
    if (nextHarness) void fetchModelsForHarness(nextHarness);
  }

  async function saveAnalyzerSettings() {
    await runAction(
      {
        type: 'settings.save',
        analyzer: {
          harness: analyzerHarness,
          model: analyzerHarness ? analyzerModel.trim() : '',
        },
      },
      {
        key: 'settings.save',
        onSuccess: res => {
          const saved = res.settings?.analyzer ?? { harness: '', model: '' };
          setAnalyzerHarness(saved.harness || '');
          setAnalyzerModel(saved.model || '');
          setSettingsOpen(false);
        },
      }
    );
  }

  async function handleInspectRepo() {
    if (!draft.repo.trim() || !sessionKey) return;
    setInspecting(true);
    setError('');
    setNotice('');
    try {
      const result = await postWithAutoKey({ type: 'repo.inspect', repo: draft.repo.trim() });
      const nextDraft = packageToDraft(result.draft);
      // 已手动填写的名称与包 ID 不被解析结果覆盖；包 ID 留空时按名称生成
      setDraft(prev => ({
        ...nextDraft,
        id: prev.id,
        name: editingOriginalId || nameTouched ? prev.name : nextDraft.name,
      }));
      setEvidence(result.evidence);
      setNotice(result.message);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setInspecting(false);
    }
  }

  function closeEditor() {
    setEditorOpen(false);
    setEditingOriginalId('');
    setEvidence(null);
    setSettingsOpen(false);
  }

  function openNewEditor(kind = 'skills-repo') {
    setOpenMenuId('');
    setConfirm(null);
    setEditingOriginalId('');
    setDraft({ ...emptyDraft(), kind });
    setEditorTab(tab);
    setNameTouched(false);
    setEvidence(null);
    setShowAdvanced(false);
    setSettingsOpen(false);
    setEditorOpen(true);
  }

  function openEditEditor(pkg) {
    setOpenMenuId('');
    setEditingOriginalId(pkg.id);
    setDraft(packageToDraft(pkg));
    setEvidence(null);
    setShowAdvanced(false);
    setSettingsOpen(false);
    setConfirm(null);
    setEditorTab(tab);
    setEditorOpen(true);
  }

  function toggleTarget(harnessId) {
    setDraft(prev => {
      const exists = prev.targets.includes(harnessId);
      const targets = exists
        ? prev.targets.filter(id => id !== harnessId)
        : [...prev.targets, harnessId];
      return { ...prev, targets };
    });
  }

  function updateHarnessCommand(harnessId, field, value) {
    setDraft(prev => ({
      ...prev,
      commands: {
        ...prev.commands,
        [harnessId]: {
          ...(prev.commands[harnessId] || {}),
          [field]: value,
        },
      },
    }));
  }

  function updateMcpEnvRow(index, field, value) {
    setDraft(prev => ({
      ...prev,
      mcp: {
        ...prev.mcp,
        envRows: (prev.mcp.envRows || []).map((row, idx) =>
          idx === index ? { ...row, [field]: value } : row
        ),
      },
    }));
  }

  function addMcpEnvRow() {
    setDraft(prev => ({
      ...prev,
      mcp: {
        ...prev.mcp,
        envRows: [...(prev.mcp.envRows || []), { key: '', value: '' }],
      },
    }));
  }

  function removeMcpEnvRow(index) {
    setDraft(prev => ({
      ...prev,
      mcp: {
        ...prev.mcp,
        envRows: (prev.mcp.envRows || []).filter((_, idx) => idx !== index),
      },
    }));
  }

  async function submitEditor({ installNow = false, dryRun = false }) {
    await runAction(
      {
        type: 'package.save',
        originalId: editingOriginalId || undefined,
        package: draftToPackage(draft),
        installNow,
        dryRun,
      },
      {
        key: `editor:${dryRun ? 'preview' : installNow ? 'install' : 'save'}`,
        onSuccess: () => {
          if (dryRun) return;
          closeEditor();
          // 保存后跳到该类型所在的视图（不清空提示与执行记录）
          setTab(tabOfKind(draft.kind));
          setLog(prev => (prev ? { ...prev, tab: tabOfKind(draft.kind) } : prev));
        },
      }
    );
  }

  // 安装器或已解析/填写自定义命令时直接在主区展示，避免折叠在高级设置里被忽略
  const hasFilledCommands = Boolean(
    draft.commands.shared?.install ||
    draft.commands.shared?.upgrade ||
    draft.commands.shared?.uninstall ||
    draft.commands.shared?.version ||
    HARNESS_IDS.some(h => draft.commands[h]?.install || draft.commands[h]?.upgrade || draft.commands[h]?.uninstall)
  );
  const showCommandsInMain = draft.kind === 'installer' || hasFilledCommands;
  const showSharedCommands = draft.kind === 'installer' || Boolean(
    draft.commands.shared?.install ||
    draft.commands.shared?.upgrade ||
    draft.commands.shared?.uninstall ||
    draft.commands.shared?.version
  );
  const commandFields = (
    <>
      <p className="ap-help">
        {draft.kind === 'installer' ? '全局命令每次操作只执行一次；勾选端后将依次执行对应端命令。' : '填写后覆盖内置安装方式；清空则回落到内置适配器。'}可用变量 <code>{'{{claude}}'}</code> <code>{'{{repo}}'}</code> <code>{'{{ref}}'}</code> <code>{'{{version}}'}</code> <code>{'{{dir}}'}</code>（用到 <code>{'{{dir}}'}</code> 时自动检出仓库）
      </p>
      {showSharedCommands && (
        <div className="ap-cmd-card">
          <strong>全局命令</strong>
          <div className="ap-grid">
            <div className="ap-field">
              <label htmlFor="ap-cmd-shared-install">安装</label>
              <input
                id="ap-cmd-shared-install"
                className="ap-input"
                placeholder="可选，如官方 CLI 安装脚本"
                value={draft.commands.shared?.install || ''}
                onChange={e => updateHarnessCommand('shared', 'install', e.target.value)}
              />
            </div>
            <div className="ap-field">
              <label htmlFor="ap-cmd-shared-upgrade">升级</label>
              <input
                id="ap-cmd-shared-upgrade"
                className="ap-input"
                placeholder="留空复用全局安装命令"
                value={draft.commands.shared?.upgrade || ''}
                onChange={e => updateHarnessCommand('shared', 'upgrade', e.target.value)}
              />
            </div>
            <div className="ap-field">
              <label htmlFor="ap-cmd-shared-uninstall">卸载</label>
              <input
                id="ap-cmd-shared-uninstall"
                className="ap-input"
                placeholder="全部端卸载后执行，可选"
                value={draft.commands.shared?.uninstall || ''}
                onChange={e => updateHarnessCommand('shared', 'uninstall', e.target.value)}
              />
            </div>
            <div className="ap-field">
              <label htmlFor="ap-cmd-shared-version">版本检测</label>
              <input
                id="ap-cmd-shared-version"
                className="ap-input"
                placeholder="可选，如 codegraph --version"
                value={draft.commands.shared?.version || ''}
                onChange={e => updateHarnessCommand('shared', 'version', e.target.value)}
              />
            </div>
          </div>
        </div>
      )}
      {draft.targets.map(harnessId => (
        <div key={harnessId} className="ap-cmd-card">
          <strong>{HARNESS_META[harnessId].label}</strong>
          <div className="ap-grid">
            <div className="ap-field">
              <label htmlFor={`ap-cmd-install-${harnessId}`}>安装</label>
              <input
                id={`ap-cmd-install-${harnessId}`}
                className="ap-input"
                placeholder={draft.commands.shared?.install ? '留空仅执行全局命令' : '该端安装命令'}
                value={draft.commands[harnessId]?.install || ''}
                onChange={e => updateHarnessCommand(harnessId, 'install', e.target.value)}
              />
            </div>
            <div className="ap-field">
              <label htmlFor={`ap-cmd-upgrade-${harnessId}`}>升级</label>
              <input
                id={`ap-cmd-upgrade-${harnessId}`}
                className="ap-input"
                placeholder="留空复用安装命令"
                value={draft.commands[harnessId]?.upgrade || ''}
                onChange={e => updateHarnessCommand(harnessId, 'upgrade', e.target.value)}
              />
            </div>
            <div className="ap-field">
              <label htmlFor={`ap-cmd-uninstall-${harnessId}`}>卸载</label>
              <input
                id={`ap-cmd-uninstall-${harnessId}`}
                className="ap-input"
                placeholder="可选"
                value={draft.commands[harnessId]?.uninstall || ''}
                onChange={e => updateHarnessCommand(harnessId, 'uninstall', e.target.value)}
              />
            </div>
          </div>
        </div>
      ))}
    </>
  );

  const blockedTargets = draft.targets
    .map(harnessId => [harnessId, unsupportedReason(draft, harnessId)])
    .filter(([, reason]) => reason);

  const currentTab = TABS.find(item => item.id === tab) || TABS[0];
  const needle = search.trim().toLowerCase();
  const matchesSearch = pkg => !needle || [pkg.name, pkg.id, pkg.repo, pkg.description, ...(pkg.skillItems ?? []).map(item => item.name)]
    .some(text => String(text || '').toLowerCase().includes(needle));
  const tabPackages = useMemo(() => {
    const list = (state?.packages ?? []).filter(pkg => currentTab.kinds?.includes(pkg.kind));
    // 需要处理的条目排在前面
    return list
      .map(pkg => ({ pkg, ver: summarizePackageVersions(pkg) }))
      .map(item => ({ ...item, attention: packageAttention(item.pkg, item.ver) }))
      .sort((a, b) => Number(Boolean(b.attention)) - Number(Boolean(a.attention)));
  }, [state, currentTab]);
  const filteredItems = tabPackages.filter(item => matchesSearch(item.pkg));
  const filteredPackages = filteredItems.map(item => item.pkg);
  const needsGlobalSync = Boolean(state && (state.summary.pendingInstall > 0 || state.summary.failed > 0));
  const snippets = state?.instructions?.snippets ?? [];
  const rulesDirty = Object.keys(ruleDrafts).length > 0;
  const tabCount = id => {
    const def = TABS.find(item => item.id === id);
    if (id === 'rules') return snippets.length;
    return (state?.packages ?? []).filter(pkg => def.kinds.includes(pkg.kind)).length;
  };

  function askConfirm(rowKey, text, button, run) {
    setOpenMenuId('');
    setConfirm({ rowKey, text, button, run });
  }

  // 矩阵开关：点亮立即安装，熄灭先行内确认
  function togglePackageHarness(pkg, harnessId, next) {
    const label = HARNESS_META[harnessId].label;
    const run = () => runAction(
      { type: 'package.toggleHarness', id: pkg.id, harness: harnessId, enabled: next },
      { key: `toggle:${pkg.id}:${harnessId}` },
    );
    if (next) return void run();
    const othersInstalled = pkg.targets.some(h => h !== harnessId && pkg.harnessStatuses[h]?.status === 'installed');
    const sharedUninstall = pkg.kind === 'installer' && !othersInstalled ? pkg.commands?.shared?.uninstall : '';
    const what = pkg.kind === 'mcp' ? `移除「${pkg.name}」的 MCP 配置条目` : `卸载「${pkg.name}」`;
    askConfirm(
      pkg.id,
      `将从 ${label} ${what}。${sharedUninstall ? `这是最后一个端，会同时执行全局卸载命令：${sharedUninstall}` : ''}`,
      '确认卸载',
      run,
    );
  }

  function toggleSkill(pkg, skillName, harnessId, next) {
    const label = HARNESS_META[harnessId].label;
    const run = () => runAction(
      { type: 'skill.toggle', id: pkg.id, skill: skillName, harness: harnessId, enabled: next },
      { key: `skill:${pkg.id}:${skillName || '*'}:${harnessId}` },
    );
    if (next) return void run();
    askConfirm(
      `${pkg.id}:${skillName || '*'}`,
      `将从 ${label} 移除${skillName ? ` Skill「${skillName}」` : `「${pkg.name}」的全部 Skill`}（删除该端的软链或副本）。`,
      '确认移除',
      run,
    );
  }

  function adopt(area, name) {
    void runAction({ type: 'local.adopt', area, name }, { key: `adopt:${area}:${name}` });
  }

  // 规则：开关、排序、编辑、删除都保存片段列表，服务端只写拼接结果有变化的端
  function saveSnippets(next, key, onSuccess) {
    const files = state?.instructions?.harnesses ?? {};
    const run = () => runAction({ type: 'rules.save', snippets: next }, { key, onSuccess });
    // 拼接结果变化、且该端文件已被外部修改时，写入会覆盖外部改动，先确认
    const overwritten = HARNESS_IDS.filter(h => {
      const after = composeSnippets(next, h);
      return after && after !== composeSnippets(snippets, h) && files[h]?.status === 'modified';
    });
    if (!overwritten.length) return run();
    askConfirm(
      'rules-files',
      `${overwritten.map(h => `${files[h].label} 的 ${files[h].fileName}`).join('、')} 已被外部修改，本次保存会按片段重写并覆盖这些改动。`,
      '确认保存',
      run,
    );
    return Promise.resolve();
  }

  function toggleSnippet(snippet, harnessId, next) {
    const list = snippets.map(item => (item.id === snippet.id
      ? { ...item, harnesses: next ? [...item.harnesses, harnessId] : item.harnesses.filter(h => h !== harnessId) }
      : item));
    const run = () => saveSnippets(list, `rule:${snippet.id}:${harnessId}`);
    if (next) return void run();
    const info = state.instructions.harnesses[harnessId];
    askConfirm(
      `rule:${snippet.id}`,
      `将从 ${info.label} 的 ${info.fileName} 移除片段「${snippet.title}」并立即写入；该端没有其他开启的片段时文件保持原样。`,
      '确认移除',
      run,
    );
  }

  function moveSnippet(snippet, offset) {
    const index = snippets.findIndex(item => item.id === snippet.id);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= snippets.length) return;
    const list = [...snippets];
    [list[index], list[target]] = [list[target], list[index]];
    void saveSnippets(list, `rule-move:${snippet.id}`);
  }

  function deleteSnippet(snippet) {
    askConfirm(
      `rule:${snippet.id}`,
      `将删除片段「${snippet.title}」，并重写开启了它的端（${snippet.harnesses.map(h => HARNESS_META[h].label).join('、') || '无'}）。`,
      '确认删除',
      () => saveSnippets(snippets.filter(item => item.id !== snippet.id), `rule-delete:${snippet.id}`),
    );
  }

  function updateRuleDraft(id, patch) {
    setRuleDrafts(prev => ({ ...prev, [id]: { ...(prev[id] ?? {}), ...patch } }));
  }

  function discardRuleDraft(id) {
    setRuleDrafts(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function saveRuleDraft(id) {
    const draftEntry = ruleDrafts[id];
    if (!draftEntry) return;
    const list = id === '__new__'
      ? [...snippets, { id: `snippet-${snippets.length + 1}-${Math.random().toString(36).slice(2, 7)}`, title: draftEntry.title, content: draftEntry.content, harnesses: [] }]
      : snippets.map(item => (item.id === id ? { ...item, title: draftEntry.title ?? item.title, content: draftEntry.content ?? item.content } : item));
    void saveSnippets(list, `rule-save:${id}`, () => discardRuleDraft(id));
  }

  // 纳管本机指令文件：全文导入为只对该端开启的片段，并在该端关闭其他片段，写入结果与现有文件一致
  async function adoptRuleFile(harnessId) {
    if (!sessionKey) return;
    setBusy(true);
    setPendingKey(`adopt:rules:${harnessId}`);
    setError('');
    setNotice('');
    try {
      const res = await postWithAutoKey({ type: 'rules.import', harness: harnessId });
      const info = state.instructions.harnesses[harnessId];
      const list = [
        ...snippets.map(item => ({ ...item, harnesses: item.harnesses.filter(h => h !== harnessId) })),
        { id: `import-${harnessId}-${Math.random().toString(36).slice(2, 7)}`, title: `${info.label} 现有 ${info.fileName}`, content: res.content ?? '', harnesses: [harnessId] },
      ];
      const saved = await postWithAutoKey({ type: 'rules.save', snippets: list });
      if (saved.state) setState(saved.state);
      setNotice(`已把 ${info.label} 的 ${info.fileName} 纳管为片段`);
      setNoticeWarn(false);
      if (saved.steps?.length) setLog(prev => ({ id: (prev?.id ?? 0) + 1, tab: 'rules', steps: saved.steps, preview: false }));
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
      setPendingKey('');
    }
  }

  const editingInline = Boolean(
    editorOpen && editorTab === tab && editingOriginalId && filteredPackages.some(pkg => pkg.id === editingOriginalId)
  );
  const savedAnalyzer = state?.settings?.analyzer ?? { harness: '', model: '' };
  const savedAnalyzerLabel = savedAnalyzer.harness
    ? `${HARNESS_META[savedAnalyzer.harness]?.label || savedAnalyzer.harness}${savedAnalyzer.model ? ` · ${savedAnalyzer.model}` : '（默认模型）'}`
    : '静态规则';
  const currentModelInfo = analyzerHarness ? (modelsByHarness[analyzerHarness] ?? null) : null;
  const currentModels = currentModelInfo?.models ?? [];
  const modelOptions = useMemo(() => {
    const opts = [
      {
        value: '',
        label: '默认模型',
        meta: currentModelInfo?.defaultModel || '',
      },
      ...currentModels.map(m => ({
        value: m.id,
        label: m.label || m.id,
        meta: m.label && m.label !== m.id ? m.id : '',
      })),
      { value: CUSTOM_MODEL_VALUE, label: '自定义模型…' },
    ];
    return opts;
  }, [currentModels, currentModelInfo]);
  const modelInList = !analyzerModel || currentModels.some(m => m.id === analyzerModel);
  const modelSelectValue = customModelMode || !modelInList ? CUSTOM_MODEL_VALUE : analyzerModel;

  function busyLabel(key, idle, running) {
    return pendingKey === key ? running : idle;
  }

    const editorPanel = editorOpen ? (
      <section
        key={editingOriginalId || 'new'}
        className="ap-card ap-editor"
        aria-label={editingOriginalId ? '编辑包配置' : '添加新包'}
      >
        <div className="ap-editor-head">
          <h3>{editingOriginalId ? `编辑 ${editingOriginalId}` : '添加包'}</h3>
          <Button variant="outline" disabled={busy} onClick={closeEditor}>收起</Button>
        </div>

          <div className="ap-inspect-row">
            <div className="ap-field">
              <label htmlFor="ap-repo">GitHub 仓库</label>
              <input
                id="ap-repo"
                className="ap-input"
                placeholder="owner/repo 或 GitHub 链接"
                value={draft.repo}
                onChange={e => setDraft(prev => ({ ...prev, repo: e.target.value }))}
              />
            </div>
            <Button
              variant="outline"
              disabled={busy || inspecting || !draft.repo.trim()}
              onClick={() => void handleInspectRepo()}
            >
              {inspecting ? (savedAnalyzer.harness ? '深度分析中…' : '解析中…') : '解析仓库'}
            </Button>
          </div>
          <div className="ap-analyzer-hint">
            <span>当前解析：{savedAnalyzerLabel}{savedAnalyzer.harness ? '（深度模式）' : ''}</span>
            {!settingsOpen && (
              <button
                type="button"
                className="ap-link-btn"
                disabled={busy || inspecting}
                onClick={openSettingsPanel}
              >
                切换
              </button>
            )}
          </div>
      {settingsOpen && (
<section className="ap-settings-card" aria-label="全局解析设置">
  <div className="ap-settings-head">
    <h4>全局解析设置</h4>
    <span className="ap-help">对之后所有「解析仓库」生效</span>
  </div>
  <div className="ap-grid">
    <div className="ap-field">
      <label htmlFor="ap-analyzer-harness">解析引擎</label>
      <Select
        id="ap-analyzer-harness"
        ariaLabel="解析引擎"
        value={analyzerHarness}
        options={ANALYZER_HARNESS_OPTIONS}
        onChange={handleSelectAnalyzerHarness}
      />
    </div>
    {analyzerHarness && (
      <div className="ap-field">
        <label htmlFor="ap-analyzer-model">模型</label>
        <Select
          id="ap-analyzer-model"
          ariaLabel="模型"
          disabled={loadingModels}
          value={modelSelectValue}
          options={modelOptions}
          onChange={next => {
            if (next === CUSTOM_MODEL_VALUE) {
              setCustomModelMode(true);
            } else {
              setCustomModelMode(false);
              setAnalyzerModel(next);
            }
          }}
        />
      </div>
    )}
    {analyzerHarness && (customModelMode || !modelInList) && (
      <div className="ap-field">
        <label htmlFor="ap-analyzer-model-custom">自定义模型</label>
        <input
          id="ap-analyzer-model-custom"
          className="ap-input"
          placeholder="输入模型 ID"
          value={analyzerModel}
          onChange={e => setAnalyzerModel(e.target.value)}
        />
      </div>
    )}
  </div>
  {analyzerHarness && currentModelInfo?.error && (
    <p className="ap-field-error" role="alert">{currentModelInfo.error}</p>
  )}
  <p className="ap-help">
    {analyzerHarness
      ? '启用后，点击「解析仓库」将浅克隆仓库到临时目录，由所选 Harness 只读深度分析并生成各端安装、升级与卸载方案；命令仅回填草稿，确认后再执行。'
      : '当前使用静态规则快速解析；遇到 Skills + MCP 等复合仓库时，可选择 Codex、Claude Code 或 Antigravity 开启深度分析。'}
  </p>
  <div className="ap-editor-footer">
    {analyzerHarness && (
      <Button
        variant="outline"
        disabled={busy || loadingModels}
        onClick={() => void fetchModelsForHarness(analyzerHarness, { force: true })}
      >
        {loadingModels ? '刷新中…' : '刷新模型'}
      </Button>
    )}
    <Button variant="outline" disabled={busy} onClick={() => setSettingsOpen(false)}>关闭</Button>
    <Button variant="outline" disabled={busy} onClick={() => void saveAnalyzerSettings()}>{busyLabel('settings.save', '保存设置', '保存中…')}</Button>
  </div>
</section>
      )}


          {evidence && (
            <div className="ap-evidence">
              <div>
                探测结果：默认分支 <code>{evidence.defaultBranch}</code>
                {evidence.latestRelease ? <> · 最新 Release <code>{evidence.latestRelease}</code></> : null}
                {!evidence.latestRelease && evidence.plugin?.version ? <> · 版本 <code>{formatVersion(evidence.plugin.version)}</code></> : null}
                {evidence.discoveredSkills?.length ? <> · 发现 {evidence.discoveredSkills.length} 个 Skills（{evidence.discoveredSkills.slice(0, 6).join(', ')}{evidence.discoveredSkills.length > 6 ? '…' : ''}）</> : null}
                {evidence.cliBin ? <> · CLI <code>{evidence.cliBin}</code></> : null}
                {evidence.npmPackage ? <> · npm 包 <code>{evidence.npmPackage}</code></> : null}
                {evidence.pythonPackage ? <> · Python 包 <code>{evidence.pythonPackage}</code></> : null}
                {evidence.plugin ? <> · 插件 <code>{evidence.plugin.name}@{evidence.plugin.marketplace}</code>{evidence.plugin.hookEvents?.length ? <>，声明 Hooks：{evidence.plugin.hookEvents.join('、')}（Claude Code / Codex 安装时注册）</> : '，未声明 Hooks'}</> : null}
              </div>
              {evidence.ai && (
                <div className="ap-ai-evidence">
                  <div className="ap-ai-head">
                    <span className="ap-badge ap-badge-kind">
                      深度分析 · {evidence.ai.harnessLabel}{evidence.ai.model ? ` (${evidence.ai.model})` : ''}
                    </span>
                    {evidence.ai.summary && <span>{evidence.ai.summary}</span>}
                  </div>
                  {evidence.ai.warnings?.length > 0 && (
                    <ul className="ap-ai-warnings">
                      {evidence.ai.warnings.map((item, idx) => (
                        <li key={idx}>{item}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="ap-grid">
            <div className="ap-field">
              <label htmlFor="ap-name">名称</label>
              <input
                id="ap-name"
                className="ap-input"
                placeholder="解析后自动填写"
                value={draft.name}
                onChange={e => {
                  setNameTouched(true);
                  setDraft(prev => ({ ...prev, name: e.target.value }));
                }}
              />
            </div>
            <div className="ap-field">
              <label htmlFor="ap-kind">类型</label>
              <Select
                id="ap-kind"
                ariaLabel="类型"
                value={draft.kind}
                options={KIND_OPTIONS}
                onChange={nextKind => setDraft(prev => ({ ...prev, kind: nextKind }))}
              />
            </div>
          </div>

          <div className="ap-field">
            <label>安装到</label>
            <div className="ap-check-group">
              {HARNESS_IDS.map(harnessId => {
                const reason = unsupportedReason(draft, harnessId);
                const checked = draft.targets.includes(harnessId);
                return (
                  <label key={harnessId} className="ap-check-item">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleTarget(harnessId)}
                    />
                    <span>{HARNESS_META[harnessId].label}</span>
                    {reason && <span className="ap-help">不支持：{reason}</span>}
                  </label>
                );
              })}
            </div>
            {blockedTargets.length > 0 && (
              <p className="ap-field-error" role="alert">
                已勾选不支持的端：{blockedTargets.map(([h]) => HARNESS_META[h].label).join('、')}。请取消勾选，或在{draft.kind === 'installer' ? '下方' : '「高级设置」中'}为该端填写安装命令。
              </p>
            )}
          </div>

          {draft.kind === 'skills-repo' && (
            <div className="ap-section">
              <h4>Skills 同步</h4>
              <div className="ap-grid">
                <div className="ap-field">
                  <label htmlFor="ap-skills-mode">安装方式</label>
                  <Select
                    id="ap-skills-mode"
                    ariaLabel="安装方式"
                    value={draft.skills.mode}
                    options={SKILLS_MODE_OPTIONS}
                    onChange={mode => setDraft(prev => ({ ...prev, skills: { ...prev.skills, mode } }))}
                  />
                </div>
                <div className="ap-field">
                  <label htmlFor="ap-skills-include">指定 Skills</label>
                  <input
                    id="ap-skills-include"
                    className="ap-input"
                    placeholder="留空同步全部，如 code-review, tdd"
                    value={draft.skills.includeText}
                    onChange={e => setDraft(prev => ({ ...prev, skills: { ...prev.skills, includeText: e.target.value } }))}
                  />
                </div>
              </div>
            </div>
          )}

          {draft.kind === 'plugin' && (
            <div className="ap-section">
              <h4>插件</h4>
              <div className="ap-grid">
                <div className="ap-field">
                  <label htmlFor="ap-plugin-name">插件名</label>
                  <input
                    id="ap-plugin-name"
                    className="ap-input"
                    placeholder="如 ponytail"
                    value={draft.plugin.name}
                    onChange={e => setDraft(prev => ({ ...prev, plugin: { ...prev.plugin, name: e.target.value } }))}
                  />
                </div>
                <div className="ap-field">
                  <label htmlFor="ap-plugin-marketplace">插件市场</label>
                  <input
                    id="ap-plugin-marketplace"
                    className="ap-input"
                    placeholder="如 ponytail"
                    value={draft.plugin.marketplace}
                    onChange={e => setDraft(prev => ({ ...prev, plugin: { ...prev.plugin, marketplace: e.target.value } }))}
                  />
                </div>
              </div>
              <p className="ap-help">安装后：Codex 需在 /hooks 中信任插件 Hooks；Claude Code 需新开会话生效；Antigravity 是否运行插件 Hooks 未确认。</p>
            </div>
          )}

          {draft.kind === 'mcp' && (
            <div className="ap-section">
              <h4>MCP Server</h4>
              <div className="ap-grid">
                <div className="ap-field">
                  <label htmlFor="ap-mcp-key">Server Key</label>
                  <input
                    id="ap-mcp-key"
                    className="ap-input"
                    placeholder="默认同包 ID"
                    value={draft.mcp.serverName}
                    onChange={e => setDraft(prev => ({ ...prev, mcp: { ...prev.mcp, serverName: e.target.value } }))}
                  />
                </div>
                <div className="ap-field">
                  <label htmlFor="ap-mcp-transport">传输方式</label>
                  <Select
                    id="ap-mcp-transport"
                    ariaLabel="传输方式"
                    value={draft.mcp.transport}
                    options={MCP_TRANSPORT_OPTIONS}
                    onChange={transport => setDraft(prev => ({ ...prev, mcp: { ...prev.mcp, transport } }))}
                  />
                </div>
                {draft.mcp.transport === 'stdio' ? (
                  <>
                    <div className="ap-field">
                      <label htmlFor="ap-mcp-cmd">Command</label>
                      <input
                        id="ap-mcp-cmd"
                        className="ap-input"
                        placeholder="如 npx 或 uvx"
                        value={draft.mcp.command}
                        onChange={e => setDraft(prev => ({ ...prev, mcp: { ...prev.mcp, command: e.target.value } }))}
                      />
                    </div>
                    <div className="ap-field">
                      <label htmlFor="ap-mcp-args">Args</label>
                      <input
                        id="ap-mcp-args"
                        className="ap-input"
                        placeholder="空格分隔，如 -y @playwright/mcp@{{version}}"
                        value={draft.mcp.argsText}
                        onChange={e => setDraft(prev => ({ ...prev, mcp: { ...prev.mcp, argsText: e.target.value } }))}
                      />
                    </div>
                  </>
                ) : (
                  <div className="ap-field">
                    <label htmlFor="ap-mcp-url">Server URL</label>
                    <input
                      id="ap-mcp-url"
                      className="ap-input"
                      placeholder="https://example.com/mcp"
                      value={draft.mcp.url}
                      onChange={e => setDraft(prev => ({ ...prev, mcp: { ...prev.mcp, url: e.target.value } }))}
                    />
                  </div>
                )}
              </div>
              {draft.mcp.transport === 'stdio' && (
                <div className="ap-field ap-kv-field">
                  <div className="ap-kv-head">
                    <label htmlFor={draft.mcp.envRows.length ? 'ap-mcp-env-key-0' : undefined}>环境变量</label>
                    <Button variant="outline" className="ap-kv-add" onClick={addMcpEnvRow}>添加变量</Button>
                  </div>
                  {draft.mcp.envRows.length > 0 && (
                    <div className="ap-kv-list">
                      {draft.mcp.envRows.map((row, idx) => (
                        <div key={idx} className="ap-kv-row">
                          <label htmlFor={`ap-mcp-env-key-${idx}`} className="ap-sr-only">环境变量名 {idx + 1}</label>
                          <input
                            id={`ap-mcp-env-key-${idx}`}
                            className="ap-input ap-kv-key"
                            placeholder="变量名，如 FIRECRAWL_API_KEY"
                            value={row.key}
                            onChange={e => updateMcpEnvRow(idx, 'key', e.target.value)}
                          />
                          <label htmlFor={`ap-mcp-env-val-${idx}`} className="ap-sr-only">环境变量值 {idx + 1}</label>
                          <input
                            id={`ap-mcp-env-val-${idx}`}
                            className="ap-input ap-kv-val"
                            placeholder="值（留空则引用宿主机变量）"
                            value={row.value}
                            onChange={e => updateMcpEnvRow(idx, 'value', e.target.value)}
                          />
                          <Button
                            variant="outline"
                            className="ap-kv-remove"
                            aria-label={`删除第 ${idx + 1} 行环境变量`}
                            onClick={() => removeMcpEnvRow(idx)}
                          >
                            删除
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {showCommandsInMain && (
            <div className="ap-section">
              <h4>{draft.kind === 'installer' ? '安装命令' : '安装 / 升级 / 卸载命令'}</h4>
              {commandFields}
            </div>
          )}

          <details
            className="ap-section ap-advanced"
            open={showAdvanced}
            onToggle={e => setShowAdvanced(e.currentTarget.open)}
          >
            <summary>
              高级设置
              {(draft.ref || draft.version) && (
                <span className="ap-help">{[draft.ref, draft.version].filter(Boolean).join(' · ')}</span>
              )}
            </summary>
            <div className="ap-grid">
              <div className="ap-field">
                <label htmlFor="ap-id">包 ID</label>
                <input
                  id="ap-id"
                  className="ap-input"
                  placeholder={editingOriginalId ? '' : '留空按名称生成'}
                  value={draft.id}
                  disabled={Boolean(editingOriginalId)}
                  onChange={e => setDraft(prev => ({ ...prev, id: e.target.value }))}
                />
              </div>
              <div className="ap-field">
                <label htmlFor="ap-ref">Git 引用</label>
                <input
                  id="ap-ref"
                  className="ap-input"
                  placeholder="Tag / 分支 / Commit"
                  value={draft.ref}
                  onChange={e => setDraft(prev => ({ ...prev, ref: e.target.value }))}
                />
              </div>
              <div className="ap-field">
                <label htmlFor="ap-version">版本号</label>
                <input
                  id="ap-version"
                  className="ap-input"
                  placeholder="替换 {{version}}，如 0.0.28"
                  value={draft.version}
                  onChange={e => setDraft(prev => ({ ...prev, version: e.target.value }))}
                />
              </div>
              <div className="ap-field">
                <label htmlFor="ap-npm">npm 包</label>
                <input
                  id="ap-npm"
                  className="ap-input"
                  placeholder="用于检查新版本"
                  value={draft.npmPackage}
                  onChange={e => setDraft(prev => ({ ...prev, npmPackage: e.target.value }))}
                />
              </div>
            </div>
            <div className="ap-field">
              <label htmlFor="ap-desc">备注</label>
              <input
                id="ap-desc"
                className="ap-input"
                value={draft.description}
                onChange={e => setDraft(prev => ({ ...prev, description: e.target.value }))}
              />
            </div>
            {!showCommandsInMain && (
              <>
                <h4>自定义命令</h4>
                {commandFields}
              </>
            )}
          </details>

          <div className="ap-editor-footer">
            <Button variant="outline" disabled={busy} onClick={closeEditor}>取消</Button>
            <Button variant="outline" disabled={busy || blockedTargets.length > 0} onClick={() => void submitEditor({ installNow: false })}>{busyLabel('editor:save', '仅保存', '保存中…')}</Button>
            <Button variant="outline" disabled={busy || blockedTargets.length > 0} onClick={() => void submitEditor({ installNow: true, dryRun: true })}>{busyLabel('editor:preview', '保存并预览', '预览中…')}</Button>
            <Button variant="outline" disabled={busy || blockedTargets.length > 0} onClick={() => void submitEditor({ installNow: true, dryRun: false })}>{busyLabel('editor:install', '保存并安装', '安装中…')}</Button>
          </div>
        </section>
    ) : null;

  const local = state?.local;
  const unmanagedFor = { skills: local?.unmanaged.skills ?? [], mcp: local?.unmanaged.mcp ?? [], plugins: local?.unmanaged.plugins ?? [] };
  const ownedFor = { skills: local?.owned.skills ?? [], mcp: local?.owned.mcp ?? [], plugins: local?.owned.plugins ?? [] };
  const warningsFor = area => (local?.warnings ?? []).filter(item => item.area === area);

  const renderConfirm = rowKey => (confirm?.rowKey === rowKey ? (
    <div className="ap-confirm" role="group" aria-label={confirm.button}>
      <p>{confirm.text}</p>
      <div className="ap-actions">
        <Button variant="outline" disabled={busy} autoFocus onClick={() => setConfirm(null)}>取消</Button>
        <Button
          variant="outline"
          style={{ color: 'var(--ap-error)', borderColor: 'color-mix(in srgb, var(--ap-error) 55%, transparent)' }}
          disabled={busy}
          onClick={() => {
            const { run } = confirm;
            setConfirm(null);
            void run();
          }}
        >
          {confirm.button}
        </Button>
      </div>
    </div>
  ) : null);

  const versionBadge = (pkg, ver) => (ver.hasUpdate ? (
    <span className="ap-badge ap-badge-update" title={`当前 ${ver.currentLabel || '未锁定'}，远端最新 ${ver.latestLabel}`}>
      {ver.currentLabel ? `${ver.currentLabel} → ${ver.latestLabel}` : `可升级 → ${ver.latestLabel}`}
    </span>
  ) : ver.currentLabel ? (
    <span
      className={`ap-badge ${ver.mixedVersions ? 'ap-badge-update' : 'ap-badge-ver'}`}
      title={ver.mixedVersions ? '各端已装版本不一致，升级可对齐' : ver.isUpToDate ? `已是最新（上次检查：${new Date(pkg.lock.checkedAt).toLocaleString()}）` : `当前版本：${ver.currentLabel}`}
    >
      {ver.currentLabel}{ver.isUpToDate ? ' · 最新' : ''}
    </span>
  ) : pkg.repo ? <span className="ap-badge">未锁定</span> : null);

  const packageCells = pkg => HARNESS_IDS.map(h => {
    const hs = pkg.harnessStatuses[h] || { status: 'unselected', selected: false };
    const verText = formatHarnessVersion(hs);
    const on = hs.selected || hs.status === 'installed';
    return {
      harnessId: h,
      on,
      status: hs.selected ? (hs.status === 'unselected' ? 'not-installed' : hs.status) : (hs.status === 'installed' ? 'installed' : 'unselected'),
      label: [
        `${HARNESS_META[h].label}：${on ? statusLabel(hs.status) : '未启用'}`,
        hs.status === 'installed' && verText ? verText : '',
        hs.lastError ? `错误：${hs.lastError}` : '',
      ].filter(Boolean).join(' · '),
      disabledReason: on ? '' : unsupportedReason(pkg, h),
      busy: pendingKey === `toggle:${pkg.id}:${h}`,
      onToggle: next => togglePackageHarness(pkg, h, next),
    };
  });

  const skillGroupCells = pkg => HARNESS_IDS.map(h => {
    const items = pkg.skillItems ?? [];
    const scope = pkg.skills.include.length ? items.filter(item => pkg.skills.include.includes(item.name)) : items;
    const enabledCount = items.filter(item => item.harnesses[h].enabled).length;
    const scopeEnabled = scope.filter(item => item.harnesses[h].enabled).length;
    const installedCount = items.filter(item => item.harnesses[h].status === 'installed').length;
    const failed = items.some(item => item.harnesses[h].status === 'failed');
    return {
      harnessId: h,
      on: enabledCount > 0,
      text: `${installedCount}/${items.length}`,
      status: failed ? 'failed' : 'installed',
      label: `${HARNESS_META[h].label}：已装 ${installedCount} / 共 ${items.length} 个 Skill${failed ? '，有失败' : ''}`,
      hint: scopeEnabled < scope.length ? `点击开启全部${pkg.skills.include.length ? `（include 内 ${scope.length} 个）` : ''}` : '点击关闭全部',
      disabledReason: items.length ? '' : '尚未发现 Skill，先安装一次',
      busy: pendingKey === `skill:${pkg.id}:*:${h}`,
      // 范围内未全开时点击 = 全部开启；已全开时点击 = 全部关闭（先确认）
      onToggle: () => toggleSkill(pkg, null, h, scopeEnabled < scope.length),
    };
  });

  const renderMoreMenu = (pkg, ver) => {
    const menuOpen = openMenuId === pkg.id;
    const needsInstall = pkg.targets.some(h => ['not-installed', 'uninstalled', 'failed'].includes(pkg.harnessStatuses[h]?.status));
    const installedHarnesses = HARNESS_IDS.filter(h => pkg.harnessStatuses[h]?.status === 'installed');
    const installedText = installedHarnesses.map(h => HARNESS_META[h].label).join('、');
    const run = (payload, key) => {
      setOpenMenuId('');
      void runAction(payload, { key: key ? `${key}:${pkg.id}` : '' });
    };
    return (
      <div className="ap-menu-wrap">
        <Button
          variant="outline"
          disabled={busy}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`${pkg.name} 更多操作`}
          onClick={() => setOpenMenuId(menuOpen ? '' : pkg.id)}
        >
          更多 ▾
        </Button>
        {menuOpen && (
          <div className="ap-menu-pop" role="menu" aria-label={`${pkg.name} 操作菜单`}>
            <button type="button" role="menuitem" className="ap-menu-item" onClick={() => openEditEditor(pkg)}>编辑</button>
            {pkg.repo && (
              <button type="button" role="menuitem" className="ap-menu-item" onClick={() => run({ type: 'packages.checkUpdates', ids: [pkg.id] }, 'packages.checkUpdates')}>检查更新</button>
            )}
            {needsInstall && ver.hasUpdate && (
              <button type="button" role="menuitem" className="ap-menu-item" onClick={() => run({ type: 'package.upgrade', id: pkg.id }, 'package.upgrade')}>
                升级到 {ver.latestLabel}
              </button>
            )}
            {!needsInstall && pkg.targets.length > 0 && (
              <button type="button" role="menuitem" className="ap-menu-item" onClick={() => run({ type: 'package.install', id: pkg.id }, 'package.install')}>重新同步</button>
            )}
            <button type="button" role="menuitem" className="ap-menu-item" onClick={() => run({ type: 'package.install', id: pkg.id, dryRun: true })}>预览变更</button>
            <hr className="ap-menu-sep" />
            {installedHarnesses.length > 0 ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="ap-menu-item"
                  onClick={() => askConfirm(pkg.id, `将从 ${installedText} 删除「${pkg.name}」的已装内容，清单中保留配置，之后可用开关重新安装。`, '确认卸载', () => runAction({ type: 'package.uninstall', id: pkg.id }, { key: `package.uninstall:${pkg.id}` }))}
                >
                  仅从各端卸载
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="ap-menu-item"
                  onClick={() => askConfirm(pkg.id, `将从清单移除「${pkg.name}」；${installedText} 上的已装内容保持不变，之后会出现在「本机未纳管」里。`, '确认移除', () => runAction({ type: 'package.delete', id: pkg.id, uninstallFirst: false }, { key: `package.delete:${pkg.id}` }))}
                >
                  仅从清单移除
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="ap-menu-item ap-menu-danger"
                  onClick={() => askConfirm(pkg.id, `将从 ${installedText} 删除「${pkg.name}」的已装内容，并从清单移除这条记录。`, '确认卸载并移除', () => runAction({ type: 'package.delete', id: pkg.id, uninstallFirst: true }, { key: `package.delete:${pkg.id}` }))}
                >
                  卸载并移除
                </button>
              </>
            ) : (
              <button
                type="button"
                role="menuitem"
                className="ap-menu-item ap-menu-danger"
                onClick={() => askConfirm(pkg.id, `将从清单移除「${pkg.name}」。`, '确认移除', () => runAction({ type: 'package.delete', id: pkg.id, uninstallFirst: false }, { key: `package.delete:${pkg.id}` }))}
              >
                从清单移除
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderDetail = (pkg, detailId) => {
    const showId = pkg.id.replace(/[^a-z0-9]/gi, '').toLowerCase() !== pkg.name.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const visibleHarnesses = HARNESS_IDS.filter(h => pkg.harnessStatuses[h]?.selected || pkg.harnessStatuses[h]?.status !== 'unselected');
    return (
      <div id={detailId} className="ap-row-detail">
        <div className="ap-pkg-meta">
          {pkg.repo && (isHttpUrl(pkg.repo)
            ? <a href={pkg.repo} target="_blank" rel="noreferrer">{pkg.repo.replace(/^https:\/\/github\.com\//, '')}</a>
            : <span className="ap-meta-path" title={pkg.repo}>{pkg.repo}</span>)}
          {!pkg.repo && <span>本机纳管，无远端来源</span>}
          {showId && <span>ID: <code>{pkg.id}</code></span>}
          {pkg.npmPackage && <span>npm: <code>{pkg.npmPackage}</code></span>}
          {pkg.kind === 'mcp' && <span>Server：<code>{pkg.mcp.serverName}</code></span>}
        </div>
        {pkg.description && <p className="ap-pkg-desc">{pkg.description}</p>}
        {pkg.kind !== 'skills-repo' && visibleHarnesses.length > 0 && (
          <ul className="ap-mini-list ap-detail-harness">
            {visibleHarnesses.map(h => {
              const hs = pkg.harnessStatuses[h];
              const verText = formatHarnessVersion(hs);
              return (
                <li key={h}>
                  <span className="ap-detail-name"><Glyph status={hs.selected ? hs.status : 'uninstalled'} />{HARNESS_META[h].label}</span>
                  <span className="ap-detail-state">
                    {statusLabel(hs.status)}
                    {hs.status === 'installed' && verText ? <code> {verText}</code> : null}
                    {hs.selected && hs.method === 'command' ? ' · 自定义命令' : ''}
                    {hs.lastError ? <span className="ap-detail-error">{hs.lastError}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  };

  // 包行（MCP / 插件）与 Skills 来源的组头共用
  const renderPackageRow = ({ pkg, ver, attention }) => {
    if (editingInline && pkg.id === editingOriginalId) return editorPanel;
    const isSkills = pkg.kind === 'skills-repo';
    const isOpen = Boolean(expanded[pkg.id]);
    const rowBusy = busy && pendingKey.endsWith(`:${pkg.id}`) || pendingKey.startsWith(`toggle:${pkg.id}:`) || pendingKey.startsWith(`skill:${pkg.id}:`);
    const detailId = `ap-detail-${pkg.id}`;
    const actionPayload = act => (act.type === 'packages.checkUpdates' ? { type: act.type, ids: [pkg.id] } : { type: act.type, id: pkg.id });
    return (
      <Fragment key={pkg.id}>
        <article
          className={`ap-matrix-row ap-pkg-card ${isSkills ? 'ap-skill-group' : ''} ${attention ? `is-${attention.level}` : ''} ${rowBusy ? 'is-busy' : ''}`.trim()}
          aria-busy={rowBusy || undefined}
        >
          <div className="ap-row-main">
            <div className="ap-pkg-title-row">
              <button
                type="button"
                className="ap-row-toggle"
                aria-expanded={isOpen}
                aria-controls={detailId}
                onClick={() => setExpanded(prev => ({ ...prev, [pkg.id]: !prev[pkg.id] }))}
              >
                <svg className="ap-row-chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                  <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="ap-pkg-title" title={pkg.name}>{pkg.name}</span>
              </button>
              {!isSkills && <span className="ap-badge ap-badge-kind">{kindLabel(pkg.kind)}</span>}
              {versionBadge(pkg, ver)}
            </div>
          </div>
          {isSkills
            ? <ToggleCells cells={skillGroupCells(pkg)} ariaLabel={`${pkg.name} 各端 Skill 数量`} disabled={busy} />
            : <ToggleCells cells={packageCells(pkg)} ariaLabel={`${pkg.name} 各端开关`} disabled={busy} />}
          <div className="ap-pkg-actions">
            {attention?.action && (
              <Button variant="outline" disabled={busy} onClick={() => void runAction(actionPayload(attention.action), { key: `${attention.action.type}:${pkg.id}` })}>
                {busyLabel(`${attention.action.type}:${pkg.id}`, attention.action.label, attention.action.busy)}
              </Button>
            )}
            {renderMoreMenu(pkg, ver)}
          </div>
          {attention?.reason && <p className={`ap-row-reason is-${attention.level}`}>{attention.reason}</p>}
          {renderConfirm(pkg.id)}
          {isOpen && renderDetail(pkg, detailId)}
        </article>
        {isSkills && isOpen && (pkg.skillItems ?? []).filter(item => !needle || item.name.toLowerCase().includes(needle) || matchesSearchPkgOnly(pkg)).map(item => (
          <div key={`${pkg.id}:${item.name}`} className="ap-matrix-row ap-skill-row">
            <div className="ap-row-main"><span className="ap-skill-name" title={item.name}>{item.name}</span></div>
            <ToggleCells
              ariaLabel={`${item.name} 各端开关`}
              disabled={busy}
              cells={HARNESS_IDS.map(h => {
                const entry = item.harnesses[h];
                return {
                  harnessId: h,
                  on: entry.enabled,
                  status: entry.status,
                  label: `${HARNESS_META[h].label}：${entry.status === 'installed' ? '已安装' : entry.status === 'failed' ? `安装失败${entry.lastError ? `：${entry.lastError}` : ''}` : entry.enabled ? '待安装' : '未启用'}`,
                  disabledReason: '',
                  busy: pendingKey === `skill:${pkg.id}:${item.name}:${h}`,
                  onToggle: next => toggleSkill(pkg, item.name, h, next),
                };
              })}
            />
            <span />
            {renderConfirm(`${pkg.id}:${item.name}`)}
          </div>
        ))}
        {isSkills && isOpen && !(pkg.skillItems ?? []).length && (
          <p className="ap-matrix-empty">还没有发现 Skill：用「更多 → 重新同步」拉取仓库后显示。</p>
        )}
        {isSkills && renderConfirm(`${pkg.id}:*`) && (
          <div className="ap-matrix-row ap-confirm-row">{renderConfirm(`${pkg.id}:*`)}</div>
        )}
      </Fragment>
    );
  };

  function matchesSearchPkgOnly(pkg) {
    return !needle || [pkg.name, pkg.id, pkg.repo, pkg.description].some(text => String(text || '').toLowerCase().includes(needle));
  }

  // 本机未纳管：中性色实心点表示该端存在，行末「纳管」只登记不改文件
  const renderUnmanaged = (area, items) => items.map(item => (
    <div key={`${area}:${item.key || item.name}`} className="ap-matrix-row ap-unmanaged-row">
      <div className="ap-row-main">
        <span className="ap-skill-name" title={item.key || item.name}>{area === 'plugins' && item.marketplace ? `${item.name}@${item.marketplace}` : item.name}</span>
      </div>
      <MatrixCells
        ariaLabel={`${item.name} 本机分布`}
        cells={HARNESS_IDS.map(h => ({
          harnessId: h,
          status: item.harnesses[h] ? 'unmanaged' : 'none',
          label: `${HARNESS_META[h].label}：${item.harnesses[h] ? `本机存在${item.harnesses[h].version ? ` ${item.harnesses[h].version}` : ''}` : '未配置'}`,
        }))}
      />
      <div className="ap-pkg-actions">
        <Button variant="outline" disabled={busy} onClick={() => adopt(area === 'skills' ? 'skill' : area === 'plugins' ? 'plugin' : 'mcp', item.key || item.name)}>
          {busyLabel(`adopt:${area === 'skills' ? 'skill' : area === 'plugins' ? 'plugin' : 'mcp'}:${item.key || item.name}`, '纳管', '纳管中…')}
        </Button>
      </div>
    </div>
  ));

  const renderLocalNotes = area => {
    const owned = ownedFor[area];
    const warnings = warningsFor(area);
    const builtin = area === 'plugins' ? (local?.builtinPluginCount ?? 0) : 0;
    if (!owned.length && !warnings.length && !builtin) return null;
    return (
      <div className="ap-local-notes">
        {owned.length > 0 && (
          <p className="ap-help">
            另有 {owned.length} 项由插件或 CLI 工具管理，不单独纳管：{owned.map(item => `${item.name}（${item.ownedBy}）`).join('、')}
          </p>
        )}
        {builtin > 0 && <p className="ap-help">Codex 内置插件 {builtin} 个，随 Codex 安装，未列出。</p>}
        {warnings.length > 0 && (
          <ul className="ap-mini-list ap-warning-list" aria-label="诊断提示">
            {warnings.map((item, idx) => (
              <li key={idx}>
                <span>
                  <span className="ap-badge ap-badge-update" style={{ marginRight: 8 }}>{HARNESS_META[item.harness]?.label || item.harness}</span>
                  {item.message}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  const renderPackagesTab = () => {
    const unmanaged = unmanagedFor[tab].filter(item => !needle || item.name.toLowerCase().includes(needle));
    const hasRows = filteredItems.length > 0;
    return (
      <>
        {!editingInline && editorTab === tab && editorPanel}
        {!hasRows && !unmanaged.length ? (
          <div className="ap-empty">
            <p>
              {needle
                ? '没有符合搜索条件的条目。'
                : tab === 'skills' ? '还没有纳管任何 Skills。粘贴 GitHub 地址添加来源，或纳管本机已有的 Skill。'
                  : tab === 'mcp' ? '还没有纳管任何 MCP Server。添加一个，或纳管本机已有的配置。'
                    : '还没有纳管任何插件或 CLI 工具。粘贴 GitHub 地址添加，已装的插件不会重复安装。'}
            </p>
            <div className="ap-actions" style={{ justifyContent: 'center' }}>
              {needle
                ? <Button variant="outline" onClick={() => setSearch('')}>清除搜索</Button>
                : <Button variant="outline" onClick={() => openNewEditor(currentTab.addKind)}>{currentTab.addLabel}</Button>}
            </div>
          </div>
        ) : (
          <div className="ap-list ap-matrix">
            {hasRows && <MatrixGroup title="已纳管" count={filteredItems.length} labels />}
            {filteredItems.map(renderPackageRow)}
            {unmanaged.length > 0 && <MatrixGroup title="本机未纳管" count={unmanaged.length} labels={!hasRows} />}
            {renderUnmanaged(tab, unmanaged)}
          </div>
        )}
        {renderLocalNotes(tab)}
      </>
    );
  };

  const fileStatusGlyph = status => (status === 'synced' ? 'installed'
    : status === 'error' ? 'failed'
      : status === 'empty' ? 'unselected'
        : 'not-installed');

  const renderRulesTab = () => {
    const instructions = state.instructions;
    const files = instructions.harnesses;
    const pendingHarnesses = HARNESS_IDS.filter(h => ['modified', 'missing', 'symlink'].includes(files[h].status));
    const adoptable = HARNESS_IDS.filter(h => files[h].exists && files[h].currentLength > 0 && ['empty', 'modified'].includes(files[h].status));
    const activePreview = HARNESS_IDS.includes(previewHarness) ? previewHarness : HARNESS_IDS[0];
    const renderEditor = (id, snippet) => {
      const d = ruleDrafts[id] ?? {};
      const title = d.title ?? snippet?.title ?? '';
      const content = d.content ?? snippet?.content ?? '';
      return (
        <div className="ap-rule-editor">
          <div className="ap-field">
            <label htmlFor={`ap-rule-title-${id}`}>标题</label>
            <input id={`ap-rule-title-${id}`} className="ap-input" placeholder="如「全局协作规则」" value={title} onChange={e => updateRuleDraft(id, { title: e.target.value, content })} />
          </div>
          <div className="ap-field">
            <label htmlFor={`ap-rule-content-${id}`}>正文</label>
            <textarea id={`ap-rule-content-${id}`} className="ap-textarea ap-instr-editor" placeholder="Markdown 规则正文" value={content} onChange={e => updateRuleDraft(id, { title, content: e.target.value })} />
          </div>
          <div className="ap-actions ap-rule-editor-actions">
            <Button variant="outline" disabled={busy} onClick={() => {
              discardRuleDraft(id);
              if (id !== '__new__') setExpanded(prev => ({ ...prev, [`rule:${id}`]: false }));
            }}>取消</Button>
            <Button variant="outline" disabled={busy || !ruleDrafts[id] || !title.trim()} onClick={() => saveRuleDraft(id)}>
              {busyLabel(`rule-save:${id}`, id === '__new__' ? '添加片段' : '保存片段', '保存中…')}
            </Button>
          </div>
        </div>
      );
    };
    return (
      <>
        <div className="ap-list ap-matrix">
          <MatrixGroup title="规则片段" count={snippets.length} labels />
          {ruleDrafts.__new__ && (
            <div className="ap-matrix-row ap-rule-new">{renderEditor('__new__', null)}</div>
          )}
          {!snippets.length && !ruleDrafts.__new__ && (
            <p className="ap-matrix-empty">还没有规则片段。新建一个，或把本机现有的指令文件纳管为片段。</p>
          )}
          {snippets.map((snippet, index) => {
            const isOpen = Boolean(expanded[`rule:${snippet.id}`]) || Boolean(ruleDrafts[snippet.id]);
            const lines = snippet.content.trim() ? snippet.content.trimEnd().split('\n').length : 0;
            return (
              <article key={snippet.id} className={`ap-matrix-row ap-pkg-card ap-rule-row ${ruleDrafts[snippet.id] ? 'is-dirty' : ''}`.trim()}>
                <div className="ap-row-main">
                  <div className="ap-pkg-title-row">
                    <button
                      type="button"
                      className="ap-row-toggle"
                      aria-expanded={isOpen}
                      onClick={() => setExpanded(prev => ({ ...prev, [`rule:${snippet.id}`]: !isOpen }))}
                    >
                      <svg className="ap-row-chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                        <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span className="ap-pkg-title" title={snippet.title}>{snippet.title}</span>
                    </button>
                    <span className="ap-badge">{lines} 行</span>
                    {ruleDrafts[snippet.id] && <span className="ap-badge ap-badge-update">未保存</span>}
                  </div>
                </div>
                <ToggleCells
                  ariaLabel={`${snippet.title} 写入的端`}
                  disabled={busy}
                  cells={HARNESS_IDS.map(h => ({
                    harnessId: h,
                    on: snippet.harnesses.includes(h),
                    status: snippet.harnesses.includes(h) ? 'installed' : 'unselected',
                    label: `${HARNESS_META[h].label}：${snippet.harnesses.includes(h) ? '写入' : '不写入'}`,
                    disabledReason: '',
                    busy: pendingKey === `rule:${snippet.id}:${h}`,
                    onToggle: next => toggleSnippet(snippet, h, next),
                  }))}
                />
                <div className="ap-pkg-actions ap-rule-actions">
                  <Button variant="outline" disabled={busy || index === 0} aria-label={`上移 ${snippet.title}`} onClick={() => moveSnippet(snippet, -1)}>↑</Button>
                  <Button variant="outline" disabled={busy || index === snippets.length - 1} aria-label={`下移 ${snippet.title}`} onClick={() => moveSnippet(snippet, 1)}>↓</Button>
                  <Button variant="outline" disabled={busy} aria-label={`删除 ${snippet.title}`} onClick={() => deleteSnippet(snippet)}>删除</Button>
                </div>
                {renderConfirm(`rule:${snippet.id}`)}
                {isOpen && <div className="ap-row-detail">{renderEditor(snippet.id, snippet)}</div>}
              </article>
            );
          })}

          <MatrixGroup title="各端文件">
            {pendingHarnesses.length > 0 && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => askConfirm(
                  'rules-files',
                  `将按片段重写 ${pendingHarnesses.map(h => `${files[h].label} 的 ${files[h].fileName}`).join('、')}，覆盖其中的外部修改。`,
                  '确认同步',
                  () => runAction({ type: 'rules.sync', harnesses: pendingHarnesses }, { key: 'rules.sync' }),
                )}
              >
                {busyLabel('rules.sync', `同步（${pendingHarnesses.length}）`, '同步中…')}
              </Button>
            )}
          </MatrixGroup>
          <div className="ap-matrix-row">
            <div className="ap-row-main"><span>写入状态</span></div>
            <MatrixCells
              ariaLabel="各端文件状态"
              cells={HARNESS_IDS.map(h => ({
                harnessId: h,
                status: fileStatusGlyph(files[h].status),
                label: `${files[h].label} ${files[h].fileName}：${instructionStatusLabel(files[h].status)}${files[h].isSymlink ? '（软链，同步时拆分为独立文件）' : ''}`,
              }))}
            />
            <span />
            {renderConfirm('rules-files')}
          </div>

          {adoptable.length > 0 && <MatrixGroup title="本机未纳管" count={adoptable.length} />}
          {adoptable.map(h => (
            <div key={`rule-file:${h}`} className="ap-matrix-row ap-unmanaged-row">
              <div className="ap-row-main">
                <span className="ap-skill-name">{files[h].label} · {files[h].fileName}</span>
                <span className="ap-help ap-unmanaged-note">{files[h].status === 'modified' ? '与片段拼接结果不一致' : '没有对应片段'}</span>
              </div>
              <MatrixCells
                ariaLabel={`${files[h].label} 指令文件`}
                cells={HARNESS_IDS.map(x => ({ harnessId: x, status: x === h ? 'unmanaged' : 'none', label: `${HARNESS_META[x].label}：${x === h ? '本机文件' : '—'}` }))}
              />
              <div className="ap-pkg-actions">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => askConfirm(
                    `rule-adopt:${h}`,
                    `将把 ${files[h].targetFile} 全文导入为只对 ${files[h].label} 开启的新片段，并在 ${files[h].label} 上关闭其他片段，文件内容保持不变。${files[h].isSymlink ? `该文件是指向 ${files[h].symlinkTarget} 的软链，写入时会拆分为独立文件，原链接目标不受影响。` : ''}`,
                    '确认纳管',
                    () => adoptRuleFile(h),
                  )}
                >
                  {busyLabel(`adopt:rules:${h}`, '纳管', '纳管中…')}
                </Button>
              </div>
              {renderConfirm(`rule-adopt:${h}`)}
            </div>
          ))}
        </div>

        <details className="ap-section ap-advanced ap-rule-preview">
          <summary>
            最终写入预览
            <span className="ap-help">{files[activePreview].label} · {files[activePreview].fileName}</span>
          </summary>
          <div className="ap-rule-preview-head">
            <Select
              id="ap-rule-preview-harness"
              ariaLabel="预览的端"
              className="ap-instr-harness-select"
              value={activePreview}
              options={HARNESS_IDS.map(h => ({ value: h, label: files[h].label, meta: instructionStatusLabel(files[h].status) }))}
              onChange={setPreviewHarness}
            />
            <code className="ap-instr-path" title="目标文件">{files[activePreview].targetFile}</code>
          </div>
          {files[activePreview].composedContent
            ? <pre className="ap-instr-preview">{files[activePreview].composedContent}</pre>
            : <p className="ap-help">该端没有开启的片段，同步时跳过写入，不会清空现有文件。</p>}
        </details>
      </>
    );
  };

  return (
    <main className="ap" aria-label="Skills、MCP、插件与规则统一管理">
      <style>{styles}</style>

      {state && (
        <nav className="ap-tabs" aria-label="管理视图">
          <div className="ap-tablist" role="tablist" aria-label="管理视图">
            {TABS.map(item => (
              <button key={item.id} type="button" role="tab" className="ap-tab" aria-selected={tab === item.id} onClick={() => switchTab(item.id)}>
                {item.label}
                <span className="ap-tab-count">{tabCount(item.id)}</span>
                {item.id === 'rules' && rulesDirty && <span className="ap-tab-dot" title="有未保存修改"><span className="ap-sr-only">（未保存）</span></span>}
              </button>
            ))}
          </div>
        </nav>
      )}

      {error && (
        <div className="ap-banner-error" role="alert">
          <span>{error}</span>
          {!state && <Button variant="outline" onClick={() => setReloadTick(v => v + 1)}>重试</Button>}
        </div>
      )}
      {notice && <div className={`ap-banner-notice ${noticeWarn ? 'is-warn' : ''}`.trim()} role="status">{notice}</div>}

      {!state ? (
        <p className="ap-help" role="status">{error ? '请检查插件后台状态。' : '正在读取清单与本机配置…'}</p>
      ) : (
        <>
          <div className="ap-toolbar">
            {tab !== 'rules' ? (
              <div className="ap-filters">
                <input
                  type="search"
                  aria-label="搜索名称或仓库"
                  className="ap-input ap-search"
                  placeholder="搜索名称或仓库"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
            ) : (
              <span className="ap-help ap-toolbar-note">各端文件 = 开启的片段按顺序拼接</span>
            )}
            <div className="ap-actions ap-toolbar-actions">
              {tab !== 'rules' && state.summary.outdated > 0 && (
                <Button variant="outline" disabled={busy} onClick={() => void runAction({ type: 'packages.upgradeAll', dryRun: false }, { key: 'packages.upgradeAll' })}>
                  {busyLabel('packages.upgradeAll', `全部升级（${state.summary.outdated}）`, '升级中…')}
                </Button>
              )}
              {tab !== 'rules' && needsGlobalSync && (
                <Button variant="outline" disabled={busy} onClick={() => void runAction({ type: 'packages.syncAll', dryRun: false }, { key: 'packages.syncAll' })}>
                  {busyLabel('packages.syncAll', '全部同步', '同步中…')}
                </Button>
              )}
              {tab !== 'rules' && tabPackages.some(item => item.pkg.repo) && (
                <Button variant="outline" disabled={busy} onClick={() => void runAction({ type: 'packages.checkUpdates', ids: tabPackages.filter(item => item.pkg.repo).map(item => item.pkg.id) }, { key: 'packages.checkUpdates:all' })}>
                  {busyLabel('packages.checkUpdates:all', '检查更新', '检查中…')}
                </Button>
              )}
              {tab !== 'rules' ? (
                <Button
                  variant="outline"
                  disabled={busy || (editorOpen && !editingOriginalId)}
                  title={editorOpen && !editingOriginalId && editorTab !== tab ? `「${TABS.find(item => item.id === editorTab)?.label}」视图里还有未完成的添加面板` : undefined}
                  onClick={() => openNewEditor(currentTab.addKind)}
                >
                  {currentTab.addLabel}
                </Button>
              ) : (
                <Button variant="outline" disabled={busy || Boolean(ruleDrafts.__new__)} onClick={() => updateRuleDraft('__new__', { title: '', content: '' })}>
                  新建片段
                </Button>
              )}
            </div>
          </div>

          {tab === 'rules' ? renderRulesTab() : renderPackagesTab()}

          {log?.tab === tab && <LogPanel log={log} onClear={() => setLog(null)} />}

          <details className="ap-footer-paths">
            <summary>配置与本机路径</summary>
            <div>
              <span>清单文件：<code>{state.manifestFile}</code></span>
              <span>锁文件：<code>{state.lockFile}</code></span>
              {state.instructions?.snippetsFile && <span>规则片段：<code>{state.instructions.snippetsFile}</code></span>}
              {HARNESS_IDS.map(h => (
                <span key={h}>
                  {HARNESS_META[h].label}：Skills <code>{local?.harnesses[h]?.skillsDir}</code>
                  {local?.harnesses[h]?.mcpFile ? <> · MCP <code>{local.harnesses[h].mcpFile}</code></> : null}
                </span>
              ))}
            </div>
          </details>
        </>
      )}
    </main>
  );
}
