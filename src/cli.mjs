import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function buildUserEnv(extra = {}) {
  const basePath = process.env.PATH || '';
  const extraDirs = ['/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME || ''}/.local/bin`];
  const merged = [...new Set([...basePath.split(':').filter(Boolean), ...extraDirs])].join(':');
  return { ...process.env, PATH: merged, ...extra };
}

// 直接执行（不经 shell），用于 reclaude status 这类只读探测
export function defaultExecFile(file, args, options = {}) {
  return execFileAsync(file, args, {
    timeout: options.timeout ?? 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: options.env ?? buildUserEnv(),
  });
}
