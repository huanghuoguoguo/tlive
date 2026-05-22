import type { ThreadStartResult } from '../../channels/types.js';
import { chatScopeId } from '../../core/key.js';
import type { CommandContext } from '../commands/types.js';

export interface StartedTopic {
  scopeId: string;
  threadId: string;
  rootMessageId: string;
  lastMessageId: string;
}

export async function startWorkbenchTopic(
  ctx: CommandContext,
  title: string,
  introText: string,
): Promise<StartedTopic | null> {
  if (ctx.surface !== 'workbench' || !ctx.msg.messageId) return null;

  const startWithTitle = ctx.adapter.startThreadWithTitle?.bind(ctx.adapter);
  const startFromMessage = ctx.adapter.startThreadFromMessage?.bind(ctx.adapter);
  const started =
    (startWithTitle
      ? await startWithTitle(ctx.msg.chatId, title, introText).catch(() => null)
      : null) ??
    (startFromMessage
      ? await startFromMessage(ctx.msg.chatId, ctx.msg.messageId, introText).catch(() => null)
      : null);

  return normalizeStartedTopic(ctx.msg.chatId, started);
}

function normalizeStartedTopic(
  chatId: string,
  started: ThreadStartResult | null,
): StartedTopic | null {
  if (!started?.threadId || !started.messageId) return null;
  return {
    scopeId: chatScopeId(chatId, started.threadId),
    threadId: started.threadId,
    rootMessageId: started.rootMessageId ?? started.messageId,
    lastMessageId: started.messageId,
  };
}
