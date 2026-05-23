import type { InboundMessage } from './types.js';
import { applyInboundReplyContext, type RoutableMessage } from './delivery-route.js';

/** Preserve platform reply/thread context when formatting a response. */
export function withInboundReplyContext<T extends ReplyableMessage>(
  message: T,
  inbound: InboundMessage,
): T {
  return applyInboundReplyContext(message, inbound);
}

type ReplyableMessage = RoutableMessage;
