import { readFile } from 'node:fs/promises';
import { isPlainObject, writeFileAtomic } from './store.mjs';

export function interpolateTemplate(text, vars = {}) {
  return String(text ?? '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

export function renderMcpConfigForHarness(harnessId, mcpSpec, vars = {}) {
  if (!isPlainObject(mcpSpec)) throw new Error('缺少 MCP 配置定义');
  const transport = mcpSpec.transport === 'http' ? 'http' : 'stdio';
  const env = {};
  if (isPlainObject(mcpSpec.env)) {
    for (const [key, value] of Object.entries(mcpSpec.env)) {
      const trimmedKey = key.trim();
      if (trimmedKey && typeof value === 'string' && value !== '') {
        env[trimmedKey] = interpolateTemplate(value, vars);
      }
    }
  }
  const envRefs = Array.isArray(mcpSpec.envRefs)
    ? [...new Set(mcpSpec.envRefs.map(item => String(item).trim()).filter(key => key && !(key in env)))]
    : [];
  const headers = {};
  if (isPlainObject(mcpSpec.headers)) {
    for (const [key, value] of Object.entries(mcpSpec.headers)) {
      headers[key] = interpolateTemplate(value, vars);
    }
  }
  const override = isPlainObject(mcpSpec.overrides?.[harnessId]) ? mcpSpec.overrides[harnessId] : {};
  const warnings = [];

  if (transport === 'stdio') {
    const command = interpolateTemplate(mcpSpec.command, vars).trim();
    if (!command) throw new Error('stdio 类型 MCP 必须指定 command');
    const args = (Array.isArray(mcpSpec.args) ? mcpSpec.args : []).map(arg => interpolateTemplate(arg, vars));

    if (harnessId === 'codex') {
      return {
        warnings,
        config: {
          command,
          ...(args.length ? { args } : {}),
          ...(envRefs.length ? { env_vars: envRefs } : {}),
          ...(Object.keys(env).length ? { env } : {}),
          ...override,
        },
      };
    }

    const mergedEnv = {};
    for (const name of envRefs) mergedEnv[name] = `\${${name}}`;
    Object.assign(mergedEnv, env);
    const hasEnv = Object.keys(mergedEnv).length > 0;
    if (harnessId === 'claude-code') {
      return {
        warnings,
        config: {
          type: 'stdio',
          command,
          args,
          ...(hasEnv ? { env: mergedEnv } : {}),
          ...override,
        },
      };
    }
    if (harnessId === 'antigravity') {
      return {
        warnings,
        config: {
          command,
          args,
          ...(hasEnv ? { env: mergedEnv } : {}),
          ...override,
        },
      };
    }
  }

  const url = interpolateTemplate(mcpSpec.url, vars).trim();
  if (!url) throw new Error('http 类型 MCP 必须指定 url');

  if (harnessId === 'codex') {
    return {
      warnings,
      config: {
        url,
        ...(Object.keys(headers).length ? { http_headers: headers } : {}),
        ...override,
      },
    };
  }
  if (harnessId === 'claude-code') {
    return {
      warnings,
      config: {
        type: 'http',
        url,
        ...(Object.keys(headers).length ? { headers } : {}),
        ...override,
      },
    };
  }
  if (harnessId === 'antigravity') {
    if (/\/sse\/?(\?|$)/i.test(url)) {
      warnings.push('Antigravity 仅支持 Streamable HTTP（非旧版 SSE），如连接失败请改用 /mcp 地址或 mcp-remote 桥接');
    }
    return {
      warnings,
      config: {
        url,
        ...(Object.keys(headers).length ? { headers } : {}),
        ...override,
      },
    };
  }

  throw new Error(`Harness ${harnessId} 不支持原生 MCP 配置文件写入`);
}

// ── JSON MCP 局部编辑器（Claude Code ~/.claude.json & Antigravity ~/.gemini/config/mcp_config.json）──

export async function readJsonConfig(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) throw new Error('根节点必须是 JSON 对象');
    return { exists: true, data: parsed };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, data: {} };
    throw new Error(`解析 JSON 配置失败（${filePath}）：${error.message}`);
  }
}

export async function readJsonMcpServers(filePath) {
  const { exists, data } = await readJsonConfig(filePath);
  if (!exists || !isPlainObject(data.mcpServers)) return {};
  return data.mcpServers;
}

