import {
  readCodexMcpServers,
  readJsonMcpServers,
  removeCodexMcpServer,
  removeJsonMcpServer,
  upsertCodexMcpServer,
  upsertJsonMcpServer,
} from './config-editors.mjs';
import { HARNESS_IDS, HARNESS_META } from './shared.mjs';
import { renderMcpForHarness as render } from './mcp-render.mjs';

export const MCP_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

export function mcpHarnesses(harnessPaths) {
  return HARNESS_IDS.filter(h => harnessPaths[h]?.mcpFile);
}

async function readServers(target) {
  return target.mcpFormat === 'toml' ? readCodexMcpServers(target.mcpFile) : readJsonMcpServers(target.mcpFile);
}

// 某端原始配置 → 统一定义；"${KEY}" 与 Codex env_vars 视为宿主机环境变量引用
export function specFromRaw(raw = {}) {
  const env = {};
  const envRefs = Array.isArray(raw.env_vars) ? raw.env_vars.map(String) : [];
  if (raw.env && typeof raw.env === 'object') {
    for (const [key, value] of Object.entries(raw.env)) {
      const ref = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(String(value));
      if (ref && ref[1] === key) envRefs.push(key);
      else if (typeof value === 'string') env[key] = value;
    }
  }
  return {
    transport: raw.url ? 'http' : 'stdio',
    command: typeof raw.command === 'string' ? raw.command : '',
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    url: typeof raw.url === 'string' ? raw.url : '',
    env,
    envRefs: [...new Set(envRefs)].sort(),
    headers: { ...(raw.headers ?? {}), ...(raw.http_headers ?? {}) },
  };
}

const specKey = spec => JSON.stringify({
  ...spec,
  env: Object.fromEntries(Object.entries(spec.env).sort()),
  headers: Object.fromEntries(Object.entries(spec.headers).sort()),
});

export async function listMcp(harnessPaths) {
  const rows = new Map();
  const errors = {};
  for (const harnessId of mcpHarnesses(harnessPaths)) {
    let servers = {};
    try { servers = await readServers(harnessPaths[harnessId]); } catch (error) {
      errors[harnessId] = error.message;
    }
    for (const [key, raw] of Object.entries(servers ?? {})) {
      if (!rows.has(key)) rows.set(key, { key, harnesses: {} });
      const spec = specFromRaw(raw);
      rows.get(key).harnesses[harnessId] = { spec, raw };
    }
  }
  const list = [...rows.values()].map(row => ({
    ...row,
    consistent: new Set(Object.values(row.harnesses).map(item => specKey(item.spec))).size <= 1,
  })).sort((a, b) => a.key.localeCompare(b.key));
  return { rows: list, errors };
}

async function writeServer(target, key, config) {
  return target.mcpFormat === 'toml'
    ? upsertCodexMcpServer(target.mcpFile, key, config)
    : upsertJsonMcpServer(target.mcpFile, key, config);
}

// 开启：取其他端已有配置翻译成该端格式写入；关闭：从该端配置移除这个 key
export async function toggleMcp({ harnessPaths, key, harness, on }) {
  if (!MCP_KEY_RE.test(String(key ?? ''))) throw new Error(`MCP key 不合法：${key}`);
  const target = harnessPaths[harness];
  const label = HARNESS_META[harness]?.label ?? harness;
  if (!target?.mcpFile) throw new Error(`${label} 没有可写入的 MCP 配置文件`);
  const { rows } = await listMcp(harnessPaths);
  const row = rows.find(item => item.key === key);
  if (!row) throw new Error(`本机没有名为「${key}」的 MCP`);
  if (on) {
    if (row.harnesses[harness]) return { detail: `${label} 已有「${key}」，无需操作` };
    const source = Object.entries(row.harnesses)[0];
    const result = await writeServer(target, key, render(harness, source[1].spec, null));
    return { detail: `已把「${key}」从 ${HARNESS_META[source[0]].label} 写入 ${target.mcpFile}（${result.action === 'add' ? '新增' : '更新'}）` };
  }
  if (!row.harnesses[harness]) return { detail: `${label} 没有「${key}」，无需操作` };
  if (target.mcpFormat === 'toml') await removeCodexMcpServer(target.mcpFile, key);
  else await removeJsonMcpServer(target.mcpFile, key);
  return { detail: `已从 ${target.mcpFile} 移除「${key}」` };
}

// 手工添加 / 编辑：写入所选端，保留各端原有的未建模字段；未选的端不动
export async function saveMcp({ harnessPaths, key, spec, harnesses }) {
  if (!MCP_KEY_RE.test(String(key ?? ''))) throw new Error('MCP key 只能包含字母、数字、点、下划线、@ 和短横线，且以字母或数字开头');
  const targets = (harnesses ?? []).filter(h => harnessPaths[h]?.mcpFile);
  if (!targets.length) throw new Error('至少选择一个可写入 MCP 的端');
  const normalized = {
    transport: spec?.transport === 'http' ? 'http' : 'stdio',
    command: String(spec?.command ?? '').trim(),
    args: Array.isArray(spec?.args) ? spec.args.map(String).filter(arg => arg !== '') : [],
    url: String(spec?.url ?? '').trim(),
    env: Object.fromEntries(Object.entries(spec?.env ?? {}).filter(([k, v]) => k.trim() && typeof v === 'string' && v !== '')),
    envRefs: (spec?.envRefs ?? []).map(String).filter(Boolean),
    headers: spec?.headers ?? {},
  };
  const { rows } = await listMcp(harnessPaths);
  const row = rows.find(item => item.key === key);
  const steps = [];
  for (const harnessId of targets) {
    const result = await writeServer(harnessPaths[harnessId], key, render(harnessId, normalized, row?.harnesses[harnessId]?.raw));
    steps.push({
      harness: harnessId,
      status: 'ok',
      detail: `${result.action === 'add' ? '新增' : result.action === 'update' ? '更新' : '无变更'} ${harnessPaths[harnessId].mcpFile} → ${key}`,
    });
  }
  return { steps };
}
