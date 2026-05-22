import { isThreadScopeId, messageScopeId, threadIdFromScope } from '../core/key.js';
import type { ChannelType, InboundMessage } from './types.js';

export type ConversationSurface = 'workbench' | 'topic';

export interface ConversationRoute {
  channelType: ChannelType;
  /** Real platform chat id used for sending. */
  platformChatId: string;
  /** Logical conversation scope used for bindings/session state. */
  logicalScopeId: string;
  surface: ConversationSurface;
  /** Platform topic/thread id, when this conversation lives inside a topic. */
  threadId?: string;
  /** Platform message id that outbound messages should reply to. */
  replyTargetMessageId?: string;
  /** Whether the platform should reply inside the topic/thread. */
  replyInThread?: boolean;
}

export interface ConversationContext extends ConversationRoute {
  /** @deprecated Use platformChatId. */
  chatId: string;
  /** @deprecated Use logicalScopeId. */
  scopeId: string;
  /** @deprecated Use replyTargetMessageId. */
  replyToMessageId?: string;
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

export function conversationRouteFromInbound(input: ConversationInput): ConversationRoute {
  const logicalScopeId = conversationScopeId(input);
  const threadId = input.threadId ?? (input.scopeId ? threadIdFromScope(input.chatId, input.scopeId) : undefined);
  const replyTargetMessageId = input.replyTargetMessageId ?? input.replyToMessageId;
  const replyInThread = input.replyInThread ?? (threadId ? true : undefined);

  const route: ConversationRoute = {
    channelType: input.channelType,
    platformChatId: input.chatId,
    logicalScopeId,
    surface: conversationSurfaceFor({ scopeId: logicalScopeId, threadId }),
  };

  if (threadId !== undefined) route.threadId = threadId;
  if (replyTargetMessageId !== undefined) route.replyTargetMessageId = replyTargetMessageId;
  if (replyInThread !== undefined) route.replyInThread = replyInThread;

  return route;
}

export function conversationContextFromInbound(input: ConversationInput): ConversationContext {
  const route = conversationRouteFromInbound(input);
  return {
    ...route,
    chatId: route.platformChatId,
    scopeId: route.logicalScopeId,
    replyToMessageId: route.replyTargetMessageId,
  };
}
