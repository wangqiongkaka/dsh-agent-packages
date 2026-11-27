import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function buildUserEnv(extra = {}) {
  const basePath = process.env.PATH || '';
  const extraDirs = ['/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME || ''}/.local/bin`];
  const merged = [...new Set([...basePath.split(':').filter(Boolean), ...extraDirs])].join(':');
  return { ...process.env, PATH: merged, ...extra };
}

export function shellQuote(value) {
  return /^[A-Za-z0-9._\/@:=+-]+$/.test(String(value)) ? String(value) : `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// 经登录 shell 执行（拿到用户 PATH 里的 claude / codex / agy），stdin 关闭以免命令等待交互确认而挂起。
// 返回 { command, stdout, stderr }；非零退出或超时抛错，错误信息带上输出末尾。
export function runCommand(argv, { env = {}, timeout = 120_000 } = {}) {
  const command = argv.map(shellQuote).join(' ');
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.SHELL || '/bin/sh', ['-lc', command], {
      env: buildUserEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`命令超时（${Math.round(timeout / 1000)} 秒）：${command}`));
    }, timeout);
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve({ command, stdout, stderr });
      const tail = (stderr || stdout).trim().split('\n').slice(-6).join('\n');
      reject(new Error(`${command} 退出码 ${code}${tail ? `：${tail}` : ''}`));
    });
  });
}

// 直接执行（不经 shell），用于 reclaude status 这类只读探测
export function defaultExecFile(file, args, options = {}) {
  return execFileAsync(file, args, {
    timeout: options.timeout ?? 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: options.env ?? buildUserEnv(),
  });
}
