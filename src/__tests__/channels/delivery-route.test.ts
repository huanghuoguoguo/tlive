import { describe, expect, it } from 'vitest';
import {
  applyDeliveryRoute,
  applyInboundReplyContext,
  deliveryRouteFromInbound,
  type DeliveryRoute,
} from '../../channels/delivery-route.js';
import type { InboundMessage } from '../../channels/types.js';

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channelType: 'feishu',
    chatId: 'chat-1',
    userId: 'user-1',
    text: 'hello',
    messageId: 'msg-1',
    ...overrides,
  };
}

describe('delivery route helpers', () => {
  it('derives workbench delivery route from inbound messages', () => {
    expect(deliveryRouteFromInbound(inbound())).toMatchObject({
      channelType: 'feishu',
      chatId: 'chat-1',
      scopeId: 'chat-1',
    });
  });

  it('derives logical scope and topic reply target from inbound messages', () => {
    const route = deliveryRouteFromInbound(inbound({
      threadId: 'thread-1',
      replyTargetMessageId: 'msg-topic',
    }));

    expect(route).toMatchObject({
      channelType: 'feishu',
      chatId: 'chat-1',
      scopeId: 'chat-1#thread:thread-1',
      threadId: 'thread-1',
      replyToMessageId: 'msg-topic',
      replyInThread: true,
    });
  });

  it('maps canonical reply targets into delivery reply fields', () => {
    expect(deliveryRouteFromInbound(inbound({
      replyTargetMessageId: 'reply-target',
      replyToMessageId: 'legacy-reply-target',
    }))).toMatchObject({
      channelType: 'feishu',
      chatId: 'chat-1',
      scopeId: 'chat-1',
      replyToMessageId: 'reply-target',
    });
  });

  it('applies route context without overwriting explicit outbound reply fields', () => {
    const route: DeliveryRoute = {
      channelType: 'feishu',
      chatId: 'chat-1',
      scopeId: 'chat-1#thread:thread-1',
      threadId: 'thread-1',
      replyToMessageId: 'route-reply',
      replyInThread: true,
    };

    expect(applyDeliveryRoute({
      chatId: 'other-chat',
      text: 'payload',
      replyToMessageId: 'explicit-reply',
    }, route)).toMatchObject({
      chatId: 'chat-1',
      threadId: 'thread-1',
      replyToMessageId: 'explicit-reply',
      replyInThread: true,
    });
  });

  it('preserves inbound thread context for formatted replies', () => {
    expect(applyInboundReplyContext({ chatId: 'chat-1', text: 'ok' }, inbound({
      threadId: 'thread-1',
      replyTargetMessageId: 'msg-topic',
    }))).toMatchObject({
      chatId: 'chat-1',
      threadId: 'thread-1',
      replyToMessageId: 'msg-topic',
      replyInThread: true,
    });
  });
});
