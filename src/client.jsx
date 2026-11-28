import { useEffect, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { ENDPOINT, HARNESS_IDS, HEADER_KEY, PLUGIN_ID } from './shared.mjs';
import { ConfirmBar, FilterChips, IconButton, LogPanel } from './client-ui.jsx';
import { SkillsView, skillGroups } from './client-skills.jsx';
import { McpView, mcpGroups, newMcpForm } from './client-mcp.jsx';
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
  { id: 'skills', label: 'Skills', count: s => s.skills.rows.length, attention: s => skillGroups(s).attn.length },
  { id: 'mcp', label: 'MCP', count: s => s.mcp.rows.length, attention: s => mcpGroups(s).attn.length },
  { id: 'plugins', label: '插件', count: s => s.plugins.plugins.filter(p => !p.builtin).length, attention: () => 0 },
  { id: 'rules', label: '规则', count: s => s.instructions.snippets.length, attention: s => HARNESS_IDS.filter(h => ['modified', 'missing', 'symlink'].includes(s.instructions.harnesses[h].status)).length },
];

const NOTES = {
  skills: '直接读取 4 端 Skills 目录。点亮格子即在该端建软链，熄灭前先确认。',
  mcp: '直接读取 3 端 MCP 配置。点亮格子即按该端格式复制已有配置，熄灭前先确认。',
  plugins: '先添加市场，再安装插件。开关调用各端原生命令。',
  rules: '各端指令文件 = 开启的片段按顺序拼接。开关与保存立即写入；有外部修改的端需确认后覆盖。',
};

// 路径只显示最后三段（如 …/you/.codex/skills），完整路径在悬停提示里
const shortPath = value => {
  const parts = value.split('/').filter(Boolean);
  return value.startsWith('/') && parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : value;
};

