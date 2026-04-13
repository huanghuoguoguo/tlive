import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentQueueStatus } from '../messages/presenter.js';

export class QueueCommand extends BaseCommand {
  readonly name = '/queue';
  readonly quick = true;
  readonly description = 'Show queue status';

  async execute(ctx: CommandContext): Promise<boolean> {
    const sub = ctx.parts[1]?.toLowerCase();
    const binding = await ctx.store.getBinding(ctx.msg.channelType, ctx.msg.chatId);
    const activeSessionKey = binding?.sessionId
      ? ctx.sdkEngine?.getSessionKeyForBinding?.(ctx.msg.channelType, ctx.msg.chatId, binding.sessionId)
      : ctx.sdkEngine?.getActiveSessionKey(ctx.msg.channelType, ctx.msg.chatId);

    if (!activeSessionKey) {
      await this.send(ctx, { chatId: ctx.msg.chatId, text: '⚠️ 无活跃会话，队列不可用' });
      return true;
    }

    // /queue clear - clear the queue
    if (sub === 'clear') {
      const cleared = ctx.sdkEngine?.clearQueue(activeSessionKey) ?? 0;
      if (cleared > 0) {
        await this.send(ctx, { chatId: ctx.msg.chatId, text: `✅ 已清空队列 (${cleared} 条消息)` });
      } else {
        await this.send(ctx, { chatId: ctx.msg.chatId, text: '队列已为空' });
      }
      return true;
    }

    // /queue depth <n> - set max queue depth
    if (sub === 'depth') {
      const depth = parseInt(ctx.parts[2], 10);
      if (Number.isNaN(depth) || depth < 1 || depth > 10) {
        await this.send(ctx, { chatId: ctx.msg.chatId, text: '⚠️ 队列深度需为 1-10 的整数' });
        return true;
      }
      ctx.sdkEngine?.setMaxQueueDepth(depth);
      await this.send(ctx, { chatId: ctx.msg.chatId, text: `✅ 已设置队列深度为 ${depth}` });
      return true;
    }

    // /queue or /queue status - show queue status
    const queueDepth = ctx.sdkEngine?.getQueueDepth(activeSessionKey) ?? 0;
    const maxDepth = ctx.sdkEngine?.getMaxQueueDepth() ?? 3;
    const queuedMessages = ctx.sdkEngine?.getQueuedMessages(activeSessionKey) ?? [];

    await this.send(ctx, presentQueueStatus(ctx.msg.chatId, {
      sessionKey: activeSessionKey,
      depth: queueDepth,
      maxDepth,
      queuedMessages,
    }));
    return true;
  }
}
