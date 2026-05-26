import type { ThreadStartResult } from '../../channels/types.js';
import { chatScopeId } from '../../../shared/core/key.js';
import type { CommandContext } from '../commands/types.js';
import {
  buildTliveTopicMetadata,
  encodeTliveTopicMetadata,
  type TliveTopicMetadataInput,
} from '../../../shared/topic-metadata.js';

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
  metadata?: TliveTopicMetadataInput,
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

  const topic = normalizeStartedTopic(ctx.msg.chatId, started);
  if (topic && metadata) {
    await ctx.adapter
      .publishTopicMetadata(
        ctx.msg.chatId,
        topic.rootMessageId,
        buildTopicMetadataIndexText({
          ...metadata,
          threadId: topic.threadId,
          rootMessageId: topic.rootMessageId,
          entryMessageId: topic.lastMessageId,
        }),
      )
      .catch(() => null);
  }

  return topic;
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

function buildTopicMetadataIndexText(metadata: TliveTopicMetadataInput): string {
  const fullMetadata = buildTliveTopicMetadata(metadata);
  return ['TLive 会话索引', encodeTliveTopicMetadata(fullMetadata)].join('\n');
}
