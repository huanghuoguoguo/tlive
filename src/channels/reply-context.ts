import type { InboundMessage } from './types.js';

type ReplyableMessage = {
  chatId: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  threadId?: string;
};

/** Preserve platform reply/thread context when formatting a response. */
export function withInboundReplyContext<T extends ReplyableMessage>(
  message: T,
  inbound: InboundMessage,
): T {
  const replyInThread = inbound.replyInThread ?? !!inbound.threadId;
  const replyTargetMessageId = inbound.replyTargetMessageId ?? inbound.replyToMessageId;
  if (!replyInThread || !replyTargetMessageId) {
    return inbound.threadId && message.threadId === undefined
      ? { ...message, threadId: inbound.threadId }
      : message;
  }

  return {
    ...message,
    threadId: message.threadId ?? inbound.threadId,
    replyToMessageId: message.replyToMessageId ?? replyTargetMessageId,
    replyInThread: message.replyInThread ?? true,
  };
}
