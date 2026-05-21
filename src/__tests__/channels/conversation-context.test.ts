import { describe, expect, it } from 'vitest';
import {
  conversationContextFromInbound,
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
    expect(conversationContextFromInbound(msg)).toMatchObject({
      channelType: 'feishu',
      chatId: 'chat-1',
      scopeId: 'chat-1',
      surface: 'workbench',
    });
  });

  it('derives topic scope and reply policy from thread fields', () => {
    expect(conversationContextFromInbound(inbound({
      threadId: 'thread-1',
      replyTargetMessageId: 'msg-topic',
    }))).toMatchObject({
      chatId: 'chat-1',
      scopeId: 'chat-1#thread:thread-1',
      threadId: 'thread-1',
      surface: 'topic',
      replyToMessageId: 'msg-topic',
      replyInThread: true,
    });
  });

  it('recognizes a topic from an existing scoped chat id', () => {
    expect(conversationContextFromInbound(inbound({
      scopeId: 'chat-1#thread:thread-1',
      replyToMessageId: 'msg-parent',
    }))).toMatchObject({
      scopeId: 'chat-1#thread:thread-1',
      threadId: 'thread-1',
      surface: 'topic',
      replyToMessageId: 'msg-parent',
      replyInThread: true,
    });
  });

  it('classifies surfaces from partial inputs', () => {
    expect(conversationSurfaceFor({ scopeId: 'chat-1' })).toBe('workbench');
    expect(conversationSurfaceFor({ scopeId: 'chat-1#thread:thread-1' })).toBe('topic');
    expect(conversationSurfaceFor({ threadId: 'thread-1' })).toBe('topic');
  });
});

