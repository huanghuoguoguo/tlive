import { describe, expect, it } from 'vitest';
import {
  chatKey,
  chatScopeId,
  sessionKey,
  splitChatKey,
  splitSessionKey,
} from '../../shared/core/key.js';

describe('core key helpers', () => {
  it('splits chat keys while preserving separators in the chat id', () => {
    const key = chatKey('feishu', chatScopeId('chat-1', 'thread:with:colon'));

    expect(splitChatKey(key)).toEqual({
      channelType: 'feishu',
      chatId: 'chat-1#thread:thread:with:colon',
    });
  });

  it('splits session keys while preserving separators in the chat id', () => {
    const key = sessionKey('feishu', chatScopeId('chat-1', 'thread:with:colon'), 'session-1');

    expect(splitSessionKey(key)).toEqual({
      channelType: 'feishu',
      chatId: 'chat-1#thread:thread:with:colon',
      bindingSessionId: 'session-1',
    });
  });

  it('rejects malformed session keys', () => {
    expect(splitSessionKey('feishu')).toBeUndefined();
    expect(splitSessionKey('feishu:chat-only')).toBeUndefined();
  });
});
