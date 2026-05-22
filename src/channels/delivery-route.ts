import type { InboundMessage } from './types.js';
import { conversationRouteFromInbound } from './conversation-context.js';

export interface DeliveryRoute {
  channelType: string;
  /** Real platform chat id used for sending. */
  chatId: string;
  /** Logical conversation scope used for bindings/session state. */
  scopeId: string;
  /** Platform topic/thread id when the route lives inside a topic. */
  threadId?: string;
  /** Platform message id to reply to. */
  replyToMessageId?: string;
  /** Whether the platform should reply inside a topic/thread. */
  replyInThread?: boolean;
}

export interface FileDeliveryRoute extends DeliveryRoute {
  cwd: string;
  sessionKey?: string;
}

export type RoutableMessage = {
  chatId: string;
  threadId?: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
};

export function deliveryRouteFromInbound(msg: InboundMessage): DeliveryRoute {
  const route = conversationRouteFromInbound(msg);
  return {
    channelType: route.channelType,
    chatId: route.platformChatId,
    scopeId: route.logicalScopeId,
    threadId: route.threadId,
    replyToMessageId: route.replyTargetMessageId,
    replyInThread: route.replyInThread,
  };
}

export function applyDeliveryRoute<T extends RoutableMessage>(
  message: T,
  route: DeliveryRoute,
): T {
  return {
    ...message,
    chatId: route.chatId,
    threadId: message.threadId ?? route.threadId,
    replyToMessageId: message.replyToMessageId ?? route.replyToMessageId,
    replyInThread: message.replyInThread ?? route.replyInThread,
  };
}

export function applyInboundReplyContext<T extends RoutableMessage>(
  message: T,
  inbound: InboundMessage,
): T {
  return applyDeliveryRoute(message, deliveryRouteFromInbound(inbound));
}
