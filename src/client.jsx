import { useEffect, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { ENDPOINT, HARNESS_IDS, HEADER_KEY, PLUGIN_ID } from './shared.mjs';
import { ConfirmBar, LogPanel } from './client-ui.jsx';
import { SkillsView } from './client-skills.jsx';
import { McpView, newMcpForm } from './client-mcp.jsx';
import { PluginsView } from './client-plugins.jsx';
import { RulesView } from './client-rules.jsx';
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
    response = await fetch(ENDPOINT, input
      ? { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json', [HEADER_KEY]: key }, body: JSON.stringify(input) }
      : { cache: 'no-store' });
  } catch {
    throw new Error('无法连接插件后台，请确认 DSH 正在运行后重试');
  }
  let data;
  try { data = await response.json(); } catch { throw new Error('插件后台尚未就绪，请稍后重试'); }
  if (!response.ok) {
    const error = new Error(data.error ?? `请求失败（HTTP ${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const TABS = [
  { id: 'skills', label: 'Skills', count: s => s.skills.rows.length },
  { id: 'mcp', label: 'MCP', count: s => s.mcp.rows.length },
  { id: 'plugins', label: '插件', count: s => s.plugins.plugins.filter(p => !p.builtin).length },
  { id: 'rules', label: '规则', count: s => s.instructions.snippets.length },
];

const NOTES = {
  skills: '读取 4 端 Skills 目录；开启 = 建软链，关闭实体目录时移入回收目录',
  mcp: '读取 3 端 MCP 配置；开启 = 按该端格式复制已有配置',
  plugins: '先添加市场再安装插件，均调用各端原生命令',
  rules: '各端文件 = 开启的片段按顺序拼接',
};

export function PackagesPage() {
  const [state, setState] = useState(null);
  const [sessionKey, setSessionKey] = useState('');
  const [tab, setTab] = useState('skills');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingKey, setPendingKey] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeWarn, setNoticeWarn] = useState(false);
  const [log, setLog] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [openMenuId, setOpenMenuId] = useState('');
  const [mcpForm, setMcpForm] = useState(null);
  const [marketplaceForm, setMarketplaceForm] = useState(null);
  const [ruleDrafts, setRuleDrafts] = useState({});
  // 市场插件清单按需读取并缓存，切换视图不丢
  const [catalogs, setCatalogs] = useState({});
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!openMenuId) return;
    const onPointerDown = event => { if (!event.target?.closest?.('.ap-menu-wrap')) setOpenMenuId(''); };
    const onKeyDown = event => { if (event.key === 'Escape') setOpenMenuId(''); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenuId]);

  useEffect(() => {
    let active = true;
    void apiRequest()
      .then(data => {
        if (!active) return;
        setSessionKey(data.key);
        setState(data);
      })
      .catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [reloadTick]);

  // 服务端热重载后会换会话令牌：静默拉取新令牌并重试一次
  async function post(payload) {
    try {
      return await apiRequest(payload, sessionKey);
    } catch (cause) {
      if (cause?.status !== 403) throw cause;
      const refreshed = await apiRequest();
      setSessionKey(refreshed.key);
      setState(refreshed);
      return apiRequest(payload, refreshed.key);
    }
  }

  async function run(payload, key = '', onSuccess) {
    if (!sessionKey) return;
    const originTab = tab;
    setBusy(true);
    setPendingKey(key);
    setError('');
    setNotice('');
    try {
      const result = await post(payload);
      if (result.state) setState(result.state);
      if (result.message) {
        setNotice(result.message);
        setNoticeWarn(result.ok === false);
      }
      setLog(prev => (result.steps?.length
        ? { id: (prev?.id ?? 0) + 1, tab: originTab, steps: result.steps }
        : (prev?.tab === originTab ? null : prev)));
      if (onSuccess && result.ok !== false) onSuccess(result);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
      setPendingKey('');
    }
  }

  async function refresh() {
    setError('');
    try {
      setState(await apiRequest());
    } catch (cause) {
      setError(cause.message);
    }
  }

  function switchTab(next) {
    if (next === tab) return;
    setTab(next);
    setSearch('');
    setNotice('');
    setError('');
    setConfirm(null);
    setOpenMenuId('');
  }

  const ctx = {
    state,
    busy,
    pendingKey,
    search,
    run,
    request: post,
    fail: message => setError(message),
    ask: (rowKey, text, button, exec) => {
      setOpenMenuId('');
      setConfirm({ rowKey, text, button, exec });
    },
    confirmFor: rowKey => (confirm?.rowKey === rowKey ? (
      <ConfirmBar
        confirm={confirm}
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const { exec } = confirm;
          setConfirm(null);
          void exec();
        }}
      />
    ) : null),
    expanded,
    toggleExpanded: key => setExpanded(prev => ({ ...prev, [key]: !prev[key] })),
    openMenuId,
    setOpenMenuId,
    catalogs,
    setCatalogs,
  };

  const rulesDirty = Object.keys(ruleDrafts).length > 0;

  return (
    <main className="ap" aria-label="Skills、MCP、插件与规则统一管理">
      <style>{styles}</style>

      {state && (
        <nav className="ap-tabs" aria-label="管理视图">
          <div className="ap-tablist" role="tablist" aria-label="管理视图">
            {TABS.map(item => (
              <button key={item.id} type="button" role="tab" className="ap-tab" aria-selected={tab === item.id} onClick={() => switchTab(item.id)}>
                {item.label}
                <span className="ap-tab-count">{item.count(state)}</span>
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
        <p className="ap-help" role="status">{error ? '请检查插件后台状态。' : '正在读取 4 端本机配置…'}</p>
      ) : (
        <>
          <div className="ap-toolbar">
            {tab !== 'rules' ? (
              <div className="ap-filters">
                <input type="search" aria-label="搜索名称" className="ap-input ap-search" placeholder="搜索名称" value={search} onChange={e => setSearch(e.target.value)} />
              </div>
            ) : (
              <span className="ap-help ap-toolbar-note">{NOTES.rules}</span>
            )}
            <div className="ap-actions ap-toolbar-actions">
              {tab !== 'rules' && <Button variant="outline" disabled={busy} title="重新读取 4 端本机配置" onClick={() => void refresh()}>刷新</Button>}
              {tab === 'mcp' && <Button variant="outline" disabled={busy || Boolean(mcpForm)} onClick={() => setMcpForm(newMcpForm(state))}>添加 MCP</Button>}
              {tab === 'plugins' && <Button variant="outline" disabled={busy || Boolean(marketplaceForm)} onClick={() => setMarketplaceForm({})}>添加市场</Button>}
              {tab === 'rules' && (
                <Button variant="outline" disabled={busy || Boolean(ruleDrafts.__new__)} onClick={() => setRuleDrafts(prev => ({ ...prev, __new__: { title: '', content: '' } }))}>新建片段</Button>
              )}
            </div>
          </div>
          {tab !== 'rules' && <p className="ap-help ap-view-note">{NOTES[tab]}</p>}

          {tab === 'skills' && <SkillsView ctx={ctx} />}
          {tab === 'mcp' && <McpView ctx={ctx} form={mcpForm} setForm={setMcpForm} />}
          {tab === 'plugins' && <PluginsView ctx={ctx} form={marketplaceForm} setForm={setMarketplaceForm} />}
          {tab === 'rules' && <RulesView ctx={ctx} drafts={ruleDrafts} setDrafts={setRuleDrafts} />}

          {log?.tab === tab && <LogPanel log={log} onClear={() => setLog(null)} />}

          <details className="ap-footer-paths">
            <summary>本机路径</summary>
            <div>
              {HARNESS_IDS.map(id => {
                const h = state.harnesses.find(item => item.id === id);
                return (
                  <span key={id}>
                    {h.label}：Skills <code>{h.skillsDir}</code>
                    {h.mcpFile ? <> · MCP <code>{h.mcpFile}</code></> : null}
                    {' '}· 规则 <code>{h.instructionsFile}</code>
                  </span>
                );
              })}
              <span>回收目录：<code>{state.trashDir}</code></span>
              <span>规则片段：<code>{state.instructions.snippetsFile}</code></span>
            </div>
          </details>
        </>
      )}
    </main>
  );
}
