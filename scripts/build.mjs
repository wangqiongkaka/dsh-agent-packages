import { build, context } from 'esbuild';
import { mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
// 保留 lib/ 目录 inode，避免 @deepseek-ai/dsh-hmr 的文件监听器因目录被删而失效。
await mkdir('lib', { recursive: true });

const serverOptions = {
  entryPoints: ['src/index.mjs'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@deepseek-ai/*'],
  sourcemap: true,
};

const clientOptions = {
  entryPoints: ['src/client.jsx'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  loader: { '.css': 'text' },
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  banner: {
    js: 'window.__ModuleLoader__.load({id:"dsh-agent-packages",factory:(require)=>{var module={exports:{}};var exports=module.exports;',
  },
  footer: {
    js: 'return module.exports;}});',
  },
  sourcemap: true,
};

if (watch) {
  const onRebuild = label => ({
    name: `hmr-log-${label}`,
    setup(pluginBuild) {
      pluginBuild.onEnd(result => {
        const time = new Date().toLocaleTimeString();
        if (result.errors.length) {
          console.error(`[${time}] ${label} 构建失败（${result.errors.length} 个错误）`);
        } else {
          console.log(`[${time}] ${label} 已更新 -> 触发 DSH HMR 热重载`);
        }
      });
    },
  });
  const [serverCtx, clientCtx] = await Promise.all([
    context({ ...serverOptions, plugins: [onRebuild('server')] }),
    context({ ...clientOptions, plugins: [onRebuild('client')] }),
  ]);
  await Promise.all([serverCtx.watch(), clientCtx.watch()]);
  console.log('dsh-agent-packages 热加载监听已启动（监听 src/ -> 输出 lib/）');
} else {
  await Promise.all([build(clientOptions), build(serverOptions)]);
}
