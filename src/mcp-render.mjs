// 纯函数：不依赖 Node 内置模块，服务端写入与前端「将写入」预览共用同一份渲染逻辑
import { isPlainObject } from './shared.mjs';

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

// 写回某端时保留该端原有的未建模字段（如 alwaysLoad）
export const MODELED_KEYS = ['command', 'args', 'env', 'env_vars', 'url', 'headers', 'http_headers'];

export function renderMcpForHarness(harnessId, spec, existingRaw) {
  const { config } = renderMcpConfigForHarness(harnessId, spec);
  const extras = Object.fromEntries(Object.entries(existingRaw ?? {}).filter(([field]) => !MODELED_KEYS.includes(field)));
  return { ...config, ...extras };
}