export async function upsertJsonMcpServer(filePath, serverKey, serverConfig, options = {}) {
  const { data } = await readJsonConfig(filePath);
  const currentServers = isPlainObject(data.mcpServers) ? data.mcpServers : {};
  const previous = currentServers[serverKey];
  const changed = JSON.stringify(previous) !== JSON.stringify(serverConfig);
  const next = {
    ...data,
    mcpServers: {
      ...currentServers,
      [serverKey]: serverConfig,
    },
  };
  if (!options.dryRun && changed) {
    await writeFileAtomic(filePath, JSON.stringify(next, null, 2) + '\n');
  }
  return {
    filePath,
    serverKey,
    action: previous === undefined ? 'add' : changed ? 'update' : 'unchanged',
    changed,
    config: serverConfig,
  };
}

export async function removeJsonMcpServer(filePath, serverKey, options = {}) {
  const { exists, data } = await readJsonConfig(filePath);
  if (!exists || !isPlainObject(data.mcpServers) || !(serverKey in data.mcpServers)) {
    return { filePath, serverKey, action: 'unchanged', changed: false };
  }
  const nextServers = { ...data.mcpServers };
  delete nextServers[serverKey];
  const next = { ...data, mcpServers: nextServers };
  if (!options.dryRun) {
    await writeFileAtomic(filePath, JSON.stringify(next, null, 2) + '\n');
  }
  return { filePath, serverKey, action: 'remove', changed: true };
}

// ── TOML 保留格式局部编辑器（Codex ~/.codex/config.toml）────────────────────────────────────────────

function formatTomlKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function formatTomlValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(item => formatTomlValue(item)).join(', ')}]`;
  throw new Error(`不支持的 TOML 值类型：${typeof value}`);
}

export function serializeCodexMcpSection(serverKey, config) {
  const keySegment = formatTomlKey(serverKey);
  const scalarLines = [];
  const subTables = [];
  for (const [field, value] of Object.entries(config)) {
    if (value === undefined || value === null) continue;
    if (isPlainObject(value)) {
      const entries = Object.entries(value).filter(([, v]) => v !== undefined && v !== null);
      if (entries.length) subTables.push([field, entries]);
    } else {
      scalarLines.push(`${formatTomlKey(field)} = ${formatTomlValue(value)}`);
    }
  }
  const blocks = [[`[mcp_servers.${keySegment}]`, ...scalarLines].join('\n')];
  for (const [subName, entries] of subTables) {
    const lines = [`[mcp_servers.${keySegment}.${formatTomlKey(subName)}]`];
    for (const [k, v] of entries) lines.push(`${formatTomlKey(k)} = ${formatTomlValue(v)}`);
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

function parseSectionHeader(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('[') || trimmed.startsWith('[[')) return null;
  const closeIndex = trimmed.lastIndexOf(']');
  if (closeIndex < 1) return null;
  const trailing = trimmed.slice(closeIndex + 1).trim();
  if (trailing && !trailing.startsWith('#')) return null;
  const body = trimmed.slice(1, closeIndex).trim();
  const segments = [];
  let index = 0;
  while (index < body.length) {
    while (index < body.length && /\s/.test(body[index])) index++;
    if (index >= body.length) break;
    if (body[index] === '"' || body[index] === "'") {
      const quote = body[index++];
      let text = '';
      while (index < body.length && body[index] !== quote) {
        if (quote === '"' && body[index] === '\\' && index + 1 < body.length) {
          text += body[index + 1];
          index += 2;
        } else {
          text += body[index++];
        }
      }
      if (body[index] !== quote) return null;
      index++;
      segments.push(text);
    } else {
      let start = index;
      while (index < body.length && body[index] !== '.') index++;
      const token = body.slice(start, index).trim();
      if (!token) return null;
      segments.push(token);
    }
    while (index < body.length && /\s/.test(body[index])) index++;
    if (index < body.length) {
      if (body[index] !== '.') return null;
      index++;
    }
  }
  return segments.length ? segments : null;
}

function parseTomlSections(content) {
  const lines = content.length ? content.split(/\r?\n/) : [];
  const sections = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const header = parseSectionHeader(lines[i]);
    if (header) {
      if (current) current.end = i;
      current = { header, start: i, end: lines.length };
      sections.push(current);
    }
  }
  return { lines, sections };
}

function parseTomlPrimitive(raw) {
  const cleaned = raw.replace(/\s+#.*$/, '').trim();
  if (!cleaned) return undefined;
  if (cleaned === 'true') return true;
  if (cleaned === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(cleaned)) return Number(cleaned);
  if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
    try { return JSON.parse(cleaned); } catch { return cleaned.slice(1, -1); }
  }
  if (cleaned.startsWith("'") && cleaned.endsWith("'")) return cleaned.slice(1, -1);
  if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
    try { return JSON.parse(cleaned); } catch { return cleaned; }
  }
  return cleaned;
}

export async function readCodexMcpServers(filePath) {
  let content;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`读取 Codex 配置失败（${filePath}）：${error.message}`);
  }
  const { lines, sections } = parseTomlSections(content);
  const servers = {};
  for (const section of sections) {
    if (section.header[0] !== 'mcp_servers' || section.header.length < 2) continue;
    const serverName = section.header[1];
    servers[serverName] ??= {};
    const target = section.header.length === 2
      ? servers[serverName]
      : (servers[serverName][section.header[2]] ??= {});
    for (let i = section.start + 1; i < section.end; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, '');
      const val = parseTomlPrimitive(line.slice(eq + 1));
      if (val !== undefined) target[key] = val;
    }
  }
  return servers;
}

export async function upsertCodexMcpServer(filePath, serverKey, serverConfig, options = {}) {
  let content = '';
  let exists = true;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') exists = false;
    else throw new Error(`读取 Codex 配置失败（${filePath}）：${error.message}`);
  }
  const rendered = serializeCodexMcpSection(serverKey, serverConfig);
  const { lines, sections } = parseTomlSections(content);
  const matching = sections.filter(s => s.header[0] === 'mcp_servers' && s.header[1] === serverKey);

  let nextContent;
  let action;
  if (matching.length) {
    const existingText = matching.map(s => lines.slice(s.start, s.end).join('\n').trim()).join('\n\n');
    const keptLines = [];
    const removedRanges = matching.map(s => [s.start, s.end]);
    const insertAt = matching[0].start;
    let inserted = false;
    for (let i = 0; i < lines.length; i++) {
      if (i === insertAt && !inserted) {
        keptLines.push(...rendered.split('\n'), '');
        inserted = true;
      }
      if (removedRanges.some(([start, end]) => i >= start && i < end)) continue;
      keptLines.push(lines[i]);
    }
    nextContent = keptLines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
    action = existingText === rendered.trim() ? 'unchanged' : 'update';
  } else {
    action = 'add';
    const lastMcp = [...sections].reverse().find(s => s.header[0] === 'mcp_servers');
    if (lastMcp && exists) {
      const before = lines.slice(0, lastMcp.end).join('\n').trimEnd();
      const after = lines.slice(lastMcp.end).join('\n').replace(/^\n+/, '');
      nextContent = `${before}\n\n${rendered}${after ? `\n\n${after}` : ''}`.trimEnd() + '\n';
    } else {
      const prefix = content.trimEnd();
      nextContent = `${prefix ? `${prefix}\n\n` : ''}${rendered}\n`;
    }
  }

  const changed = action !== 'unchanged';
  if (!options.dryRun && changed) {
    await writeFileAtomic(filePath, nextContent);
  }
  return { filePath, serverKey, action, changed, config: serverConfig, preview: rendered };
}

export async function removeCodexMcpServer(filePath, serverKey, options = {}) {
  let content;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { filePath, serverKey, action: 'unchanged', changed: false };
    throw new Error(`读取 Codex 配置失败（${filePath}）：${error.message}`);
  }
  const { lines, sections } = parseTomlSections(content);
  const matching = sections.filter(s => s.header[0] === 'mcp_servers' && s.header[1] === serverKey);
  if (!matching.length) return { filePath, serverKey, action: 'unchanged', changed: false };
  const removedRanges = matching.map(s => [s.start, s.end]);
  const keptLines = lines.filter((_, i) => !removedRanges.some(([start, end]) => i >= start && i < end));
  const nextContent = keptLines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + (keptLines.some(Boolean) ? '\n' : '');
  if (!options.dryRun) {
    await writeFileAtomic(filePath, nextContent);
  }
  return { filePath, serverKey, action: 'remove', changed: true };
}
