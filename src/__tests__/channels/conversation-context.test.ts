import { describe, expect, it } from 'vitest';
import {
  conversationContextFromInbound,
  conversationRouteFromInbound,
  conversationScopeId,
  conversationSurfaceFor,
} from '../../channels/conversation-context.js';
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

describe('conversation context helpers', () => {
  it('uses the platform chat as the workbench scope by default', () => {
    const msg = inbound();

    expect(conversationScopeId(msg)).toBe('chat-1');
    expect(conversationRouteFromInbound(msg)).toEqual({
      channelType: 'feishu',
      platformChatId: 'chat-1',
      logicalScopeId: 'chat-1',
      surface: 'workbench',
    });
    expect(conversationContextFromInbound(msg)).toMatchObject({
      channelType: 'feishu',
      platformChatId: 'chat-1',
      logicalScopeId: 'chat-1',
      chatId: 'chat-1',
      scopeId: 'chat-1',
      surface: 'workbench',
    });
  });

  it('derives topic scope and reply policy from thread fields', () => {
    const msg = inbound({
      threadId: 'thread-1',
      replyTargetMessageId: 'msg-topic',
    });

    expect(conversationRouteFromInbound(msg)).toMatchObject({
      channelType: 'feishu',
      platformChatId: 'chat-1',
      logicalScopeId: 'chat-1#thread:thread-1',
      threadId: 'thread-1',
      surface: 'topic',
      replyTargetMessageId: 'msg-topic',
      replyInThread: true,
    });
    expect(conversationContextFromInbound(msg)).toMatchObject({
      platformChatId: 'chat-1',
      logicalScopeId: 'chat-1#thread:thread-1',
      chatId: 'chat-1',
      scopeId: 'chat-1#thread:thread-1',
      threadId: 'thread-1',
      surface: 'topic',
      replyTargetMessageId: 'msg-topic',
      replyToMessageId: 'msg-topic',
      replyInThread: true,
    });
  });

  it('recognizes a topic from an existing scoped chat id', () => {
    const msg = inbound({
      scopeId: 'chat-1#thread:thread-1',
      replyToMessageId: 'msg-parent',
    });

    expect(conversationRouteFromInbound(msg)).toMatchObject({
      logicalScopeId: 'chat-1#thread:thread-1',
      threadId: 'thread-1',
      surface: 'topic',
      replyTargetMessageId: 'msg-parent',
      replyInThread: true,
    });
    expect(conversationContextFromInbound(msg)).toMatchObject({
      scopeId: 'chat-1#thread:thread-1',
      threadId: 'thread-1',
      surface: 'topic',
      replyTargetMessageId: 'msg-parent',
      replyToMessageId: 'msg-parent',
      replyInThread: true,
    });
  });

  it('normalizes workbench reply targets while keeping legacy aliases', () => {
    const msg = inbound({
      replyTargetMessageId: 'reply-target',
      replyToMessageId: 'legacy-reply-target',
    });

    expect(conversationRouteFromInbound(msg)).toMatchObject({
      platformChatId: 'chat-1',
      logicalScopeId: 'chat-1',
      surface: 'workbench',
      replyTargetMessageId: 'reply-target',
    });
    expect(conversationContextFromInbound(msg)).toMatchObject({
      chatId: 'chat-1',
      scopeId: 'chat-1',
      replyTargetMessageId: 'reply-target',
      replyToMessageId: 'reply-target',
    });
  });

  it('classifies surfaces from partial inputs', () => {
    expect(conversationSurfaceFor({ scopeId: 'chat-1' })).toBe('workbench');
    expect(conversationSurfaceFor({ scopeId: 'chat-1#thread:thread-1' })).toBe('topic');
    expect(conversationSurfaceFor({ threadId: 'thread-1' })).toBe('topic');
  });
});
