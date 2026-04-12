import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentVersionCheck, presentUpgradeResult, presentUpgradeCommand } from '../messages/presenter.js';
import { checkForUpdates } from '../utils/version-checker.js';

export class UpgradeCommand extends BaseCommand {
  readonly name = '/upgrade';
  readonly quick = true;
  readonly description = 'Check for updates';

  async execute(ctx: CommandContext): Promise<boolean> {
    const subCmd = ctx.parts[1]?.toLowerCase();

    // Handle sub-commands with optional version parameter
    if (subCmd?.startsWith('confirm')) {
      const { execSync } = await import('node:child_process');
      try {
        const cmd = 'curl -fsSL https://raw.githubusercontent.com/huanghuoguoguo/tlive/main/install.sh | bash';
        execSync(cmd, { stdio: 'inherit', timeout: 120_000 });
        await ctx.adapter.send({
          chatId: ctx.msg.chatId,
          text: '✅ 升级完成，正在重启...',
        });
        setTimeout(() => process.exit(0), 1000);
      } catch (err: any) {
        await this.send(ctx, presentUpgradeResult(ctx.msg.chatId, {
          success: false,
          error: err?.message || 'Upgrade failed',
        }));
      }
      return true;
    }

    if (subCmd === 'cmd' || subCmd === 'command') {
      await this.send(ctx, presentUpgradeCommand(ctx.msg.chatId));
      return true;
    }

    if (subCmd === 'notes') {
      await ctx.adapter.send({
        chatId: ctx.msg.chatId,
        text: '📋 查看更新内容：\nhttps://github.com/huanghuoguoguo/tlive/releases',
      });
      return true;
    }

    // Check for updates
    const info = await checkForUpdates();
    if (info) {
      await this.send(ctx, presentVersionCheck(ctx.msg.chatId, info));
    } else {
      await ctx.adapter.send({
        chatId: ctx.msg.chatId,
        text: '⚠️ 无法检查更新，请稍后重试',
      });
    }
    return true;
  }
}