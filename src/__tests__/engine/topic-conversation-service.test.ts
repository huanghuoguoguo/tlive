import { describe, expect, it, vi } from 'vitest';
import type { BaseChannelAdapter } from '../../server/channels/base.js';
import { TopicConversationService } from '../../server/engine/conversations/topic-conversation.js';
import { TopicSessionManager } from '../../server/engine/state/topic-sessions.js';

const mainBinding = {
  channelType: 'feishu',
  chatId: 'chat-1',
  sessionId: 'session-main',
  cwd: '/repo',
  createdAt: '2026-01-01T00:00:00Z',
};

function createStore(overrides: Record<string, any> = {}) {
  return {
    getBinding: vi.fn().mockResolvedValue(mainBinding),
    saveBinding: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function createAdapter(overrides: Record<string, any> = {}): BaseChannelAdapter {
  return {
    channelType: 'feishu',
    startThreadFromMessage: vi.fn(),
    ...overrides,
  } as any;
}

describe('TopicConversationService', () => {
  it('opens a topic scope for main-chat user messages', async () => {
    const scopeId = 'chat-1#thread:thread-1';
    const topicBinding = { ...mainBinding, chatId: scopeId, sessionId: 'session-topic' };
    const store = createStore({
      getBinding: vi.fn().mockImplementation(async (_channelType: string, chatId: string) =>
        chatId === scopeId ? null : mainBinding
      ),
    });
    const router = {
      resolve: vi.fn().mockResolvedValue(topicBinding),
    } as any;
    const sdkEngine = {
      resolveSessionTarget: vi.fn().mockReturnValue({
        target: {
          sessionKey: `feishu:${scopeId}:session-topic`,
          bindingSessionId: 'session-topic',
          workdir: '/repo',
          source: 'current',
        },
      }),
    } as any;
    const adapter = createAdapter({
      startThreadFromMessage: vi.fn().mockResolvedValue({
        threadId: 'thread-1',
        rootMessageId: 'msg-main',
        messageId: 'msg-topic',
      }),
    });

    const service = new TopicConversationService({
      store,
      router,
      sdkEngine,
      defaultWorkdir: '/repo',
    });

    const resolved = await service.resolve(adapter, {
      channelType: 'feishu',
      chatId: 'chat-1',
      userId: 'user-1',
      text: '开始做事',
      messageId: 'msg-main',
    });

    expect(adapter.startThreadFromMessage).toHaveBeenCalledWith(
      'chat-1',
      'msg-main',
      expect.any(String),
    );
    expect(resolved.scopeId).toBe(scopeId);
    expect(resolved.msg).toMatchObject({
      chatId: 'chat-1',
      scopeId,
      threadId: 'thread-1',
      replyTargetMessageId: 'msg-topic',
      threadRootMessageId: 'msg-main',
      threadParentMessageId: 'msg-topic',
      replyInThread: true,
    });
    expect(router.resolve).toHaveBeenCalledWith('feishu', scopeId);
  });

  it('claims an existing main-chat session when the new topic replies to its bubble', async () => {
    const scopeId = 'chat-1#thread:thread-1';
    const store = createStore({
      getBinding: vi.fn().mockImplementation(async (_channelType: string, chatId: string) =>
        chatId === scopeId ? null : mainBinding
      ),
    });
    const router = {
      resolve: vi.fn().mockResolvedValue({ ...mainBinding, chatId: scopeId, sessionId: 'new-topic' }),
    } as any;
    const sdkEngine = {
      getSessionForBubble: vi.fn().mockReturnValue('feishu:chat-1:session-main'),
      getSessionContext: vi.fn().mockImplementation((sessionKey: string) => ({
        channelType: 'feishu',
        chatId: sessionKey.includes('#thread:') ? scopeId : 'chat-1',
        bindingSessionId: 'session-main',
        sdkSessionId: 'sdk-main',
        workdir: '/repo',
      })),
      moveSessionToChat: vi.fn().mockReturnValue(`feishu:${scopeId}:session-main`),
    } as any;
    const topicSessions = new TopicSessionManager();
    const service = new TopicConversationService({
      store,
      router,
      sdkEngine,
      topicSessions,
      defaultWorkdir: '/repo',
    });

    const resolved = await service.resolve(createAdapter(), {
      channelType: 'feishu',
      chatId: 'chat-1',
      scopeId,
      threadId: 'thread-1',
      threadRootMessageId: 'main-bubble',
      replyTargetMessageId: 'topic-msg',
      replyInThread: true,
      userId: 'user-1',
      text: '继续',
      messageId: 'topic-msg',
    });

    expect(sdkEngine.moveSessionToChat).toHaveBeenCalledWith(
      'feishu:chat-1:session-main',
      scopeId,
    );
    expect(resolved.binding).toMatchObject({
      chatId: scopeId,
      sessionId: 'session-main',
      sdkSessionId: 'sdk-main',
      cwd: '/repo',
    });
    expect(resolved.target).toMatchObject({
      sessionKey: `feishu:${scopeId}:session-main`,
      bindingSessionId: 'session-main',
      sdkSessionId: 'sdk-main',
    });
    expect(store.saveBinding).toHaveBeenCalledWith(expect.objectContaining({
      chatId: scopeId,
      sessionId: 'session-main',
    }));
    expect(store.saveBinding).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'chat-1',
      sdkSessionId: undefined,
    }));
    expect(topicSessions.findBySdkSessionId('sdk-main')).toMatchObject({
      scopeId,
      threadId: 'thread-1',
      lastMessageId: 'main-bubble',
    });
  });
});
