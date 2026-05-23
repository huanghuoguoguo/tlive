import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentDiagnose } from '../messages/presenter.js';
import { formatSize } from '../../formatting/session-format.js';

export class DiagnoseCommand extends BaseCommand {
  readonly name = '/diagnose';
  readonly quick = true;
  readonly helpCategory = 'system' as const;
  readonly description = '诊断信息';
  readonly helpDesc = '运行系统诊断，显示会话统计、队列深度、内存使用等详细信息。用于排查问题。';
  readonly helpExample = '/diagnose';

  async execute(ctx: CommandContext): Promise<boolean> {
    const activeSessions = ctx.services.sdkEngine?.getActiveSessionCount() ?? 0;
    const idleSessions = ctx.services.sdkEngine?.getIdleSessionCount() ?? 0;
    const totalBubbleMappings = ctx.services.sdkEngine?.getTotalBubbleMappings() ?? 0;
    const queueStats = ctx.services.sdkEngine?.getAllQueueStats() ?? [];
    const totalQueuedMessages = ctx.services.sdkEngine?.getTotalQueuedMessages() ?? 0;
    const persistedBindings = (await ctx.services.store.listBindings()).length;
    const persistedTopicSessions = ctx.services.topicSessions?.count();
    const persistedTopicSessionsInChat = ctx.services.topicSessions?.count({
      channelType: ctx.msg.channelType,
      chatId: ctx.msg.chatId,
    });

    let processingChats = 0;
    for (const chatKey of ctx.services.activeControls.keys()) {
      if (ctx.services.state.isProcessing(chatKey)) processingChats++;
    }

    const memUsage = process.memoryUsage();
    const memoryUsage = `${formatSize(memUsage.heapUsed)} / ${formatSize(memUsage.heapTotal)}`;

    await this.send(
      ctx,
      presentDiagnose(ctx.msg.chatId, {
        activeSessions,
        totalBubbleMappings,
        persistedBindings,
        persistedTopicSessions,
        persistedTopicSessionsInChat,
        queueStats,
        totalQueuedMessages,
        memoryUsage,
        processingChats,
        idleSessions,
      }),
    );
    return true;
  }
}
