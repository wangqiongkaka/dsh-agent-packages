import { useEffect, useMemo, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { ENDPOINT, HARNESS_IDS, HARNESS_META, HEADER_KEY, KIND_LABELS, PLUGIN_ID } from './shared.mjs';
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
    plugin: { name: '', marketplace: '' },
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
    plugin: { name: pkg.plugin?.name || '', marketplace: pkg.plugin?.marketplace || '' },
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
    plugin: { name: draft.plugin.name.trim(), marketplace: draft.plugin.marketplace.trim() },
    commands: draft.commands,
  };
}

function statusLabel(status) {
  switch (status) {
    case 'installed': return '已安装';
    case 'failed': return '失败';
    case 'uninstalled': return '已卸载';
    case 'not-installed': return '未安装';
    default: return '未启用';
  }
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
  const [evidence, setEvidence] = useState(null);
  const [showCustomCommands, setShowCustomCommands] = useState(false);

  const [scanReport, setScanReport] = useState(null);

  useEffect(() => {
    let active = true;
    setError('');
    void apiRequest()
      .then(data => {
        if (!active) return;
        setSessionKey(data.key);
        setState(data);
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

  async function handleInspectRepo() {
    if (!draft.repo.trim() || !sessionKey) return;
    setInspecting(true);
    setError('');
    setNotice('');
    try {
      const result = await postWithAutoKey({ type: 'repo.inspect', repo: draft.repo.trim() });
      const nextDraft = packageToDraft(result.draft);
      setDraft(prev => ({
        ...nextDraft,
        id: editingOriginalId ? prev.id : nextDraft.id,
      }));
      setEvidence(result.evidence);
      if (nextDraft.kind === 'installer' || Object.keys(nextDraft.commands).length > 0) {
        setShowCustomCommands(true);
      }
      setNotice(result.message);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setInspecting(false);
    }
  }

  function openNewEditor() {
    setEditingOriginalId('');
    setDraft(emptyDraft());
    setEvidence(null);
    setShowCustomCommands(false);
    setEditorOpen(true);
    setTab('packages');
  }

  function openEditEditor(pkg) {
    setEditingOriginalId(pkg.id);
    setDraft(packageToDraft(pkg));
    setEvidence(null);
    setShowCustomCommands(pkg.kind === 'installer' || Object.keys(pkg.commands || {}).length > 0);
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
          if (!dryRun) {
            setEditorOpen(false);
            setEditingOriginalId('');
            setEvidence(null);
          }
        },
      }
    );
  }

  const filteredPackages = useMemo(() => {
    const list = state?.packages ?? [];
    const needle = search.trim().toLowerCase();
    return list.filter(pkg => {
      if (filterKind === 'outdated' && !pkg.lock.updateAvailable) return false;
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

  return (
    <main className="ap" aria-label="Skills 与 MCP 统一管理">
      <style>{styles}</style>

      <header className="ap-header">
        <div className="ap-title-group">
          <h2>Skills &amp; MCP 统一管理</h2>
          <p className="ap-subtitle">
            以 GitHub 清单与锁文件统一管理 Codex、Claude Code、Antigravity、DSH 的版本与各自安装方式。
          </p>
        </div>
        <div className="ap-actions">
          <Button variant="primary" disabled={busy || !state} onClick={openNewEditor}>添加包</Button>
          <Button
            variant="outline"
            disabled={busy || !state || !state.packages.length}
            onClick={() => void runAction({ type: 'packages.checkUpdates' })}
          >
            检查更新
          </Button>
          <Button
            variant="outline"
            disabled={busy || !state || !state.packages.length}
            onClick={() => void runAction({ type: 'packages.syncAll', dryRun: true })}
          >
            预览同步
          </Button>
          <Button
            variant="outline"
            disabled={busy || !state || !state.packages.length}
            onClick={() => void runAction({ type: 'packages.syncAll', dryRun: false })}
          >
            全部同步
          </Button>
        </div>
      </header>

      {state && (
        <div className="ap-metrics" aria-label="清单概览">
          <span className="ap-metric">已纳管 <strong>{state.summary.total}</strong></span>
          <span className={`ap-metric ${state.summary.outdated ? 'ap-metric-warn' : ''}`}>
            可升级 <strong>{state.summary.outdated}</strong>
          </span>
          <span className={`ap-metric ${state.summary.pendingInstall ? 'ap-metric-warn' : ''}`}>
            待安装 <strong>{state.summary.pendingInstall}</strong>
          </span>
          {state.summary.failed > 0 && (
            <span className="ap-metric ap-metric-error">
              执行失败 <strong>{state.summary.failed}</strong>
            </span>
          )}
          {state.summary.outdated > 0 && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void runAction({ type: 'packages.upgradeAll', dryRun: false })}
            >
              一键升级全部（{state.summary.outdated}）
            </Button>
          )}
        </div>
      )}

      {error && (
        <div className="ap-banner-error" role="alert">
          <span>{error}</span>
          {!state && (
            <Button variant="outline" onClick={() => setReloadTick(v => v + 1)}>重试</Button>
          )}
        </div>
      )}
      {notice && <div className="ap-banner-notice" role="status">{notice}</div>}

      {!state ? (
        <p className="ap-help" role="status">{error ? '请检查插件后台状态。' : '正在读取包清单与锁文件…'}</p>
      ) : (
        <>
          <div className="ap-tabs">
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
                本机扫描与诊断
              </button>
            </div>

            {tab === 'packages' && (
              <div className="ap-filters">
                <label htmlFor="ap-filter-kind" className="ap-help">筛选</label>
                <select
                  id="ap-filter-kind"
                  className="ap-select ap-filter-select"
                  value={filterKind}
                  onChange={e => setFilterKind(e.target.value)}
                >
                  <option value="all">全部类型</option>
                  <option value="skills-repo">Skills 仓库</option>
                  <option value="plugin">插件（含 Hooks）</option>
                  <option value="mcp">MCP Server</option>
                  <option value="installer">自定义安装器</option>
                  <option value="outdated">仅看可升级</option>
                </select>
                <input
                  type="search"
                  aria-label="搜索包名称或 GitHub 地址"
                  className="ap-input ap-search"
                  placeholder="搜索名称 / ID / 仓库…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
            )}
          </div>

          {tab === 'packages' && (
            <>
              {editorOpen && (
                <section className="ap-card ap-editor" aria-label={editingOriginalId ? '编辑包配置' : '添加新包'}>
                  <div className="ap-editor-head">
                    <h3>{editingOriginalId ? `编辑包：${editingOriginalId}` : '添加 GitHub Skills / MCP 包'}</h3>
                    <Button variant="outline" disabled={busy} onClick={() => setEditorOpen(false)}>收起</Button>
                  </div>

                  <div className="ap-inspect-row">
                    <div className="ap-field">
                      <label htmlFor="ap-repo">GitHub 地址（支持 owner/repo 或完整 URL）</label>
                      <input
                        id="ap-repo"
                        className="ap-input"
                        placeholder="例如 microsoft/playwright-mcp 或 https://github.com/firecrawl/cli"
                        value={draft.repo}
                        onChange={e => setDraft(prev => ({ ...prev, repo: e.target.value }))}
                      />
                    </div>
                    <Button
                      variant="outline"
                      disabled={busy || inspecting || !draft.repo.trim()}
                      onClick={() => void handleInspectRepo()}
                    >
                      {inspecting ? '解析中…' : '解析仓库'}
                    </Button>
                  </div>

                  {evidence && (
                    <div className="ap-evidence">
                      探测结果：默认分支 <code>{evidence.defaultBranch}</code>
                      {evidence.latestRelease ? <> · 最新 Release <code>{evidence.latestRelease}</code></> : null}
                      {evidence.discoveredSkills?.length ? <> · 发现 {evidence.discoveredSkills.length} 个 Skills（{evidence.discoveredSkills.slice(0, 6).join(', ')}{evidence.discoveredSkills.length > 6 ? '…' : ''}）</> : null}
                      {evidence.npmPackage ? <> · npm 包 <code>{evidence.npmPackage}</code></> : null}
                      {evidence.pythonPackage ? <> · Python 包 <code>{evidence.pythonPackage}</code></> : null}
                      {evidence.plugin ? <> · 插件 <code>{evidence.plugin.name}@{evidence.plugin.marketplace}</code>{evidence.plugin.hookEvents?.length ? <>，声明 Hooks：{evidence.plugin.hookEvents.join('、')}（Claude Code / Codex 安装时注册）</> : '，未声明 Hooks'}</> : null}
                    </div>
                  )}

                  <div className="ap-grid-3">
                    <div className="ap-field">
                      <label htmlFor="ap-name">显示名称</label>
                      <input
                        id="ap-name"
                        className="ap-input"
                        value={draft.name}
                        onChange={e => setDraft(prev => ({ ...prev, name: e.target.value }))}
                      />
                    </div>
                    <div className="ap-field">
                      <label htmlFor="ap-id">包 ID（唯一标识）</label>
                      <input
                        id="ap-id"
                        className="ap-input"
                        placeholder="留空自动从仓库名生成"
                        value={draft.id}
                        disabled={Boolean(editingOriginalId)}
                        onChange={e => setDraft(prev => ({ ...prev, id: e.target.value }))}
                      />
                    </div>
                    <div className="ap-field">
                      <label htmlFor="ap-kind">安装类型</label>
                      <select
                        id="ap-kind"
                        className="ap-select"
                        value={draft.kind}
                        onChange={e => {
                          const nextKind = e.target.value;
                          setDraft(prev => ({ ...prev, kind: nextKind }));
                          if (nextKind === 'installer') setShowCustomCommands(true);
                        }}
                      >
                        <option value="skills-repo">Skills 仓库（自动同步 SKILL.md）</option>
                        <option value="plugin">插件（含 Hooks，调用各端插件命令安装）</option>
                        <option value="mcp">MCP Server（声明式写入各端配置）</option>
                        <option value="installer">自定义安装器（按各端自有命令执行）</option>
                      </select>
                    </div>
                  </div>

                  <div className="ap-grid-3">
                    <div className="ap-field">
                      <label htmlFor="ap-ref">锁定 Git Tag / 分支 / Commit</label>
                      <input
                        id="ap-ref"
                        className="ap-input"
                        placeholder="如 v1.2.0 或 main"
                        value={draft.ref}
                        onChange={e => setDraft(prev => ({ ...prev, ref: e.target.value }))}
                      />
                    </div>
                    <div className="ap-field">
                      <label htmlFor="ap-version">锁定版本号（供 &#123;&#123;version&#125;&#125; 替换）</label>
                      <input
                        id="ap-version"
                        className="ap-input"
                        placeholder="如 0.0.28"
                        value={draft.version}
                        onChange={e => setDraft(prev => ({ ...prev, version: e.target.value }))}
                      />
                    </div>
                    <div className="ap-field">
                      <label htmlFor="ap-npm">关联 npm 包名（可选，查版本用）</label>
                      <input
                        id="ap-npm"
                        className="ap-input"
                        placeholder="如 @playwright/mcp"
                        value={draft.npmPackage}
                        onChange={e => setDraft(prev => ({ ...prev, npmPackage: e.target.value }))}
                      />
                    </div>
                  </div>

                  <div className="ap-field" style={{ marginBottom: 12 }}>
                    <label htmlFor="ap-desc">备注说明</label>
                    <input
                      id="ap-desc"
                      className="ap-input"
                      value={draft.description}
                      onChange={e => setDraft(prev => ({ ...prev, description: e.target.value }))}
                    />
                  </div>

                  <div className="ap-field">
                    <label>目标 Harness</label>
                    <div className="ap-check-group">
                      {HARNESS_IDS.map(harnessId => (
                        <label key={harnessId} className="ap-check-item">
                          <input
                            type="checkbox"
                            checked={draft.targets.includes(harnessId)}
                            onChange={() => toggleTarget(harnessId)}
                          />
                          <span>{HARNESS_META[harnessId].label}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {draft.kind === 'skills-repo' && (
                    <div className="ap-subbox">
                      <div className="ap-subbox-title">Skills 仓库同步配置</div>
                      <div className="ap-grid-2">
                        <div className="ap-field">
                          <label htmlFor="ap-skills-mode">安装方式</label>
                          <select
                            id="ap-skills-mode"
                            className="ap-select"
                            value={draft.skills.mode}
                            onChange={e => setDraft(prev => ({ ...prev, skills: { ...prev.skills, mode: e.target.value } }))}
                          >
                            <option value="symlink">软链接到各 Harness 目录（推荐）</option>
                            <option value="copy">复制副本到各 Harness 目录</option>
                          </select>
                        </div>
                        <div className="ap-field">
                          <label htmlFor="ap-skills-include">仅安装指定 Skills（逗号分隔，留空同步全部）</label>
                          <input
                            id="ap-skills-include"
                            className="ap-input"
                            placeholder="例如 code-review, tdd"
                            value={draft.skills.includeText}
                            onChange={e => setDraft(prev => ({ ...prev, skills: { ...prev.skills, includeText: e.target.value } }))}
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {draft.kind === 'plugin' && (
                    <div className="ap-subbox">
                      <div className="ap-subbox-title">插件安装配置（由各 Harness 插件命令安装，Hooks、命令与 Skills 一并注册和卸载）</div>
                      <div className="ap-grid-2">
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
                          <label htmlFor="ap-plugin-marketplace">插件市场名</label>
                          <input
                            id="ap-plugin-marketplace"
                            className="ap-input"
                            placeholder="如 ponytail"
                            value={draft.plugin.marketplace}
                            onChange={e => setDraft(prev => ({ ...prev, plugin: { ...prev.plugin, marketplace: e.target.value } }))}
                          />
                        </div>
                      </div>
                      <p className="ap-help">Codex 安装后需在 /hooks 中信任插件 Hooks；Claude Code 需新开会话生效；Antigravity 是否运行插件 Hooks 未确认；DSH 原生暂无插件机制，会跳过。</p>
                    </div>
                  )}

                  {draft.kind === 'mcp' && (
                    <div className="ap-subbox">
                      <div className="ap-subbox-title">MCP Server 配置（自动渲染到 Codex TOML / Claude JSON / Antigravity JSON）</div>
                      <div className="ap-grid-3">
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
                          <select
                            id="ap-mcp-transport"
                            className="ap-select"
                            value={draft.mcp.transport}
                            onChange={e => setDraft(prev => ({ ...prev, mcp: { ...prev.mcp, transport: e.target.value } }))}
                          >
                            <option value="stdio">Stdio（本地命令）</option>
                            <option value="http">Streamable HTTP（远程 URL）</option>
                          </select>
                        </div>
                        <div className="ap-field">
                          <label htmlFor="ap-mcp-env">环境变量名引用（逗号分隔，不写明文密钥）</label>
                          <input
                            id="ap-mcp-env"
                            className="ap-input"
                            placeholder="例如 FIRECRAWL_API_KEY"
                            value={draft.mcp.envRefsText}
                            onChange={e => setDraft(prev => ({ ...prev, mcp: { ...prev.mcp, envRefsText: e.target.value } }))}
                          />
                        </div>
                      </div>

                      {draft.mcp.transport === 'stdio' ? (
                        <div className="ap-grid-2">
                          <div className="ap-field">
                            <label htmlFor="ap-mcp-cmd">Command</label>
                            <input
                              id="ap-mcp-cmd"
                              className="ap-input"
                              placeholder="例如 npx 或 uvx"
                              value={draft.mcp.command}
                              onChange={e => setDraft(prev => ({ ...prev, mcp: { ...prev.mcp, command: e.target.value } }))}
                            />
                          </div>
                          <div className="ap-field">
                            <label htmlFor="ap-mcp-args">Args（空格分隔，支持 &#123;&#123;version&#125;&#125;）</label>
                            <input
                              id="ap-mcp-args"
                              className="ap-input"
                              placeholder="例如 -y @playwright/mcp@{{version}}"
                              value={draft.mcp.argsText}
                              onChange={e => setDraft(prev => ({ ...prev, mcp: { ...prev.mcp, argsText: e.target.value } }))}
                            />
                          </div>
                        </div>
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
                  )}

                  <div className="ap-subbox">
                    <div className="ap-subbox-title">
                      <span>按 Harness 自定义安装命令{draft.kind === 'installer' ? '（必填）' : '（可选，填了将覆盖内置适配器）'}</span>
                      {draft.kind !== 'installer' && (
                        <Button variant="outline" onClick={() => setShowCustomCommands(v => !v)}>
                          {showCustomCommands ? '隐藏命令' : '展开配置'}
                        </Button>
                      )}
                    </div>
                    {(draft.kind === 'installer' || showCustomCommands) && (
                      <>
                        <p className="ap-help" style={{ marginBottom: 10 }}>
                          支持模板变量：<code>{'{{repo}}'}</code>、<code>{'{{ref}}'}</code>、<code>{'{{version}}'}</code>、<code>{'{{dir}}'}</code>（引用 <code>{'{{dir}}'}</code> 时会自动先检出仓库）。
                        </p>
                        {draft.targets.map(harnessId => (
                          <div key={harnessId} className="ap-cmd-card">
                            <strong>{HARNESS_META[harnessId].label}</strong>
                            <div className="ap-grid-3" style={{ marginBottom: 0 }}>
                              <div className="ap-field">
                                <label htmlFor={`ap-cmd-install-${harnessId}`}>安装命令（install）</label>
                                <input
                                  id={`ap-cmd-install-${harnessId}`}
                                  className="ap-input"
                                  placeholder="上游给出的该端安装命令"
                                  value={draft.commands[harnessId]?.install || ''}
                                  onChange={e => updateHarnessCommand(harnessId, 'install', e.target.value)}
                                />
                              </div>
                              <div className="ap-field">
                                <label htmlFor={`ap-cmd-upgrade-${harnessId}`}>升级命令（可选，默认复用 install）</label>
                                <input
                                  id={`ap-cmd-upgrade-${harnessId}`}
                                  className="ap-input"
                                  value={draft.commands[harnessId]?.upgrade || ''}
                                  onChange={e => updateHarnessCommand(harnessId, 'upgrade', e.target.value)}
                                />
                              </div>
                              <div className="ap-field">
                                <label htmlFor={`ap-cmd-uninstall-${harnessId}`}>卸载命令（可选）</label>
                                <input
                                  id={`ap-cmd-uninstall-${harnessId}`}
                                  className="ap-input"
                                  value={draft.commands[harnessId]?.uninstall || ''}
                                  onChange={e => updateHarnessCommand(harnessId, 'uninstall', e.target.value)}
                                />
                              </div>
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                  </div>

                  <div className="ap-editor-footer">
                    <Button variant="outline" disabled={busy} onClick={() => setEditorOpen(false)}>取消</Button>
                    <Button variant="outline" disabled={busy} onClick={() => void submitEditor({ installNow: false })}>仅保存清单</Button>
                    <Button variant="outline" disabled={busy} onClick={() => void submitEditor({ installNow: true, dryRun: true })}>保存并预览</Button>
                    <Button variant="primary" disabled={busy} onClick={() => void submitEditor({ installNow: true, dryRun: false })}>保存并安装</Button>
                  </div>
                </section>
              )}

              {filteredPackages.length === 0 ? (
                <div className="ap-empty">
                  <p>
                    {state.packages.length === 0
                      ? '清单还是空的。你可以填入 GitHub 地址添加包，或先扫描本机已有 Skills / MCP 一键导入。'
                      : '当前筛选条件下没有匹配的包。'}
                  </p>
                  {state.packages.length === 0 && (
                    <div className="ap-actions" style={{ justifyContent: 'center' }}>
                      <Button variant="primary" onClick={openNewEditor}>添加第一个包</Button>
                      <Button
                        variant="outline"
                        onClick={() => {
                          setTab('doctor');
                          void runAction({ type: 'local.scan' }, { onSuccess: res => setScanReport(res.report) });
                        }}
                      >
                        扫描本机现状
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="ap-list">
                  {filteredPackages.map(pkg => {
                    const currentVer = pkg.version || pkg.ref || pkg.lock.resolvedCommit?.slice(0, 7) || '未锁定';
                    const latestVer = pkg.lock.latestVersion || pkg.lock.latestRef || pkg.lock.latestCommit?.slice(0, 7) || '';
                    return (
                      <article key={pkg.id} className="ap-card">
                        <div className="ap-pkg-head">
                          <div>
                            <div className="ap-pkg-title-row">
                              <span className="ap-pkg-title">{pkg.name}</span>
                              <span className="ap-badge ap-badge-kind">{KIND_LABELS[pkg.kind] || pkg.kind}</span>
                              <span className="ap-badge">当前：{currentVer}</span>
                              {pkg.lock.updateAvailable && latestVer && (
                                <span className="ap-badge ap-badge-update">可升级 → {latestVer}</span>
                              )}
                              {pkg.lock.checkError && (
                                <span className="ap-badge ap-badge-err">检查失败</span>
                              )}
                            </div>
                            <div className="ap-pkg-meta">
                              <span>ID: <code>{pkg.id}</code></span>
                              {pkg.repo && (
                                <a href={pkg.repo} target="_blank" rel="noreferrer">{pkg.repo.replace(/^https:\/\/github\.com\//, '')}</a>
                              )}
                              {pkg.npmPackage && <span>npm: <code>{pkg.npmPackage}</code></span>}
                            </div>
                            {pkg.description && <p className="ap-pkg-desc">{pkg.description}</p>}
                          </div>

                          <div className="ap-pkg-actions">
                            <Button
                              variant="primary"
                              disabled={busy}
                              onClick={() => void runAction({ type: 'package.install', id: pkg.id })}
                            >
                              安装
                            </Button>
                            {pkg.lock.updateAvailable && (
                              <Button
                                variant="outline"
                                disabled={busy}
                                onClick={() => void runAction({ type: 'package.upgrade', id: pkg.id })}
                              >
                                升级
                              </Button>
                            )}
                            <Button
                              variant="outline"
                              disabled={busy}
                              onClick={() => void runAction({ type: 'package.install', id: pkg.id, dryRun: true })}
                            >
                              预览
                            </Button>
                            <Button variant="outline" disabled={busy} onClick={() => openEditEditor(pkg)}>编辑</Button>
                            <Button
                              variant="outline"
                              disabled={busy}
                              onClick={() => void runAction({ type: 'package.uninstall', id: pkg.id })}
                            >
                              卸载
                            </Button>
                            <Button
                              variant="outline"
                              disabled={busy}
                              onClick={() => void runAction({ type: 'package.delete', id: pkg.id, uninstallFirst: false })}
                            >
                              移除
                            </Button>
                          </div>
                        </div>

                        <div className="ap-harness-row" aria-label={`${pkg.name} 各 Harness 状态`}>
                          {HARNESS_IDS.map(harnessId => {
                            const hs = pkg.harnessStatuses[harnessId];
                            return (
                              <span
                                key={harnessId}
                                className={`ap-chip ${hs.selected ? '' : 'ap-chip-muted'}`}
                                title={hs.lastError || `${HARNESS_META[harnessId].label}：${statusLabel(hs.status)}`}
                              >
                                <span className={dotClass(hs.status)} />
                                <span>{HARNESS_META[harnessId].label}</span>
                                <span style={{ color: 'var(--ap-muted)' }}>
                                  {statusLabel(hs.status)}
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
          )}

          {tab === 'doctor' && (
            <section aria-label="本机扫描与诊断">
              <div className="ap-actions" style={{ marginBottom: 12 }}>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => void runAction({ type: 'local.scan' }, { onSuccess: res => setScanReport(res.report) })}
                >
                  重新扫描本机（只读）
                </Button>
                {scanReport && (
                  <span className="ap-help">上次扫描：{new Date(scanReport.scannedAt).toLocaleString()}</span>
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

                  {scanReport.importCandidates.length > 0 && (
                    <div className="ap-card" style={{ marginBottom: 12 }}>
                      <h3 style={{ fontSize: 14, marginBottom: 4 }}>
                        发现未纳管项（{scanReport.importCandidates.length}）
                      </h3>
                      <p className="ap-help" style={{ marginBottom: 8 }}>
                        点击「导入清单」仅写入本插件清单，不会修改现有本机配置文件。
                      </p>
                      <ul className="ap-mini-list">
                        {scanReport.importCandidates.map(candidate => (
                          <li key={candidate.candidateId}>
                            <div>
                              <strong>{candidate.label}</strong>{' '}
                              <span className="ap-help">
                                出现于：{candidate.harnesses.map(h => HARNESS_META[h]?.label || h).join('、')}
                              </span>
                            </div>
                            <Button
                              variant="outline"
                              disabled={busy}
                              onClick={() => void runAction(
                                { type: 'local.import', draft: candidate.draft },
                                {
                                  onSuccess: () => void runAction(
                                    { type: 'local.scan' },
                                    { silentNotice: true, onSuccess: res => setScanReport(res.report) }
                                  ),
                                }
                              )}
                            >
                              导入清单
                            </Button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="ap-scan-grid">
                    {HARNESS_IDS.map(harnessId => {
                      const info = scanReport.harnesses[harnessId];
                      if (!info) return null;
                      return (
                        <div key={harnessId} className="ap-card">
                          <div className="ap-pkg-title-row" style={{ marginBottom: 6 }}>
                            <strong style={{ fontSize: 14 }}>{HARNESS_META[harnessId].label}</strong>
                            <span className="ap-badge">Skills: {info.skillsCount}</span>
                            <span className="ap-badge">MCP: {info.mcpCount}</span>
                            {info.pluginsCount > 0 && <span className="ap-badge">插件: {info.pluginsCount}</span>}
                          </div>
                          <p className="ap-help">Skills 目录：<code>{info.skillsDir}</code></p>
                          {info.mcpFile && <p className="ap-help">MCP 文件：<code>{info.mcpFile}</code></p>}
                          {info.mcpServers.length > 0 && (
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
                          )}
                          {info.plugins?.length > 0 && (
                            <ul className="ap-mini-list">
                              {info.plugins.map(plugin => (
                                <li key={`${plugin.name}@${plugin.marketplace}`}>
                                  <span><code>{plugin.marketplace ? `${plugin.name}@${plugin.marketplace}` : plugin.name}</code>{plugin.version ? `（${plugin.version}）` : ''}</span>
                                  <span className={`ap-badge ${plugin.managedBy ? 'ap-badge-ok' : ''}`}>
                                    {plugin.managedBy ? `受管:${plugin.managedBy}` : '未纳管'}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </section>
          )}

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
                      <span className="ap-badge">{HARNESS_META[step.harness]?.label || step.harness}</span>
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

          <footer className="ap-footer-paths">
            <span>清单文件：<code>{state.manifestFile}</code></span>
            <span>锁文件：<code>{state.lockFile}</code></span>
          </footer>
        </>
      )}
    </main>
  );
}
