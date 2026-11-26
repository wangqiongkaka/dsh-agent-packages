import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { ENDPOINT, PLUGIN_ID } from './constants.mjs';
import { PackageManagerService } from './service.mjs';
import { apiHandler } from './api.mjs';
import { readHarnessClaudeCommand } from './claude-command.mjs';

export const name = PLUGIN_ID;
export const inject = [];

export const Config = z.object({
  root: z.string().default('').description('包清单与仓库缓存目录；默认 <DSH_HOME>/dsh-agent-packages'),
});

export async function apply(ctx, config = {}) {
  const root = resolve(config.root || join(process.env.DSH_HOME || join(homedir(), '.dsh'), PLUGIN_ID));
  // 与 dsh-harness-provider 使用同一个 Claude Code 命令（如 reclaude），每次操作读取最新设置
  const manager = new PackageManagerService({ root, claudeCommand: () => readHarnessClaudeCommand(() => ctx.get('settings')) });
  try {
    await manager.init();
  } catch (error) {
    ctx.logger.warn(`dsh-agent-packages 初始化失败：${error.message}`);
    return;
  }

  ctx.inject(['webServer'], scope => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: ENDPOINT,
      handler: apiHandler(manager),
    }));
  });

  // 插件在“设置 → Skills & MCP”提供专属管理页面，关闭自动生成的空白表单页。
  ctx.inject(['settings'], scope => {
    scope.effect(() => scope.settings.configure({ auto: false }, scope.fiber));
  });
}
