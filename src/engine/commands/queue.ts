import { BaseCommand } from './base.js';
import type { CommandContext } from './types.js';
import { presentQueueStatus } from '../messages/presenter.js';
import { t } from '../../i18n/index.js';

export class QueueCommand extends BaseCommand {
  readonly name = '/queue';
  readonly quick = true;
  readonly description = '队列状态';
  readonly helpDesc = '查看消息队列状态。支持 clear 清空队列、depth 设置最大队列深度。';
  readonly helpExample = '/queue 或 /queue clear';

  async execute(ctx: CommandContext): Promise<boolean> {
    const sub = ctx.parts[1]?.toLowerCase();
    const binding = await ctx.services.store.getBinding(ctx.msg.channelType, ctx.msg.chatId);
    const activeSessionKey = binding?.sessionId
      ? ctx.services.sdkEngine?.getSessionKeyForBinding?.(ctx.msg.channelType, ctx.msg.chatId, binding.sessionId)
      : ctx.services.sdkEngine?.getActiveSessionKey(ctx.msg.channelType, ctx.msg.chatId);

    if (!activeSessionKey) {
      await this.send(ctx, { chatId: ctx.msg.chatId, text: t(ctx.locale, 'queue.noActiveSession') });
      return true;
    }

    // /queue clear - clear the queue
    if (sub === 'clear') {
      const cleared = ctx.services.sdkEngine?.clearQueue(activeSessionKey) ?? 0;
      if (cleared > 0) {
        await this.send(ctx, { chatId: ctx.msg.chatId, text: `${t(ctx.locale, 'queue.cleared')} (${cleared})` });
      } else {
        await this.send(ctx, { chatId: ctx.msg.chatId, text: t(ctx.locale, 'queue.emptyMessage') });
      }
      return true;
    }

    // /queue depth <n> - set max queue depth
    if (sub === 'depth') {
      const depth = parseInt(ctx.parts[2], 10);
      if (Number.isNaN(depth) || depth < 1 || depth > 10) {
        await this.send(ctx, { chatId: ctx.msg.chatId, text: t(ctx.locale, 'queue.depthInvalid') });
        return true;
      }
      ctx.services.sdkEngine?.setMaxQueueDepth(depth);
      await this.send(ctx, { chatId: ctx.msg.chatId, text: `${t(ctx.locale, 'queue.depthSet')} ${depth}` });
      return true;
    }

    // /queue or /queue status - show queue status
    const queueDepth = ctx.services.sdkEngine?.getQueueDepth(activeSessionKey) ?? 0;
    const maxDepth = ctx.services.sdkEngine?.getMaxQueueDepth() ?? 3;
    const queuedMessages = ctx.services.sdkEngine?.getQueuedMessages(activeSessionKey) ?? [];

    await this.send(ctx, presentQueueStatus(ctx.msg.chatId, {
      sessionKey: activeSessionKey,
      depth: queueDepth,
      maxDepth,
      queuedMessages,
    }));
    return true;
  }
}