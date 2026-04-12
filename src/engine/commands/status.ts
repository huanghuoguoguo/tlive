import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentStatus } from '../messages/presenter.js';
import { getCurrentVersion } from '../utils/version-checker.js';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export class StatusCommand extends BaseCommand {
  readonly name = '/status';
  readonly quick = true;
  readonly description = 'Bridge status';

  async execute(ctx: CommandContext): Promise<boolean> {
    const adapters = ctx.getAdapters();
    const channelList = Array.from(adapters.keys()).join(', ') || 'none';

    // Gather channel info (bot name/id if available)
    const channelInfo = Array.from(adapters.entries()).map(([type, adapter]) => {
      // Try to get bot info from adapter (Telegram has botUsername, Feishu has appId)
      const anyAdapter = adapter as any;
      const name = anyAdapter.botUsername || anyAdapter.botName || undefined;
      const id = anyAdapter.config?.appId || anyAdapter.config?.botId || undefined;
      return { type, name, id };
    });

    // Gather session stats
    const activeSessions = ctx.sdkEngine?.getActiveSessionCount() ?? 0;
    const idleSessions = ctx.sdkEngine?.getIdleSessionCount() ?? 0;

    // Memory usage
    const memUsage = process.memoryUsage();
    const memoryUsage = `${formatSize(memUsage.heapUsed)} / ${formatSize(memUsage.heapTotal)}`;

    // Uptime
    const uptimeSeconds = Math.floor(process.uptime());

    // Version
    const version = getCurrentVersion();

    await this.send(ctx, presentStatus(ctx.msg.chatId, {
      healthy: true,
      channels: channelList.split(', '),
      channelInfo,
      activeSessions,
      idleSessions,
      memoryUsage,
      uptimeSeconds,
      version,
    }));
    return true;
  }
}