// 每个视图顶部的「本机 4 端」：本视图读写的目录、配置文件或命令
function harnessStrip(state, tab) {
  const items = state.harnesses.map(h => ({
    key: h.id,
    title: h.label,
    value: tab === 'skills' ? h.skillsDir
      : tab === 'mcp' ? (h.mcpFile || '没有 MCP 配置文件')
        : tab === 'plugins' ? (h.supportsPlugins ? `${h.command} plugin` : '没有插件机制')
          : h.instructionsFile,
    mono: tab === 'mcp' ? Boolean(h.mcpFile) : tab === 'plugins' ? h.supportsPlugins : true,
  }));
  if (tab === 'skills') items.push({ key: 'trash', title: '回收目录', value: state.trashDir, mono: true });
  if (tab === 'rules') items.push({ key: 'store', title: '片段存储', value: state.instructions.snippetsFile, mono: true });
  return items;
}

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
  const [filter, setFilter] = useState('all');
  const [mcpForm, setMcpForm] = useState(null);
  const [marketplaceForm, setMarketplaceForm] = useState(null);
  const [ruleDrafts, setRuleDrafts] = useState({});
  // 市场插件清单按需读取并缓存，切换视图不丢
  const [catalogs, setCatalogs] = useState({});
  const [reloadTick, setReloadTick] = useState(0);

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

  // 返回执行结果；always：结果 ok=false 也回调（如规则已保存但某端写入失败）；inline：HTTP 错误交给调用方在表单内显示
  async function run(payload, key = '', onSuccess, { always = false, inline = false } = {}) {
    if (!sessionKey) return null;
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
      if (onSuccess && (always || result.ok !== false)) onSuccess(result);
      return result;
    } catch (cause) {
      if (!inline) setError(cause.message);
      return { ok: false, error: cause.message };
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
    setFilter('all');
  }

  const ctx = {
    state,
    busy,
    pendingKey,
    search,
    filter,
    log: log?.tab === tab ? log : null,
    refresh,
    run,
    request: post,
    fail: message => setError(message),
    ask: (rowKey, text, button, exec) => {
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
    catalogs,
    setCatalogs,
  };

  const rulesDirty = Object.keys(ruleDrafts).length > 0;

  const filterOptions = state && tab === 'skills'
    ? (() => { const g = skillGroups(state); return [['all', '全部', state.skills.rows.length], ['attn', '需处理', g.attn.length], ['owned', '由插件提供', g.owned.length], ['settled', '4 端一致', g.settled.length]]; })()
    : state && tab === 'mcp'
      ? (() => { const g = mcpGroups(state); return [['all', '全部', state.mcp.rows.length], ['attn', '需处理', g.attn.length], ['owned', '由插件提供', g.owned.length], ['settled', `${g.writable.length} 端一致`, g.settled.length]]; })()
      : null;

  return (
    <main className="ap" aria-label="Skills、MCP、插件与规则统一管理">
      <style>{styles}</style>

      {state && (
        <nav className="ap-tabs" aria-label="管理视图">
          <div className="ap-tablist" role="tablist" aria-label="管理视图">
            {TABS.map(item => {
              const attention = item.attention(state);
              return (
                <button key={item.id} type="button" role="tab" className="ap-tab" aria-selected={tab === item.id} onClick={() => switchTab(item.id)}>
                  {item.label}
                  <span className="ap-tab-count">{item.count(state)}</span>
                  {attention > 0 && (
                    <span className="ap-tab-attn" title={item.id === 'rules' ? `${attention} 端待同步` : `${attention} 项需处理`}>
                      {attention}<span className="ap-tab-attn-text">{item.id === 'rules' ? ' 待同步' : ' 需处理'}</span>
                    </span>
                  )}
                  {item.id === 'rules' && rulesDirty && <span className="ap-tab-dot" title="有未保存修改"><span className="ap-sr-only">（未保存）</span></span>}
                </button>
              );
            })}
          </div>
        </nav>
      )}

      {state && (
        <header className="ap-head">
          <p className="ap-head-note">{NOTES[tab]}</p>
          <ul className="ap-hstrip" aria-label="本机路径">
            {harnessStrip(state, tab).map(item => (
              <li key={item.key}>
                <b>{item.title}</b>
                <span className={item.mono ? 'ap-mono' : ''} title={item.value}>{shortPath(item.value)}</span>
              </li>
            ))}
          </ul>
        </header>
      )}

      {error && (
        <div className="ap-banner-error" role="alert">
          <span>{error}</span>
          {!state && <Button variant="outline" onClick={() => setReloadTick(v => v + 1)}>重试</Button>}
        </div>
      )}
      {notice && (
        <div className={`ap-banner-notice ${noticeWarn ? 'is-warn' : ''}`.trim()} role="status">
          <span>{notice}</span>
          <IconButton icon="close" label="关闭提示" onClick={() => setNotice('')} />
        </div>
      )}

      {!state ? (
        <p className="ap-help" role="status">{error ? '请检查插件后台状态。' : '正在读取 4 端本机配置…'}</p>
      ) : (
        <>
          <div className="ap-toolbar">
            {tab !== 'rules' && (
              <div className="ap-filters">
                <input type="search" aria-label="搜索名称" className="ap-input ap-search" placeholder="搜索名称" value={search} onChange={e => setSearch(e.target.value)} />
              </div>
            )}
            <div className="ap-actions ap-toolbar-actions">
              {tab !== 'rules' && <Button variant="outline" disabled={busy} title="重新读取 4 端本机配置" onClick={() => void refresh()}>刷新</Button>}
              {tab === 'mcp' && <Button variant="primary" disabled={busy || Boolean(mcpForm)} onClick={() => setMcpForm(newMcpForm(state))}>添加 MCP</Button>}
              {tab === 'plugins' && <Button variant="primary" disabled={busy || Boolean(marketplaceForm)} onClick={() => setMarketplaceForm({})}>添加市场</Button>}
              {tab === 'rules' && (
                <Button variant="primary" disabled={busy || Boolean(ruleDrafts.__new__)} onClick={() => setRuleDrafts(prev => ({ ...prev, __new__: { title: '', content: '' } }))}>新建片段</Button>
              )}
            </div>
          </div>
          {filterOptions && (
            <FilterChips
              value={filter}
              onChange={setFilter}
              options={filterOptions.filter(([id, , count]) => id === 'all' || id === filter || count > 0).map(([id, label, count]) => ({ id, label, count }))}
            />
          )}

          {tab === 'skills' && <SkillsView ctx={ctx} />}
          {tab === 'mcp' && <McpView ctx={ctx} form={mcpForm} setForm={setMcpForm} />}
          {tab === 'plugins' && <PluginsView ctx={ctx} form={marketplaceForm} setForm={setMarketplaceForm} />}
          {tab === 'rules' && <RulesView ctx={ctx} drafts={ruleDrafts} setDrafts={setRuleDrafts} />}

          {log?.tab === tab && <LogPanel log={log} onClear={() => setLog(null)} />}
        </>
      )}
    </main>
  );
}
