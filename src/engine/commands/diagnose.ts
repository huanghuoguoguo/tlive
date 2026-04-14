import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentDiagnose } from '../messages/presenter.js';
import { formatSize } from '../utils/session-format.js';

export class DiagnoseCommand extends BaseCommand {
  readonly name = '/diagnose';
  readonly quick = true;
  readonly description = 'Run diagnostics';

  async execute(ctx: CommandContext): Promise<boolean> {
    const activeSessions = ctx.services.sdkEngine?.getActiveSessionCount() ?? 0;
    const idleSessions = ctx.services.sdkEngine?.getIdleSessionCount() ?? 0;
    const totalBubbleMappings = ctx.services.sdkEngine?.getTotalBubbleMappings() ?? 0;
    const queueStats = ctx.services.sdkEngine?.getAllQueueStats() ?? [];
    const totalQueuedMessages = ctx.services.sdkEngine?.getTotalQueuedMessages() ?? 0;

    let processingChats = 0;
    for (const chatKey of ctx.services.activeControls.keys()) {
      if (ctx.services.state.isProcessing(chatKey)) processingChats++;
    }

    const memUsage = process.memoryUsage();
    const memoryUsage = `${formatSize(memUsage.heapUsed)} / ${formatSize(memUsage.heapTotal)}`;

    await this.send(ctx, presentDiagnose(ctx.msg.chatId, {
      activeSessions,
      totalBubbleMappings,
      queueStats,
      totalQueuedMessages,
      memoryUsage,
      processingChats,
      idleSessions,
    }));
    return true;
  }
}