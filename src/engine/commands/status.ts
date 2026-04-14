import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentStatus } from '../messages/presenter.js';
import { getCurrentVersion } from '../utils/version-checker.js';
import { formatSize } from '../utils/session-format.js';

export class StatusCommand extends BaseCommand {
  readonly name = '/status';
  readonly quick = true;
  readonly description = 'Bridge status';

  async execute(ctx: CommandContext): Promise<boolean> {
    const adapters = ctx.services.getAdapters();
    const channelList = Array.from(adapters.keys()).join(', ') || 'none';

    // Gather channel info (bot name/id if available)
    const channelInfo = Array.from(adapters.entries()).map(([type, adapter]) => {
      const anyAdapter = adapter as any;
      const name = anyAdapter.botUsername || anyAdapter.botName || undefined;
      const id = anyAdapter.config?.appId || anyAdapter.config?.botId || undefined;
      return { type, name, id };
    });

    // Gather session stats
    const activeSessions = ctx.services.sdkEngine?.getActiveSessionCount() ?? 0;
    const idleSessions = ctx.services.sdkEngine?.getIdleSessionCount() ?? 0;
    const sessionSnapshots = ctx.services.sdkEngine?.getSessionRegistrySnapshot() ?? [];

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
      sessionSnapshots,
      memoryUsage,
      uptimeSeconds,
      version,
    }));
    return true;
  }
}