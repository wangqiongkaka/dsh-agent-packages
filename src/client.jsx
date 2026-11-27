import { useEffect, useId, useMemo, useRef, useState } from 'react';
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
  composeInstructionContent,
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

function dotClass(status) {
  if (status === 'installed' || status === 'synced') return 'ap-dot ap-dot-installed';
  if (status === 'failed' || status === 'error') return 'ap-dot ap-dot-failed';
  if (status === 'not-installed' || status === 'modified' || status === 'missing' || status === 'symlink') return 'ap-dot ap-dot-pending';
  return 'ap-dot';
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

function instructionsToDraft(instructions) {
  const harnesses = {};
  for (const harnessId of HARNESS_IDS) {
    const entry = instructions?.harnesses?.[harnessId];
    harnesses[harnessId] = {
      enabled: true, // 已取消按端停用：草稿始终启用，保存时恢复历史停用的端
      privateContent: entry?.privateContent ?? '',
    };
  }
  return {
    shared: instructions?.shared ?? '',
    harnesses,
  };
}

function isInstructionsDraftDirty(draft, instructions) {
  if (!instructions) return false;
  if ((draft.shared ?? '') !== (instructions.shared ?? '')) return true;
  for (const harnessId of HARNESS_IDS) {
    const saved = instructions.harnesses?.[harnessId];
    const current = draft.harnesses?.[harnessId];
    if (!saved || !current) continue;
    if ((current.privateContent ?? '') !== (saved.privateContent ?? '')) return true;
  }
  return false;
}

function countLines(text) {
  const raw = String(text ?? '');
  if (!raw) return 0;
  return raw.replace(/\n$/, '').split('\n').length;
}

function stepBadgeClass(status) {
  if (status === 'ok') return 'ap-badge ap-badge-ok';
  if (status === 'error') return 'ap-badge ap-badge-err';
  if (status === 'preview') return 'ap-badge ap-badge-kind';
  return 'ap-badge';
}

const FILTER_KIND_OPTIONS = [
  { value: 'all', label: '全部类型' },
  { value: 'skills-repo', label: 'Skills 仓库' },
  { value: 'plugin', label: '插件（含 Hooks）' },
  { value: 'mcp', label: 'MCP Server' },
  { value: 'installer', label: '自定义安装器' },
];

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

function MatrixHead({ lead = '', tail = '' }) {
  return (
    <div className="ap-matrix-row ap-col-head" aria-hidden="true">
      <span>{lead}</span>
      <div className="ap-cells">
        {HARNESS_IDS.map(h => (
          <span key={h} className="ap-cell" title={HARNESS_META[h].label}>{HARNESS_SHORT[h]}</span>
        ))}
      </div>
      <span>{tail}</span>
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
  const [tab, setTab] = useState('packages');
  const [filterKind, setFilterKind] = useState('all');
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
  const [editingOriginalId, setEditingOriginalId] = useState('');
  const [draft, setDraft] = useState(emptyDraft);
  const [nameTouched, setNameTouched] = useState(false);
  const [evidence, setEvidence] = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [scanReport, setScanReport] = useState(null);
  const [openMenuId, setOpenMenuId] = useState('');

  const [instrDraft, setInstrDraft] = useState(() => instructionsToDraft(null));
  const [instrHarness, setInstrHarness] = useState(HARNESS_IDS[0]);
  const [instrPreviewOpen, setInstrPreviewOpen] = useState(false);
  const instrInitializedRef = useRef(false);

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
        if (!instrInitializedRef.current && data.instructions) {
          instrInitializedRef.current = true;
          setInstrDraft(instructionsToDraft(data.instructions));
        }
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

  function openNewEditor() {
    setOpenMenuId('');
    setEditingOriginalId('');
    setDraft(emptyDraft());
    setNameTouched(false);
    setEvidence(null);
    setShowAdvanced(false);
    setSettingsOpen(false);
    setEditorOpen(true);
    switchTab('packages');
  }

  function openEditEditor(pkg) {
    setOpenMenuId('');
    setEditingOriginalId(pkg.id);
    setDraft(packageToDraft(pkg));
    setEvidence(null);
    setShowAdvanced(false);
    setSettingsOpen(false);
    setConfirm(null);
    setEditorOpen(true);
    switchTab('packages');
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
          if (!dryRun) closeEditor();
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

  const filteredPackages = useMemo(() => {
    const list = state?.packages ?? [];
    const needle = search.trim().toLowerCase();
    return list.filter(pkg => {
      if (filterKind !== 'all' && pkg.kind !== filterKind) return false;
      if (!needle) return true;
      return (
        pkg.name.toLowerCase().includes(needle) ||
        pkg.id.toLowerCase().includes(needle) ||
        pkg.repo.toLowerCase().includes(needle) ||
        pkg.description.toLowerCase().includes(needle)
      );
    });
  }, [state, filterKind, search]);

  const showFilters = (state?.packages.length ?? 0) > 1 || filterKind !== 'all' || Boolean(search.trim());
  const needsGlobalSync = Boolean(state && (state.summary.pendingInstall > 0 || state.summary.failed > 0));
  const instrDirty = isInstructionsDraftDirty(instrDraft, state?.instructions);

  function updateInstrHarness(harnessId, patch) {
    setInstrDraft(prev => ({
      ...prev,
      harnesses: {
        ...prev.harnesses,
        [harnessId]: {
          ...(prev.harnesses[harnessId] || { enabled: true, privateContent: '' }),
          ...patch,
        },
      },
    }));
  }

  async function saveInstructionsAction({ syncNow = false, dryRun = false } = {}) {
    await runAction(
      {
        type: 'instructions.save',
        shared: instrDraft.shared,
        harnesses: instrDraft.harnesses,
        syncNow,
        dryRun,
      },
      {
        key: `instr:${syncNow ? 'sync' : 'save'}`,
        onSuccess: res => {
          if (res.state?.instructions) {
            setInstrDraft(instructionsToDraft(res.state.instructions));
          }
        },
      }
    );
  }

  async function importSharedInstructions(sourceHarness) {
    await runAction(
      {
        type: 'instructions.import',
        harness: sourceHarness,
        target: 'shared',
        save: false,
      },
      {
        onSuccess: res => setInstrDraft(prev => ({ ...prev, shared: res.content ?? '' })),
      }
    );
  }
  const editingInline = Boolean(
    editorOpen && editingOriginalId && filteredPackages.some(pkg => pkg.id === editingOriginalId)
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

  return (
    <main className="ap" aria-label="Skills 与 MCP 统一管理">
      <style>{styles}</style>

      {state && (
        <nav className="ap-tabs" aria-label="管理视图">
          <div className="ap-tablist" role="tablist" aria-label="管理视图">
            <button type="button" role="tab" className="ap-tab" aria-selected={tab === 'packages'} onClick={() => switchTab('packages')}>
              包清单（{state.packages.length}）
            </button>
            <button type="button" role="tab" className="ap-tab" aria-selected={tab === 'instructions'} onClick={() => switchTab('instructions')}>
              全局指令
              {instrDirty && <span className="ap-tab-dot" title="有未保存修改"><span className="ap-sr-only">（未保存）</span></span>}
            </button>
            <button type="button" role="tab" className="ap-tab" aria-selected={tab === 'doctor'} onClick={() => switchTab('doctor')}>
              本机诊断
            </button>
          </div>
        </nav>
      )}

      {error && (
        <div className="ap-banner-error" role="alert">
          <span>{error}</span>
          {!state && (
            <Button variant="outline" onClick={() => setReloadTick(v => v + 1)}>重试</Button>
          )}
        </div>
      )}
      {notice && <div className={`ap-banner-notice ${noticeWarn ? 'is-warn' : ''}`.trim()} role="status">{notice}</div>}

      {!state ? (
        <p className="ap-help" role="status">{error ? '请检查插件后台状态。' : '正在读取包清单与锁文件…'}</p>
      ) : (
        <>
          {tab === 'packages' && (() => {
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

            const decorated = filteredPackages.map(pkg => {
              const ver = summarizePackageVersions(pkg);
              return { pkg, ver, attention: packageAttention(pkg, ver) };
            });
            const attentionRows = decorated.filter(item => item.attention);
            const readyRows = decorated.filter(item => !item.attention);
            const filtering = filterKind !== 'all' || Boolean(search.trim());

            const renderRow = ({ pkg, ver, attention }) => {
              if (editingInline && pkg.id === editingOriginalId) return editorPanel;
              const needsInstall = pkg.targets.some(h => ['not-installed', 'uninstalled', 'failed'].includes(pkg.harnessStatuses[h]?.status));
              const installedHarnesses = HARNESS_IDS.filter(h => pkg.harnessStatuses[h]?.status === 'installed');
              const visibleHarnesses = HARNESS_IDS.filter(h => pkg.harnessStatuses[h]?.selected || pkg.harnessStatuses[h]?.status !== 'unselected');
              const showId = pkg.id.replace(/[^a-z0-9]/gi, '').toLowerCase() !== pkg.name.replace(/[^a-z0-9]/gi, '').toLowerCase();
              const menuOpen = openMenuId === pkg.id;
              const isOpen = Boolean(expanded[pkg.id]);
              const rowBusy = busy && pendingKey.endsWith(`:${pkg.id}`);
              const detailId = `ap-detail-${pkg.id}`;
              const installedText = installedHarnesses.map(h => HARNESS_META[h].label).join('、');
              const pendingConfirm = confirm?.id === pkg.id ? confirm : null;
              const actionPayload = act => (act.type === 'packages.checkUpdates' ? { type: act.type, ids: [pkg.id] } : { type: act.type, id: pkg.id });
              const run = (payload, key) => {
                setOpenMenuId('');
                void runAction(payload, { key: key ? `${key}:${pkg.id}` : '' });
              };
              const ask = mode => {
                setOpenMenuId('');
                setConfirm({ id: pkg.id, mode });
              };
              const confirmCopy = {
                uninstall: { text: `将从 ${installedText} 删除 ${pkg.name} 的已装文件，清单中保留配置，之后可重新安装。`, button: '确认卸载', payload: { type: 'package.uninstall', id: pkg.id } },
                purge: { text: `将从 ${installedText} 删除 ${pkg.name} 的已装文件，并从清单移除这条记录。`, button: '确认卸载并移除', payload: { type: 'package.delete', id: pkg.id, uninstallFirst: true } },
                remove: {
                  text: installedHarnesses.length
                    ? `将从清单移除 ${pkg.name}；${installedText} 上的已装文件保持不变，之后不再受管。`
                    : `将从清单移除 ${pkg.name}。`,
                  button: '确认移除',
                  payload: { type: 'package.delete', id: pkg.id, uninstallFirst: false },
                },
              };
              const cells = HARNESS_IDS.map(h => {
                const hs = pkg.harnessStatuses[h] || { status: 'unselected' };
                const active = hs.selected || hs.status !== 'unselected';
                const verText = formatHarnessVersion(hs);
                return {
                  harnessId: h,
                  status: active ? (hs.status === 'unselected' ? 'not-installed' : hs.status) : 'unselected',
                  muted: !hs.selected && active,
                  label: [
                    `${HARNESS_META[h].label}：${active ? statusLabel(hs.status) : '未启用'}`,
                    verText && hs.status === 'installed' ? verText : '',
                    hs.lastError ? `错误：${hs.lastError}` : '',
                  ].filter(Boolean).join(' · '),
                };
              });

              return (
                <article
                  key={pkg.id}
                  className={`ap-matrix-row ap-pkg-card ${attention ? `is-${attention.level}` : ''} ${rowBusy ? 'is-busy' : ''}`.trim()}
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
                        <span className="ap-pkg-title">{pkg.name}</span>
                      </button>
                      <span className="ap-badge ap-badge-kind">{CARD_KIND_LABELS[pkg.kind] || pkg.kind}</span>
                      {ver.hasUpdate ? (
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
                      ) : (
                        <span className="ap-badge">未锁定</span>
                      )}
                    </div>
                  </div>

                  <MatrixCells cells={cells} ariaLabel={`${pkg.name} 各端状态`} />

                  <div className="ap-pkg-actions">
                    {attention?.action && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => run(actionPayload(attention.action), attention.action.type)}
                      >
                        {busyLabel(`${attention.action.type}:${pkg.id}`, attention.action.label, attention.action.busy)}
                      </Button>
                    )}
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
                          <button type="button" role="menuitem" className="ap-menu-item" onClick={() => run({ type: 'packages.checkUpdates', ids: [pkg.id] }, 'packages.checkUpdates')}>检查更新</button>
                          {needsInstall && ver.hasUpdate && (
                            <button type="button" role="menuitem" className="ap-menu-item" onClick={() => run({ type: 'package.upgrade', id: pkg.id }, 'package.upgrade')}>
                              升级到 {ver.latestLabel}
                            </button>
                          )}
                          {!needsInstall && (
                            <button type="button" role="menuitem" className="ap-menu-item" onClick={() => run({ type: 'package.install', id: pkg.id }, 'package.install')}>重新同步</button>
                          )}
                          <button type="button" role="menuitem" className="ap-menu-item" onClick={() => run({ type: 'package.install', id: pkg.id, dryRun: true })}>预览变更</button>
                          <hr className="ap-menu-sep" />
                          {installedHarnesses.length > 0 ? (
                            <>
                              <button type="button" role="menuitem" className="ap-menu-item" onClick={() => ask('uninstall')}>仅从各端卸载</button>
                              <button type="button" role="menuitem" className="ap-menu-item" onClick={() => ask('remove')}>仅从清单移除</button>
                              <button type="button" role="menuitem" className="ap-menu-item ap-menu-danger" onClick={() => ask('purge')}>卸载并移除</button>
                            </>
                          ) : (
                            <button type="button" role="menuitem" className="ap-menu-item ap-menu-danger" onClick={() => ask('remove')}>从清单移除</button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {attention?.reason && <p className={`ap-row-reason is-${attention.level}`}>{attention.reason}</p>}

                  {pendingConfirm && (
                    <div className="ap-confirm" role="group" aria-label={`确认${confirmCopy[pendingConfirm.mode].button.replace('确认', '')}`}>
                      <p>{confirmCopy[pendingConfirm.mode].text}</p>
                      <div className="ap-actions">
                        <Button variant="outline" disabled={busy} autoFocus onClick={() => setConfirm(null)}>取消</Button>
                        <Button
                          variant="outline"
                          style={{ color: 'var(--ap-error)', borderColor: 'color-mix(in srgb, var(--ap-error) 55%, transparent)' }}
                          disabled={busy}
                          onClick={() => {
                            const { payload } = confirmCopy[pendingConfirm.mode];
                            setConfirm(null);
                            void runAction(payload, { key: `${payload.type}:${pkg.id}` });
                          }}
                        >
                          {confirmCopy[pendingConfirm.mode].button}
                        </Button>
                      </div>
                    </div>
                  )}

                  {isOpen && (
                    <div id={detailId} className="ap-row-detail">
                      <div className="ap-pkg-meta">
                        {pkg.repo && (
                          isHttpUrl(pkg.repo) ? (
                            <a href={pkg.repo} target="_blank" rel="noreferrer">{pkg.repo.replace(/^https:\/\/github\.com\//, '')}</a>
                          ) : (
                            <span className="ap-meta-path" title={pkg.repo}>{pkg.repo}</span>
                          )
                        )}
                        {showId && <span>ID: <code>{pkg.id}</code></span>}
                        {pkg.npmPackage && <span>npm: <code>{pkg.npmPackage}</code></span>}
                      </div>
                      {pkg.description && <p className="ap-pkg-desc">{pkg.description}</p>}
                      {visibleHarnesses.length > 0 ? (
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
                                  {!hs.selected ? ' · 已不在目标端' : ''}
                                  {hs.lastError ? <span className="ap-detail-error">{hs.lastError}</span> : null}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      ) : (
                        <p className="ap-help">未选择目标端。</p>
                      )}
                      <div className="ap-actions">
                        <Button variant="outline" disabled={busy} onClick={() => openEditEditor(pkg)}>编辑配置</Button>
                      </div>
                    </div>
                  )}
                </article>
              );
            };

            return (
              <>
                <div className="ap-toolbar">
                  {showFilters && (
                    <div className="ap-filters">
                      <input
                        type="search"
                        aria-label="搜索包名称或 GitHub 地址"
                        className="ap-input ap-search"
                        placeholder="搜索名称或仓库"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                      />
                      <Select
                        id="ap-filter-kind"
                        ariaLabel="按类型筛选"
                        className="ap-filter-select"
                        value={filterKind}
                        options={FILTER_KIND_OPTIONS}
                        onChange={setFilterKind}
                      />
                    </div>
                  )}
                  <div className="ap-actions ap-toolbar-actions">
                    {state.packages.length > 0 && (
                      <Button variant="outline" disabled={busy} onClick={() => void runAction({ type: 'packages.checkUpdates' }, { key: 'packages.checkUpdates:all' })}>
                        {busyLabel('packages.checkUpdates:all', '检查更新', '检查中…')}
                      </Button>
                    )}
                    <Button variant="outline" disabled={busy || (editorOpen && !editingOriginalId)} onClick={openNewEditor}>添加包</Button>
                  </div>
                </div>

                {!editingInline && editorPanel}

                {filteredPackages.length === 0 ? (
                  <div className="ap-empty">
                    <p>
                      {state.packages.length === 0
                        ? '清单还是空的。填入 GitHub 地址即可添加包；已安装的插件再次添加不会重复安装。'
                        : '没有符合当前筛选条件的包。'}
                    </p>
                    <div className="ap-actions" style={{ justifyContent: 'center' }}>
                      {state.packages.length === 0 ? (
                        <Button variant="outline" onClick={openNewEditor}>添加第一个包</Button>
                      ) : (
                        <Button variant="outline" onClick={() => { setSearch(''); setFilterKind('all'); }}>清除筛选</Button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="ap-list ap-matrix">
                    <MatrixHead />
                    {attentionRows.length > 0 && (
                      <div className="ap-matrix-group is-attention">
                        <h3>需要处理 <span className="ap-group-count">{attentionRows.length}</span></h3>
                        {!filtering && (
                          <div className="ap-actions">
                            {needsGlobalSync && (
                              <Button variant="outline" disabled={busy} onClick={() => void runAction({ type: 'packages.syncAll', dryRun: false }, { key: 'packages.syncAll' })}>
                                {busyLabel('packages.syncAll', '全部同步', '同步中…')}
                              </Button>
                            )}
                            {state.summary.outdated > 0 && (
                              <Button variant="outline" disabled={busy} onClick={() => void runAction({ type: 'packages.upgradeAll', dryRun: false }, { key: 'packages.upgradeAll' })}>
                                {busyLabel('packages.upgradeAll', `全部升级（${state.summary.outdated}）`, '升级中…')}
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    {attentionRows.map(renderRow)}
                    {readyRows.length > 0 && (
                      <div className="ap-matrix-group">
                        <h3>{attentionRows.length > 0 ? '已就绪' : '全部已就绪'} <span className="ap-group-count">{readyRows.length}</span></h3>
                      </div>
                    )}
                    {readyRows.map(renderRow)}
                  </div>
                )}
                {log?.tab === 'packages' && <LogPanel log={log} onClear={() => setLog(null)} />}
              </>
            );
          })()}

          {tab === 'instructions' && state.instructions && (() => {
            const instructions = state.instructions;
            const activeHarness = HARNESS_IDS.includes(instrHarness) ? instrHarness : HARNESS_IDS[0];
            const info = instructions.harnesses[activeHarness];
            const draftEntry = instrDraft.harnesses[activeHarness] || { enabled: true, privateContent: '' };
            const hasAnySource = Boolean(instrDraft.shared.trim() || draftEntry.privateContent.trim());
            const liveComposed = hasAnySource
              ? composeInstructionContent({
                  shared: instrDraft.shared,
                  privateContent: draftEntry.privateContent,
                })
              : '';
            const liveParts = [
              instrDraft.shared.trim() ? '公共内容' : '',
              draftEntry.privateContent.trim() ? '私有内容' : '',
            ].filter(Boolean);

            const importMenuOpen = openMenuId === 'instr-import';
            const activeLabel = HARNESS_META[activeHarness].label;
            const runInstrMenu = action => {
              setOpenMenuId('');
              void action();
            };

            return (
              <section className="ap-instr-stack" aria-label="全局指令文件维护">
                <div className="ap-instr-toolbar">
                  <div className="ap-instr-title">
                    <h3>AGENTS.md / CLAUDE.md</h3>
                    {instrDirty && (
                      <span className="ap-badge ap-badge-update">未保存修改</span>
                    )}
                  </div>
                  <div className="ap-actions">
                    {instrDirty && (
                      <>
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => setInstrDraft(instructionsToDraft(instructions))}
                        >
                          还原
                        </Button>
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => void saveInstructionsAction({ syncNow: false })}
                        >
                          {busyLabel('instr:save', '仅保存', '保存中…')}
                        </Button>
                      </>
                    )}
                    {/* 草稿无修改且各端文件均已同步时无事可做，不显示同步按钮 */}
                    {(instrDirty || instructions.summary.pending > 0) && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        title="写入所有 Harness 的指令文件"
                        onClick={() => void saveInstructionsAction({ syncNow: true, dryRun: false })}
                      >
                        {busyLabel('instr:sync', instrDirty ? '保存并同步' : '同步', '同步中…')}
                      </Button>
                    )}
                  </div>
                </div>

                <article className="ap-card ap-instr-card" aria-label="公共内容">
                  <div className="ap-instr-head">
                    <div className="ap-instr-heading">
                      <h3>公共内容</h3>
                      <span className="ap-instr-sub">所有启用端共享，写在文件开头</span>
                    </div>
                    <div className="ap-menu-wrap">
                      <Button
                        variant="outline"
                        disabled={busy}
                        aria-haspopup="menu"
                        aria-expanded={importMenuOpen}
                        title="用所选端的现有文件替换公共内容"
                        onClick={() => setOpenMenuId(importMenuOpen ? '' : 'instr-import')}
                      >
                        从文件导入 ▾
                      </Button>
                      {importMenuOpen && (
                        <div className="ap-menu-pop ap-instr-menu" role="menu" aria-label="选择导入来源">
                          {HARNESS_IDS.map(harnessId => {
                            const h = instructions.harnesses[harnessId];
                            const importable = Boolean(h?.exists && !h?.brokenSymlink);
                            return (
                              <button
                                key={harnessId}
                                type="button"
                                role="menuitem"
                                className="ap-menu-item"
                                disabled={!importable}
                                onClick={() => runInstrMenu(() => importSharedInstructions(harnessId))}
                              >
                                {HARNESS_META[harnessId].label}
                                <span className="ap-chip-meta">
                                  {h?.brokenSymlink ? '失效软链' : importable ? h.fileName : '未创建'}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                  <label htmlFor="ap-instr-shared" className="ap-sr-only">公共内容</label>
                  <textarea
                    id="ap-instr-shared"
                    className="ap-textarea ap-instr-editor"
                    placeholder="填写所有 Harness 共享的全局规则 Markdown，或从本机现有 AGENTS.md / CLAUDE.md 导入"
                    value={instrDraft.shared}
                    onChange={e => setInstrDraft(prev => ({ ...prev, shared: e.target.value }))}
                  />
                  <span className="ap-instr-sub">共 {countLines(instrDraft.shared)} 行 · {instrDraft.shared.length} 字符</span>
                </article>

                {info && (
                  <article className="ap-card ap-instr-card" aria-label="私有内容">
                    <div className="ap-instr-head">
                      <div className="ap-instr-heading">
                        <h3>私有内容</h3>
                        <span className="ap-instr-sub">只写入所选端，接在公共内容之后</span>
                      </div>
                      <label htmlFor="ap-instr-harness" className="ap-sr-only">选择 Harness</label>
                      <Select
                        id="ap-instr-harness"
                        ariaLabel="选择 Harness"
                        className="ap-instr-harness-select"
                        menuAlign="right"
                        value={activeHarness}
                        options={HARNESS_IDS.map(harnessId => ({
                          value: harnessId,
                          label: HARNESS_META[harnessId].label,
                          meta: `${instructions.harnesses[harnessId].fileName} · ${instructionStatusLabel(instructions.harnesses[harnessId].status)}`,
                        }))}
                        onChange={setInstrHarness}
                      />
                    </div>

                    <code className="ap-instr-path" title="目标文件">{info.targetFile}</code>

                    {info.isSymlink && (
                      <span className="ap-instr-warn-text">
                        当前是软链，指向 <code>{info.symlinkTarget || '未知路径'}</code>；同步时将拆分为独立文件写入，不改动原链接目标
                      </span>
                    )}

                    {info.readError && (
                      <p className="ap-field-error" role="alert">读取目标文件失败：{info.readError}</p>
                    )}

                    <label htmlFor="ap-instr-private" className="ap-sr-only">{activeLabel} 私有内容</label>
                    <textarea
                      id="ap-instr-private"
                      className="ap-textarea ap-instr-editor ap-instr-editor-private"
                      placeholder={`仅对 ${activeLabel} 生效的规则，留空则只写入公共内容`}
                      value={draftEntry.privateContent}
                      onChange={e => updateInstrHarness(activeHarness, { privateContent: e.target.value })}
                    />

                    <details
                      className="ap-section ap-advanced"
                      open={instrPreviewOpen}
                      onToggle={e => setInstrPreviewOpen(e.currentTarget.open)}
                    >
                      <summary>
                        最终写入预览
                        <span className="ap-help">
                          {liveComposed
                            ? `${liveParts.join(' + ')} · 共 ${countLines(liveComposed)} 行`
                            : '内容为空'}
                        </span>
                      </summary>
                      {liveComposed ? (
                        <pre className="ap-instr-preview">{liveComposed}</pre>
                      ) : (
                        <p className="ap-help" style={{ marginTop: 0 }}>
                          公共与私有内容均为空，同步时将跳过写入，不会清空现有文件。
                        </p>
                      )}
                    </details>
                  </article>
                )}
                {log?.tab === 'instructions' && <LogPanel log={log} onClear={() => setLog(null)} />}
              </section>
            );
          })()}

          {tab === 'doctor' && (() => {
            const report = scanReport;
            const harnesses = report?.harnesses || {};
            // 把 4 端的 MCP / 插件按名称并成一张表，一眼看出分布与未纳管项
            const collect = (listOf, keyOf, labelOf) => {
              const rows = new Map();
              for (const h of HARNESS_IDS) {
                for (const item of listOf(harnesses[h]) || []) {
                  const key = keyOf(item);
                  if (!rows.has(key)) rows.set(key, { key, label: labelOf(item), byHarness: {}, managedBy: null, unmanaged: false });
                  const row = rows.get(key);
                  if (labelOf(item).length > row.label.length) row.label = labelOf(item);
                  row.byHarness[h] = item;
                  if (item.managedBy) row.managedBy = item.managedBy;
                  else row.unmanaged = true;
                }
              }
              return [...rows.values()].sort((x, y) => x.key.localeCompare(y.key));
            };
            const mcpRows = collect(h => h?.mcpServers, item => item.serverName, item => item.serverName);
            // Antigravity 插件没有市场名，按插件名合并才能落在同一行；shortcut: 不同市场的同名插件会并成一行，出现时再按 repo 区分
            const pluginRows = collect(h => h?.plugins, item => item.name, item => (item.marketplace ? `${item.name}@${item.marketplace}` : item.name));
            const unmanagedCount = [...mcpRows, ...pluginRows].filter(row => row.unmanaged).length;
            const cellsFor = (row, describe, errorOf) => HARNESS_IDS.map(h => {
              const item = row.byHarness[h];
              const readError = !item && errorOf ? errorOf(h) : '';
              return {
                harnessId: h,
                status: item ? (item.managedBy ? 'managed' : 'unmanaged') : readError ? 'failed' : 'none',
                label: `${HARNESS_META[h].label}：${item ? `${item.managedBy ? '受管' : '未纳管'}${describe(item)}` : readError ? `配置读取失败：${readError}` : '未配置'}`,
              };
            });
            const renderRows = (rows, describe, errorOf) => rows.map(row => (
              <div key={row.key} className="ap-matrix-row">
                <div className="ap-row-main"><code className="ap-doctor-name">{row.label}</code></div>
                <MatrixCells cells={cellsFor(row, describe, errorOf)} ariaLabel={`${row.label} 各端分布`} />
                <span className={`ap-badge ${row.unmanaged ? '' : 'ap-badge-ok'}`}>
                  {row.unmanaged ? (row.managedBy ? '部分未纳管' : '未纳管') : `受管：${row.managedBy}`}
                </span>
              </div>
            ));

            return (
              <section className="ap-doctor" aria-label="本机扫描与诊断">
                <div className="ap-toolbar">
                  <span className="ap-help ap-toolbar-note">
                    {report
                      ? `上次扫描：${new Date(report.scannedAt).toLocaleString()}`
                      : '只读检查本机 4 个 Harness 的 Skills、插件与 MCP 配置，不做任何修改。'}
                  </span>
                  <div className="ap-actions ap-toolbar-actions">
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void runAction({ type: 'local.scan' }, { key: 'local.scan', onSuccess: res => setScanReport(res.report) })}
                    >
                      {busyLabel('local.scan', report ? '重新扫描' : '开始扫描', '扫描中…')}
                    </Button>
                  </div>
                </div>

                {!report ? (
                  <p className="ap-empty" role="status">
                    {busy ? '正在扫描本机 4 个 Harness 配置…' : '尚未扫描。点击「开始扫描」查看各端已装内容与异常。'}
                  </p>
                ) : (
                  <>
                    {report.warnings.length > 0 && (
                      <div className="ap-card ap-doctor-warnings">
                        <h3>诊断提示 <span className="ap-group-count">{report.warnings.length}</span></h3>
                        <ul className="ap-mini-list">
                          {report.warnings.map((item, idx) => (
                            <li key={idx}>
                              <span>
                                <span className="ap-badge ap-badge-update" style={{ marginRight: 8 }}>
                                  {HARNESS_META[item.harness]?.label || item.harness}
                                </span>
                                {item.message}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="ap-list ap-matrix ap-doctor-matrix" aria-label="各端已装内容">
                      <MatrixHead />
                      <div className="ap-matrix-row">
                        <div className="ap-row-main"><span>Skills</span></div>
                        <MatrixCells
                          ariaLabel="各端 Skills 数量"
                          cells={HARNESS_IDS.map(h => ({
                            harnessId: h,
                            text: harnesses[h]?.skillsCount ?? 0,
                            label: `${HARNESS_META[h].label}：${harnesses[h]?.skillsCount ?? 0} 个 Skills`,
                          }))}
                        />
                        <span />
                      </div>
                      <div className="ap-matrix-group">
                        <h3>MCP Servers <span className="ap-group-count">{mcpRows.length}</span></h3>
                      </div>
                      {mcpRows.length ? renderRows(mcpRows, item => `（${item.transport}）`, h => harnesses[h]?.mcpError || '') : <p className="ap-matrix-empty">各端均未配置 MCP Server。</p>}
                      <div className="ap-matrix-group">
                        <h3>已装插件 <span className="ap-group-count">{pluginRows.length}</span></h3>
                      </div>
                      {pluginRows.length ? renderRows(pluginRows, item => (item.version ? ` ${item.version}` : '')) : <p className="ap-matrix-empty">各端均未安装插件。</p>}
                    </div>
                    {unmanagedCount > 0 && (
                      <p className="ap-help">{unmanagedCount} 项不在清单中。需要统一管理时，用「添加包」添加同一来源，已装的插件不会重复安装。</p>
                    )}

                    <details className="ap-section ap-advanced ap-doctor-paths-wrap">
                      <summary>各端本机路径</summary>
                      <div className="ap-doctor-paths">
                        {HARNESS_IDS.filter(h => harnesses[h]).map(h => (
                          <div key={h} className="ap-doctor-path-block">
                            <strong>{HARNESS_META[h].label}</strong>
                            <div className="ap-doctor-path-row"><span className="ap-doctor-path-label">Skills 目录</span><code>{harnesses[h].skillsDir}</code></div>
                            {harnesses[h].mcpFile && <div className="ap-doctor-path-row"><span className="ap-doctor-path-label">MCP 文件</span><code>{harnesses[h].mcpFile}</code></div>}
                            {harnesses[h].instructionsFile && <div className="ap-doctor-path-row"><span className="ap-doctor-path-label">指令文件</span><code>{harnesses[h].instructionsFile}</code></div>}
                          </div>
                        ))}
                      </div>
                    </details>
                  </>
                )}
                {log?.tab === 'doctor' && <LogPanel log={log} onClear={() => setLog(null)} />}
              </section>
            );
          })()}

          <details className="ap-footer-paths">
            <summary>配置文件路径</summary>
            <div>
              <span>清单文件：<code>{state.manifestFile}</code></span>
              <span>锁文件：<code>{state.lockFile}</code></span>
              {state.instructions?.dir && (
                <span>指令目录：<code>{state.instructions.dir}</code></span>
              )}
            </div>
          </details>
        </>
      )}
    </main>
  );
}
