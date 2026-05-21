import { isThreadScopeId, messageScopeId, threadIdFromScope } from '../core/key.js';
import type { ChannelType, InboundMessage } from './types.js';

export type ConversationSurface = 'workbench' | 'topic';

export interface ConversationContext {
  channelType: ChannelType;
  /** Real platform chat id used for sending. */
  chatId: string;
  /** Logical conversation scope used for bindings/session state. */
  scopeId: string;
  /** Platform topic/thread id, when this conversation lives inside a topic. */
  threadId?: string;
  surface: ConversationSurface;
  /** Platform message id that outbound messages should reply to. */
  replyToMessageId?: string;
  /** Whether the platform should reply inside the topic/thread. */
  replyInThread?: boolean;
}

type ConversationInput = Pick<InboundMessage, 'channelType' | 'chatId'> &
  Partial<
    Pick<
      InboundMessage,
      'scopeId' | 'threadId' | 'replyTargetMessageId' | 'replyToMessageId' | 'replyInThread'
    >
  >;

export function conversationScopeId(input: Pick<InboundMessage, 'chatId' | 'scopeId' | 'threadId'>): string {
  return messageScopeId(input);
}

export function conversationSurfaceFor(input: Pick<InboundMessage, 'scopeId' | 'threadId'>): ConversationSurface {
  return input.threadId || isThreadScopeId(input.scopeId) ? 'topic' : 'workbench';
}

export function conversationContextFromInbound(input: ConversationInput): ConversationContext {
  const scopeId = conversationScopeId(input);
  const threadId = input.threadId ?? (input.scopeId ? threadIdFromScope(input.chatId, input.scopeId) : undefined);
  return {
    channelType: input.channelType,
    chatId: input.chatId,
    scopeId,
    threadId,
    surface: conversationSurfaceFor({ scopeId, threadId }),
    replyToMessageId: input.replyTargetMessageId ?? input.replyToMessageId,
    replyInThread: input.replyInThread ?? (threadId ? true : undefined),
  };
}
