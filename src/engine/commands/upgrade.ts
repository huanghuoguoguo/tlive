import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { checkForUpdates } from '../../utils/version-checker.js';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getTliveHome } from '../../core/path.js';

function resolvePackageRoot(entryPath = process.argv[1], override = process.env.TLIVE_PACKAGE_ROOT): string {
  if (override?.trim()) return override.trim();
  if (!entryPath) {
    return join(getTliveHome(), 'app');
  }
  return join(dirname(entryPath), '..');
}

function resolveCliPath(): string {
  const override = process.env.TLIVE_CLI_PATH?.trim();
  if (override) return override;

  const packageRoot = resolvePackageRoot();
  const packagedCli = join(packageRoot, 'scripts', 'cli.js');
  if (existsSync(packagedCli)) return packagedCli;

  return join(getTliveHome(), 'app', 'scripts', 'cli.js');
}

export class UpgradeCommand extends BaseCommand {
  readonly name = '/upgrade';
  readonly quick = true;
  readonly description = '升级版本';
  readonly helpDesc = '检查并升级到最新版本。服务会自动重启。notes 查看更新日志。';
  readonly helpExample = '/upgrade 或 /upgrade notes';

  async execute(ctx: CommandContext): Promise<boolean> {
    const subCmd = ctx.parts[1]?.toLowerCase();

    if (subCmd === 'notes') {
      await ctx.adapter.send({
        chatId: ctx.msg.chatId,
        text: '📋 查看更新内容：\nhttps://github.com/huanghuoguoguo/tlive/releases',
      });
      return true;
    }

    // Check for updates first
    const info = await checkForUpdates();

    if (!info) {
      await ctx.adapter.send({
        chatId: ctx.msg.chatId,
        text: '⚠️ 无法检查更新，请稍后重试',
      });
      return true;
    }

    if (!info.hasUpdate) {
      await ctx.adapter.send({
        chatId: ctx.msg.chatId,
        text: `✅ 已是最新版本 v${info.current}`,
      });
      return true;
    }

    // Execute upgrade directly
    const { spawn } = await import('node:child_process');
    const packageRoot = resolvePackageRoot();

    try {
      if (existsSync(join(packageRoot, '.git'))) {
        await ctx.adapter.send({
          chatId: ctx.msg.chatId,
          text: '⚠️ 当前运行自 git checkout，请手动用 git 更新，或改用 release 安装版。',
        });
        return true;
      }

      const cliPath = resolveCliPath();
      if (!existsSync(cliPath)) {
        throw new Error(`CLI not found: ${cliPath}`);
      }

      const child = spawn(process.execPath, [cliPath, 'upgrade'], {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          TLIVE_UPGRADE_PARENT_PID: String(process.pid),
          TLIVE_UPGRADE_CHAT_ID: ctx.msg.chatId,
          TLIVE_UPGRADE_CHANNEL_TYPE: ctx.adapter.channelType,
          TLIVE_UPGRADE_FROM_VERSION: info.current,
        },
      });
      child.unref();

      await ctx.adapter.send({
        chatId: ctx.msg.chatId,
        text: `🔄 开始升级：v${info.current} → v${info.latest}\n服务将自动重启...`,
      });
      setTimeout(() => process.exit(0), 1000);
    } catch (err: any) {
      await ctx.adapter.send({
        chatId: ctx.msg.chatId,
        text: `❌ 升级失败：${err?.message || 'Unknown error'}`,
      });
    }
    return true;
  }
}