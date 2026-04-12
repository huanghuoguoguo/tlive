import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentDiagnose } from '../messages/presenter.js';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export class DiagnoseCommand extends BaseCommand {
  readonly name = '/diagnose';
  readonly quick = true;
  readonly description = 'Run diagnostics';

  async execute(ctx: CommandContext): Promise<boolean> {
    const activeSessions = ctx.sdkEngine?.getActiveSessionCount() ?? 0;
    const idleSessions = ctx.sdkEngine?.getIdleSessionCount() ?? 0;
    const totalBubbleMappings = ctx.sdkEngine?.getTotalBubbleMappings() ?? 0;
    const queueStats = ctx.sdkEngine?.getAllQueueStats() ?? [];
    const totalQueuedMessages = ctx.sdkEngine?.getTotalQueuedMessages() ?? 0;

    let processingChats = 0;
    for (const chatKey of ctx.activeControls.keys()) {
      if (ctx.state.isProcessing(chatKey)) processingChats++;
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