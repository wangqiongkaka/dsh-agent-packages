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
      envRefsText: '',
    },
    plugin: { name: '', marketplace: '', harnesses: [] },
    commands: {},
  };
}

function packageToDraft(pkg) {
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
      envRefsText: Array.isArray(pkg.mcp?.envRefs) ? pkg.mcp.envRefs.join(', ') : '',
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
  const envRefs = draft.mcp.envRefsText
    .split(/[,，\s]+/)
    .map(item => item.trim())
    .filter(Boolean);
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
  if (status === 'installed') return 'ap-dot ap-dot-installed';
  if (status === 'failed') return 'ap-dot ap-dot-failed';
  if (status === 'not-installed') return 'ap-dot ap-dot-pending';
  return 'ap-dot';
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
  { value: 'outdated', label: '仅看可升级' },
  { value: 'pending', label: '仅看待安装' },
  { value: 'failed', label: '仅看失败' },
];

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
  const [logs, setLogs] = useState([]);
  const [reloadTick, setReloadTick] = useState(0);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingOriginalId, setEditingOriginalId] = useState('');
  const [draft, setDraft] = useState(emptyDraft);
  const [nameTouched, setNameTouched] = useState(false);
  const [evidence, setEvidence] = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [scanReport, setScanReport] = useState(null);
  const [doctorHarness, setDoctorHarness] = useState(HARNESS_IDS[0]);
  const [openMenuId, setOpenMenuId] = useState('');

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

  async function runAction(payload, { onSuccess, silentNotice = false } = {}) {
    if (!sessionKey) return;
    setBusy(true);
    setError('');
    if (!silentNotice) setNotice('');
    try {
      const result = await postWithAutoKey(payload);
      if (result.state) setState(result.state);
      if (!silentNotice && result.message) setNotice(result.message);
      if (Array.isArray(result.steps) && result.steps.length) {
        setLogs(result.steps);
      }
      if (onSuccess) onSuccess(result);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
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
      // 解析出的自定义命令会覆盖内置安装方式，展开让用户看到
      if (nextDraft.kind !== 'installer' && Object.keys(nextDraft.commands).length > 0) setShowAdvanced(true);
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
  }

  function openNewEditor() {
    setOpenMenuId('');
    setEditingOriginalId('');
    setDraft(emptyDraft());
    setNameTouched(false);
    setEvidence(null);
    setShowAdvanced(false);
    setEditorOpen(true);
    setTab('packages');
  }

  function openEditEditor(pkg) {
    setOpenMenuId('');
    setEditingOriginalId(pkg.id);
    setDraft(packageToDraft(pkg));
    setEvidence(null);
    setShowAdvanced(pkg.kind !== 'installer' && Object.keys(pkg.commands || {}).length > 0);
    setEditorOpen(true);
    setTab('packages');
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
        onSuccess: () => {
          if (!dryRun) closeEditor();
        },
      }
    );
  }

  // 自定义安装器必填，放在主区；其他类型放进「高级设置」，填写后覆盖内置安装方式
  const showSharedCommands = draft.kind === 'installer' || Boolean(
    draft.commands.shared?.install ||
    draft.commands.shared?.upgrade ||
    draft.commands.shared?.uninstall ||
    draft.commands.shared?.version
  );
  const commandFields = (
    <>
      <p className="ap-help">
        {draft.kind === 'installer' ? '全局命令每次操作只执行一次；勾选端后将依次执行对应端命令。' : '填写后覆盖内置安装方式。'}可用变量 <code>{'{{repo}}'}</code> <code>{'{{ref}}'}</code> <code>{'{{version}}'}</code> <code>{'{{dir}}'}</code>（用到 <code>{'{{dir}}'}</code> 时先检出仓库）
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
      if (filterKind === 'outdated' && !pkg.lock.updateAvailable) return false;
      if (filterKind === 'pending' && !pkg.targets.some(h => ['not-installed', 'uninstalled'].includes(pkg.harnessStatuses[h]?.status))) return false;
      if (filterKind === 'failed' && !pkg.targets.some(h => pkg.harnessStatuses[h]?.status === 'failed')) return false;
      if (['skills-repo', 'plugin', 'mcp', 'installer'].includes(filterKind) && pkg.kind !== filterKind) return false;
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

  function toggleStatusFilter(targetFilter) {
    setFilterKind(prev => (prev === targetFilter ? 'all' : targetFilter));
  }

  return (
    <main className="ap" aria-label="Skills 与 MCP 统一管理">
      <style>{styles}</style>

      <header className="ap-header">
        <div className="ap-title-group">
          <h2>Skills &amp; MCP</h2>
        </div>
        <div className="ap-actions">
          <Button variant="primary" disabled={busy || !state} onClick={openNewEditor}>添加包</Button>
          <Button
            variant="outline"
            disabled={busy || !state}
            onClick={() => (settingsOpen ? setSettingsOpen(false) : openSettingsPanel())}
          >
            解析设置
          </Button>
          {state && state.packages.length > 0 && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void runAction({ type: 'packages.checkUpdates' })}
            >
              检查更新
            </Button>
          )}
          {state && state.summary.outdated > 0 && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void runAction({ type: 'packages.upgradeAll', dryRun: false })}
            >
              全部升级（{state.summary.outdated}）
            </Button>
          )}
          {needsGlobalSync && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void runAction({ type: 'packages.syncAll', dryRun: false })}
            >
              全部同步
            </Button>
          )}
        </div>
      </header>

      {error && (
        <div className="ap-banner-error" role="alert">
          <span>{error}</span>
          {!state && (
            <Button variant="outline" onClick={() => setReloadTick(v => v + 1)}>重试</Button>
          )}
        </div>
      )}
      {notice && <div className="ap-banner-notice" role="status">{notice}</div>}

      {state && settingsOpen && (
        <section className="ap-card ap-settings-card" aria-label="全局解析设置">
          <div className="ap-editor-head">
            <h3>全局解析设置</h3>
            <Button variant="outline" disabled={busy} onClick={() => setSettingsOpen(false)}>收起</Button>
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
            <Button variant="primary" disabled={busy} onClick={() => void saveAnalyzerSettings()}>保存设置</Button>
          </div>
        </section>
      )}

      {!state ? (
        <p className="ap-help" role="status">{error ? '请检查插件后台状态。' : '正在读取包清单与锁文件…'}</p>
      ) : (
        <>
          <div className="ap-tabs">
            <div className="ap-tabs-left">
              <div className="ap-tablist" role="tablist" aria-label="管理视图">
                <button
                  type="button"
                  role="tab"
                  className="ap-tab"
                  aria-selected={tab === 'packages'}
                  onClick={() => setTab('packages')}
                >
                  包清单（{state.packages.length}）
                </button>
                <button
                  type="button"
                  role="tab"
                  className="ap-tab"
                  aria-selected={tab === 'doctor'}
                  onClick={() => {
                    setTab('doctor');
                    if (!scanReport) {
                      void runAction({ type: 'local.scan' }, { onSuccess: res => setScanReport(res.report) });
                    }
                  }}
                >
                  本机诊断
                </button>
              </div>

              {tab === 'packages' && (state.summary.outdated > 0 || state.summary.pendingInstall > 0 || state.summary.failed > 0) && (
                <div className="ap-status-pills" aria-label="待处理状态筛选">
                  {state.summary.outdated > 0 && (
                    <button
                      type="button"
                      className={`ap-status-pill ap-pill-warn ${filterKind === 'outdated' ? 'is-active' : ''}`}
                      aria-pressed={filterKind === 'outdated'}
                      onClick={() => toggleStatusFilter('outdated')}
                    >
                      可升级 {state.summary.outdated}
                    </button>
                  )}
                  {state.summary.pendingInstall > 0 && (
                    <button
                      type="button"
                      className={`ap-status-pill ap-pill-warn ${filterKind === 'pending' ? 'is-active' : ''}`}
                      aria-pressed={filterKind === 'pending'}
                      onClick={() => toggleStatusFilter('pending')}
                    >
                      待安装 {state.summary.pendingInstall}
                    </button>
                  )}
                  {state.summary.failed > 0 && (
                    <button
                      type="button"
                      className={`ap-status-pill ap-pill-error ${filterKind === 'failed' ? 'is-active' : ''}`}
                      aria-pressed={filterKind === 'failed'}
                      onClick={() => toggleStatusFilter('failed')}
                    >
                      失败 {state.summary.failed}
                    </button>
                  )}
                </div>
              )}
            </div>

            {tab === 'packages' && showFilters && (
              <div className="ap-filters">
                <Select
                  id="ap-filter-kind"
                  ariaLabel="按类型筛选"
                  className="ap-filter-select"
                  value={filterKind}
                  options={FILTER_KIND_OPTIONS}
                  onChange={setFilterKind}
                />
                <input
                  type="search"
                  aria-label="搜索包名称或 GitHub 地址"
                  className="ap-input ap-search"
                  placeholder="搜索名称 / 仓库…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
            )}
          </div>

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
                    <button
                      type="button"
                      className="ap-link-btn"
                      disabled={busy || inspecting}
                      onClick={openSettingsPanel}
                    >
                      切换
                    </button>
                  </div>

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
                      <div className="ap-field">
                        <label htmlFor="ap-mcp-env">环境变量</label>
                        <input
                          id="ap-mcp-env"
                          className="ap-input"
                          placeholder="只填变量名，不填密钥，如 FIRECRAWL_API_KEY"
                          value={draft.mcp.envRefsText}
                          onChange={e => setDraft(prev => ({ ...prev, mcp: { ...prev.mcp, envRefsText: e.target.value } }))}
                        />
                      </div>
                    </div>
                  )}

                  {draft.kind === 'installer' && (
                    <div className="ap-section">
                      <h4>安装命令</h4>
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
                    {draft.kind !== 'installer' && (
                      <>
                        <h4>自定义命令</h4>
                        {commandFields}
                      </>
                    )}
                  </details>

                  <div className="ap-editor-footer">
                    <Button variant="outline" disabled={busy} onClick={closeEditor}>取消</Button>
                    <Button variant="outline" disabled={busy || blockedTargets.length > 0} onClick={() => void submitEditor({ installNow: false })}>仅保存</Button>
                    <Button variant="outline" disabled={busy || blockedTargets.length > 0} onClick={() => void submitEditor({ installNow: true, dryRun: true })}>保存并预览</Button>
                    <Button variant="primary" disabled={busy || blockedTargets.length > 0} onClick={() => void submitEditor({ installNow: true, dryRun: false })}>保存并安装</Button>
                  </div>
                </section>
            ) : null;

            return (
              <>
                {!editingInline && editorPanel}

                {filteredPackages.length === 0 ? (
                <div className="ap-empty">
                  <p>
                    {state.packages.length === 0
                      ? '清单还是空的。填入 GitHub 地址即可添加包；已安装的插件再次添加不会重复安装。'
                      : '当前筛选条件下没有匹配的包。'}
                  </p>
                  {state.packages.length === 0 && (
                    <div className="ap-actions" style={{ justifyContent: 'center' }}>
                      <Button variant="primary" onClick={openNewEditor}>添加第一个包</Button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="ap-list">
                  {filteredPackages.map(pkg => {
                    if (editingInline && pkg.id === editingOriginalId) {
                      return editorPanel;
                    }
                    const ver = summarizePackageVersions(pkg);
                    const needsInstall = pkg.targets.some(h => ['not-installed', 'uninstalled', 'failed'].includes(pkg.harnessStatuses[h]?.status));
                    const hasFailed = pkg.targets.some(h => pkg.harnessStatuses[h]?.status === 'failed');
                    const hasInstalled = HARNESS_IDS.some(h => pkg.harnessStatuses[h]?.status === 'installed');
                    const visibleHarnesses = HARNESS_IDS.filter(h => pkg.harnessStatuses[h]?.selected || pkg.harnessStatuses[h]?.status !== 'unselected');
                    const showId = pkg.id.replace(/[^a-z0-9]/gi, '').toLowerCase() !== pkg.name.replace(/[^a-z0-9]/gi, '').toLowerCase();
                    const menuOpen = openMenuId === pkg.id;
                    const runMenuAction = payload => {
                      setOpenMenuId('');
                      void runAction(payload);
                    };

                    return (
                      <article key={pkg.id} className="ap-card ap-pkg-card">
                        <div className="ap-pkg-head">
                          <div className="ap-pkg-info">
                            <div className="ap-pkg-title-row">
                              <span className="ap-pkg-title">{pkg.name}</span>
                              <span className="ap-badge ap-badge-kind">{CARD_KIND_LABELS[pkg.kind] || pkg.kind}</span>
                              {ver.hasUpdate ? (
                                <span
                                  className="ap-badge ap-badge-update"
                                  title={`当前 ${ver.currentLabel || '未锁定'}，远端最新 ${ver.latestLabel}`}
                                >
                                  {ver.currentLabel ? `${ver.currentLabel} → ${ver.latestLabel}` : `可升级 → ${ver.latestLabel}`}
                                </span>
                              ) : ver.currentLabel ? (
                                <span
                                  className={`ap-badge ${ver.mixedVersions ? 'ap-badge-update' : 'ap-badge-ver'}`}
                                  title={
                                    ver.mixedVersions
                                      ? '各端已装版本不一致，可点击「检查更新」或「升级」对齐'
                                      : ver.isUpToDate
                                        ? `已是最新（上次检查：${new Date(pkg.lock.checkedAt).toLocaleString()}）`
                                        : `当前版本：${ver.currentLabel}`
                                  }
                                >
                                  {ver.currentLabel}{ver.isUpToDate ? ' · 最新' : ''}
                                </span>
                              ) : (
                                <span className="ap-badge">未锁定</span>
                              )}
                              {pkg.lock.checkError && (
                                <span className="ap-badge ap-badge-err" title={pkg.lock.checkError}>检查失败</span>
                              )}
                            </div>
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
                          </div>

                          <div className="ap-pkg-actions">
                            {needsInstall ? (
                              <Button
                                variant="primary"
                                disabled={busy}
                                onClick={() => void runAction({ type: 'package.install', id: pkg.id })}
                              >
                                {hasFailed ? '重试安装' : '安装'}
                              </Button>
                            ) : ver.hasUpdate ? (
                              <Button
                                variant="primary"
                                disabled={busy}
                                onClick={() => void runAction({ type: 'package.upgrade', id: pkg.id })}
                              >
                                升级
                              </Button>
                            ) : null}
                            <Button variant="outline" disabled={busy} onClick={() => openEditEditor(pkg)}>编辑</Button>
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
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="ap-menu-item"
                                    onClick={() => runMenuAction({ type: 'packages.checkUpdates', ids: [pkg.id] })}
                                  >
                                    检查更新
                                  </button>
                                  {needsInstall && ver.hasUpdate && (
                                    <button
                                      type="button"
                                      role="menuitem"
                                      className="ap-menu-item"
                                      onClick={() => runMenuAction({ type: 'package.upgrade', id: pkg.id })}
                                    >
                                      升级到 {ver.latestLabel}
                                    </button>
                                  )}
                                  {!needsInstall && (
                                    <button
                                      type="button"
                                      role="menuitem"
                                      className="ap-menu-item"
                                      onClick={() => runMenuAction({ type: 'package.install', id: pkg.id })}
                                    >
                                      重新同步
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="ap-menu-item"
                                    onClick={() => runMenuAction({ type: 'package.install', id: pkg.id, dryRun: true })}
                                  >
                                    预览变更
                                  </button>
                                  <hr className="ap-menu-sep" />
                                  {hasInstalled ? (
                                    <>
                                      <button
                                        type="button"
                                        role="menuitem"
                                        className="ap-menu-item"
                                        title="从各 Harness 卸载文件，但在清单中保留此配置"
                                        onClick={() => runMenuAction({ type: 'package.uninstall', id: pkg.id })}
                                      >
                                        仅从各端卸载
                                      </button>
                                      <button
                                        type="button"
                                        role="menuitem"
                                        className="ap-menu-item"
                                        title="从清单删除记录，不改动本机已安装文件"
                                        onClick={() => runMenuAction({ type: 'package.delete', id: pkg.id, uninstallFirst: false })}
                                      >
                                        仅从清单移除
                                      </button>
                                      <button
                                        type="button"
                                        role="menuitem"
                                        className="ap-menu-item ap-menu-danger"
                                        title="从各 Harness 卸载并从清单删除记录"
                                        onClick={() => runMenuAction({ type: 'package.delete', id: pkg.id, uninstallFirst: true })}
                                      >
                                        卸载并移除
                                      </button>
                                    </>
                                  ) : (
                                    <button
                                      type="button"
                                      role="menuitem"
                                      className="ap-menu-item ap-menu-danger"
                                      onClick={() => runMenuAction({ type: 'package.delete', id: pkg.id, uninstallFirst: false })}
                                    >
                                      从清单移除
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="ap-harness-row" aria-label={`${pkg.name} 各 Harness 状态`}>
                          {visibleHarnesses.length === 0 ? (
                            <span className="ap-help" style={{ marginTop: 0 }}>未选择目标端</span>
                          ) : visibleHarnesses.map(harnessId => {
                            const hs = pkg.harnessStatuses[harnessId];
                            const verText = formatHarnessVersion(hs);
                            const chipMeta = hs.status === 'installed'
                              ? (verText || '已安装')
                              : statusLabel(hs.status);
                            const tooltip = [
                              `${HARNESS_META[harnessId].label}：${statusLabel(hs.status)}`,
                              verText ? `版本 ${verText}` : '',
                              hs.method === 'command' ? '自定义命令' : '',
                              hs.lastError ? `错误：${hs.lastError}` : '',
                            ].filter(Boolean).join(' · ');
                            return (
                              <span
                                key={harnessId}
                                className={`ap-chip ${hs.selected ? '' : 'ap-chip-muted'}`}
                                title={tooltip}
                              >
                                <span className={dotClass(hs.status)} />
                                <span>{HARNESS_META[harnessId].label}</span>
                                <span className={`ap-chip-meta ${hs.status === 'installed' && verText ? 'ap-chip-ver' : ''}`}>
                                  {chipMeta}
                                  {hs.selected && hs.method === 'command' ? ' · 命令' : ''}
                                </span>
                              </span>
                            );
                          })}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
              </>
            );
          })()}

          {tab === 'doctor' && (() => {
            const availableHarnesses = HARNESS_IDS.filter(id => scanReport?.harnesses?.[id]);
            const activeHarness = availableHarnesses.includes(doctorHarness)
              ? doctorHarness
              : (availableHarnesses[0] || HARNESS_IDS[0]);
            const info = scanReport?.harnesses?.[activeHarness] || null;
            const harnessOptions = availableHarnesses.map(harnessId => {
              const h = scanReport.harnesses[harnessId];
              const stats = [`Skills ${h.skillsCount}`, `MCP ${h.mcpCount}`];
              if (h.pluginsCount > 0) stats.push(`插件 ${h.pluginsCount}`);
              return {
                value: harnessId,
                label: HARNESS_META[harnessId].label,
                meta: stats.join(' · '),
              };
            });

            return (
              <section aria-label="本机扫描与诊断">
                <div className="ap-actions" style={{ marginBottom: 12 }}>
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() => void runAction({ type: 'local.scan' }, { onSuccess: res => setScanReport(res.report) })}
                  >
                    重新扫描
                  </Button>
                  {scanReport && (
                    <span className="ap-help" style={{ marginTop: 0 }}>
                      上次扫描：{new Date(scanReport.scannedAt).toLocaleString()}
                    </span>
                  )}
                </div>

                {!scanReport ? (
                  <p className="ap-help" role="status">正在扫描本机 4 个 Harness 配置…</p>
                ) : (
                  <>
                    {scanReport.warnings.length > 0 && (
                      <div className="ap-card" style={{ marginBottom: 12 }}>
                        <h3 style={{ fontSize: 14, marginBottom: 8 }}>诊断提示（{scanReport.warnings.length}）</h3>
                        <ul className="ap-mini-list">
                          {scanReport.warnings.map((item, idx) => (
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

                    {info && (
                      <article className="ap-card ap-doctor-card" aria-label={`${HARNESS_META[activeHarness].label} 本机配置`}>
                        <div className="ap-doctor-head">
                          <div className="ap-doctor-switcher">
                            <label htmlFor="ap-doctor-harness" className="ap-sr-only">选择 Harness</label>
                            <Select
                              id="ap-doctor-harness"
                              ariaLabel="选择 Harness"
                              className="ap-doctor-select"
                              value={activeHarness}
                              options={harnessOptions}
                              onChange={setDoctorHarness}
                            />
                          </div>
                          <div className="ap-doctor-stats">
                            <span className="ap-badge">Skills: {info.skillsCount}</span>
                            <span className="ap-badge">MCP: {info.mcpCount}</span>
                            {info.pluginsCount > 0 && <span className="ap-badge">插件: {info.pluginsCount}</span>}
                          </div>
                        </div>

                        <div className="ap-doctor-paths">
                          <div className="ap-doctor-path-row">
                            <span className="ap-doctor-path-label">Skills 目录</span>
                            <code>{info.skillsDir}</code>
                          </div>
                          {info.mcpFile && (
                            <div className="ap-doctor-path-row">
                              <span className="ap-doctor-path-label">MCP 文件</span>
                              <code>{info.mcpFile}</code>
                            </div>
                          )}
                        </div>

                        {info.mcpError && (
                          <p className="ap-field-error" role="alert">MCP 配置解析失败：{info.mcpError}</p>
                        )}

                        {info.mcpServers.length > 0 && (
                          <div className="ap-doctor-group">
                            <h4>MCP Servers（{info.mcpServers.length}）</h4>
                            <ul className="ap-mini-list">
                              {info.mcpServers.map(server => (
                                <li key={server.serverName}>
                                  <span><code>{server.serverName}</code>（{server.transport}）</span>
                                  <span className={`ap-badge ${server.managedBy ? 'ap-badge-ok' : ''}`}>
                                    {server.managedBy ? `受管:${server.managedBy}` : '未纳管'}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {info.plugins?.length > 0 && (
                          <div className="ap-doctor-group">
                            <h4>已装插件（{info.plugins.length}）</h4>
                            <ul className="ap-mini-list">
                              {info.plugins.map(plugin => (
                                <li key={`${plugin.name}@${plugin.marketplace}`}>
                                  <span>
                                    <code>{plugin.marketplace ? `${plugin.name}@${plugin.marketplace}` : plugin.name}</code>
                                    {plugin.version ? `（${plugin.version}）` : ''}
                                  </span>
                                  <span className={`ap-badge ${plugin.managedBy ? 'ap-badge-ok' : ''}`}>
                                    {plugin.managedBy ? `受管:${plugin.managedBy}` : '未纳管'}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {info.mcpServers.length === 0 && !(info.plugins?.length > 0) && (
                          <p className="ap-help ap-doctor-empty">该端暂无已配置的 MCP Server 或已装插件。</p>
                        )}
                      </article>
                    )}
                  </>
                )}
              </section>
            );
          })()}

          {logs.length > 0 && (
            <section className="ap-logs" aria-label="最近执行记录">
              <div className="ap-logs-head">
                <h3>最近执行记录（{logs.length} 步）</h3>
                <Button variant="outline" onClick={() => setLogs([])}>清空记录</Button>
              </div>
              <div className="ap-log-list">
                {logs.map((step, index) => (
                  <div key={index} className="ap-log-item">
                    <div className="ap-log-top">
                      <span className={stepBadgeClass(step.status)}>{step.status}</span>
                      {step.packageName && <strong>{step.packageName}</strong>}
                      <span className="ap-badge">
                        {step.harness === 'shared' ? '全局 CLI' : step.harness === 'repo' ? '仓库' : (HARNESS_META[step.harness]?.label || step.harness)}
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
            </section>
          )}

          <details className="ap-footer-paths">
            <summary>配置文件路径</summary>
            <div>
              <span>清单文件：<code>{state.manifestFile}</code></span>
              <span>锁文件：<code>{state.lockFile}</code></span>
            </div>
          </details>
        </>
      )}
    </main>
  );
}
