import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BridgeManager } from '../../server/engine/coordinators/bridge-manager.js';
import type { BaseChannelAdapter } from '../../server/channels/base.js';
import type { RenderedMessage } from '../../server/channels/types.js';
import type { FormattableMessage } from '../../shared/formatting/message-types.js';
import { FeishuFormatter } from '../../server/channels/feishu/formatter.js';

const feishuFormatter = new FeishuFormatter('zh');

function mockAdapter(channelType = 'feishu'): BaseChannelAdapter {
  const messageQueue: any[] = [];
  const send = vi.fn().mockResolvedValue({ messageId: '1', success: true });
  const editMessage = vi.fn().mockResolvedValue(undefined);
  const formatter = feishuFormatter;
  return {
    channelType,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    consumeOne: vi.fn().mockImplementation(() => messageQueue.shift() ?? null),
    send,
    editMessage,
    sendTyping: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    getLifecycleReactions: vi.fn().mockImplementation(() => channelType === 'feishu'
      ? { processing: 'Typing', done: 'OK', error: 'FACEPALM', stalled: 'OneSecond', permission: 'Pin' }
      : { processing: '🤔', done: '👍', error: '😱', stalled: '⏳', permission: '🔐' }),
    getPermissionDecisionReaction: vi.fn().mockImplementation((decision: string) => channelType === 'feishu'
      ? decision === 'deny' ? 'No' : decision === 'allow_always' ? 'DONE' : 'OK'
      : decision === 'deny' ? '👎' : decision === 'allow_always' ? '👌' : '👍'),
    shouldRenderProgressPhase: vi.fn().mockReturnValue(true),
    shouldSplitCompletedTrace: vi.fn().mockImplementation(() => channelType === 'feishu'),
    shouldSplitProgressMessage: vi.fn().mockReturnValue(false),
    getLocale: vi.fn().mockReturnValue('zh'),
    validateConfig: vi.fn().mockReturnValue(null),
    isAuthorized: vi.fn().mockReturnValue(true),
    _pushMessage: (msg: any) => messageQueue.push(msg),
    // Use real formatter
    format: (msg: FormattableMessage): RenderedMessage => formatter.format(msg),
    sendFormatted: async (msg: FormattableMessage) => send(formatter.format(msg)),
    editCardResolution: async (chatId: string, messageId: string, data: any) => {
      const outMsg = formatter.format({ type: 'cardResolution', chatId, data });
      return editMessage(chatId, messageId, outMsg);
    },
    formatContent: (chatId: string, content: string, buttons?: any[]) => formatter.formatContent(chatId, content, buttons),
    getBotInfo: vi.fn().mockReturnValue({ appId: 'test_app_id' }),
  } as any;
}

describe('BridgeManager', () => {
  let manager: BridgeManager;
  let store: any;
  let llm: any;

  beforeEach(() => {
    // Set required env vars for loadConfig validation
    process.env.TL_TOKEN = 'test-token';
    process.env.TL_FS_APP_ID = 'cli_test123';
    process.env.TL_FS_APP_SECRET = 'secret';
    // BridgeManager tests exercise message routing, not the real HTTP MCP listener.
    process.env.TL_MCP_ENABLED = 'false';
    process.env.TL_REMOTE_SERVER_PORT = '0';
    store = {
      acquireLock: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn(),
      getBinding: vi.fn().mockResolvedValue({ channelType: 'feishu', chatId: 'c1', sessionId: 's1', createdAt: '' }),
      getBindingBySessionId: vi.fn().mockResolvedValue({ channelType: 'feishu', chatId: 'c1', sessionId: 's1', createdAt: '' }),
      saveBinding: vi.fn(),
      listBindings: vi.fn().mockResolvedValue([]),
    };
    llm = {
      streamChat: () => ({
        stream: new ReadableStream({
          start(c) { c.enqueue({ kind: 'text_delta', text: 'reply' }); c.enqueue({ kind: 'query_result', sessionId: 's1', isError: false, usage: { inputTokens: 0, outputTokens: 0 } }); c.close(); }
        }),
        controls: undefined,
      }),
    };
    manager = new BridgeManager({ defaultWorkdir: '/tmp', store, llm });
  });

  afterEach(() => {
    delete process.env.TL_MCP_ENABLED;
    delete process.env.TL_REMOTE_SERVER_PORT;
  });

  it('filters unauthorized messages', async () => {
    const adapter = mockAdapter();
    (adapter.isAuthorized as any).mockReturnValue(false);
    manager.registerAdapter(adapter);

    const processed = await manager.handleInboundMessage(adapter, {
      channelType: 'feishu', chatId: 'c1', userId: 'u1', text: 'hello', messageId: 'm1',
    });
    expect(processed).toBe(false);
  });

  it('falls back menu events to the same user last chat only', async () => {
    const adapter = mockAdapter('feishu');
    manager.registerAdapter(adapter);
    manager.getState().setUserLastChat('u1', 'feishu', 'user-chat');

    const handled = await manager.handleInboundMessage(adapter, {
      channelType: 'feishu', userId: 'u1', text: '/home', messageId: 'm1',
    } as any);

    expect(handled).toBe(true);
    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'user-chat' })
    );
  });

  it('drops menu events without a user-scoped chat even if another chat was recently active', async () => {
    const adapter = mockAdapter('feishu');
    manager.registerAdapter(adapter);
    store.getBinding.mockResolvedValue(null);
    manager.getState().clearUserLastChat('u1');
    manager.getIngress().recordChat('feishu', 'other-users-chat');

    const handled = await manager.handleInboundMessage(adapter, {
      channelType: 'feishu', userId: 'u1', text: '/home', messageId: 'm1',
    } as any);

    expect(handled).toBe(false);
    expect((adapter as any).sendTyping).not.toHaveBeenCalled();
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('drops callbacks without an explicit chat id instead of routing to the last chat', async () => {
    const adapter = mockAdapter('feishu');
    manager.registerAdapter(adapter);
    manager.getIngress().recordChat('feishu', 'other-chat');

    const handled = await manager.handleInboundMessage(adapter, {
      channelType: 'feishu',
      userId: 'u1',
      text: '',
      callbackData: 'perm:allow:p1',
      messageId: 'm1',
    } as any);

    expect(handled).toBe(false);
    expect(adapter.isAuthorized).not.toHaveBeenCalled();
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('routes active permission callbacks directly to the permission gateway', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);
    const pending = manager.getPermissions().getGateway().waitFor('p1', { timeoutMs: 5000 });

    const handled = await manager.handleInboundMessage(adapter, {
      channelType: 'feishu', chatId: 'c1', userId: 'u1', text: '',
      callbackData: 'perm:allow:p1', messageId: 'm1',
    });
    expect(handled).toBe(true);
    await expect(pending).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('does not swallow stale permission callbacks', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    const handled = await manager.handleInboundMessage(adapter, {
      channelType: 'feishu', chatId: 'c1', userId: 'u1', text: '',
      callbackData: 'perm:allow:missing', messageId: 'm1',
    });
    expect(handled).toBe(false);
  });

  describe('error notification', () => {
    it('sendErrorNotification is called when quick message throws', async () => {
      const adapter = mockAdapter();
      manager.registerAdapter(adapter);
      await manager.start();

      // Simulate error notification being sent
      const testErr = new Error('Test error');
      (manager as any).sendErrorNotification(adapter, 'c1', testErr, 'req-123');

      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'c1',
          text: expect.stringContaining('req-123'),
        })
      );
    });

    it('error notification includes truncated error message', async () => {
      const adapter = mockAdapter();
      manager.registerAdapter(adapter);

      const longError = new Error('A'.repeat(300));
      (manager as any).sendErrorNotification(adapter, 'c1', longError, 'req-456');

      const sentMsg = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sentMsg.text.length).toBeLessThan(300); // Should be truncated
    });

    it('error notification is not sent when chatId is undefined', async () => {
      const adapter = mockAdapter();
      manager.registerAdapter(adapter);

      const testErr = new Error('Test error');
      (manager as any).sendErrorNotification(adapter, undefined, testErr, 'req-789');

      expect(adapter.send).not.toHaveBeenCalled();
    });

    it('preserves topic reply context when sending error notifications', async () => {
      const adapter = mockAdapter();
      manager.registerAdapter(adapter);

      const testErr = new Error('topic error');
      (manager as any).sendErrorNotification(adapter, 'c1', testErr, 'req-topic', {
        channelType: 'feishu',
        chatId: 'c1',
        scopeId: 'c1#thread:t1',
        threadId: 't1',
        replyInThread: true,
        replyTargetMessageId: 'topic-root',
        userId: 'u1',
        text: 'hello',
        messageId: 'm1',
      });

      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'c1',
          threadId: 't1',
          replyToMessageId: 'topic-root',
          replyInThread: true,
          text: expect.stringContaining('topic error'),
        }),
      );
    });
  });

  it('continues topic messages after 30 minutes of inactivity', async () => {
    vi.useFakeTimers();
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);
    const streamSpy = vi.spyOn(llm, 'streamChat');

    // First message — creates session
    await manager.handleInboundMessage(adapter, {
      channelType: 'feishu',
      chatId: 'c1',
      userId: 'u1',
      text: 'first',
      messageId: 'm1',
      threadId: 't1',
      scopeId: 'c1#thread:t1',
      replyInThread: true,
    });
    const firstSaveBinding = vi.mocked(manager.getRouter()).rebind;

    // Advance 31 minutes
    vi.advanceTimersByTime(31 * 60 * 1000);

    // Second message still reaches the current topic conversation; SDK recovery owns stale runtime resets.
    const handled = await manager.handleInboundMessage(adapter, {
      channelType: 'feishu',
      chatId: 'c1',
      userId: 'u1',
      text: 'second',
      messageId: 'm2',
      threadId: 't1',
      scopeId: 'c1#thread:t1',
      replyInThread: true,
    });

    expect(handled).toBe(true);
    expect(streamSpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('clears typing interval on error', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    // Make processMessage throw
    llm.streamChat = () => ({
      stream: new ReadableStream({
        start(c) { c.enqueue({ kind: 'error', message: 'boom' }); c.close(); }
      }),
      controls: undefined,
    });

    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    await manager.handleInboundMessage(adapter, {
      channelType: 'feishu',
      chatId: 'c1',
      userId: 'u1',
      text: 'fail',
      messageId: 'm1',
      threadId: 't1',
      scopeId: 'c1#thread:t1',
      replyInThread: true,
    });

    // clearInterval should have been called (finally block)
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  it('text-based permission works for Feishu (not only Feishu)', async () => {
    const adapter = mockAdapter('feishu');
    manager.registerAdapter(adapter);

    // The text "allow" should be parsed as a permission decision
    // Without pending permissions, it falls through to normal message handling
    const result = await manager.handleInboundMessage(adapter, {
      channelType: 'feishu', chatId: 'c1', userId: 'u1', text: 'allow', messageId: 'm1',
    });
    // Since no pending permissions, it should proceed to LLM conversation (not return immediately)
    // This verifies the text-based check runs for Feishu now
    expect(result).toBe(true);
  });

  it('Feishu /tlive renders with header', async () => {
    const adapter = mockAdapter('feishu');
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'feishu', chatId: 'c1', userId: 'u1', text: '/tlive', messageId: 'm1',
    });

    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({
        feishuHeader: expect.objectContaining({ title: expect.stringContaining('工作台') }),
      })
    );
  });

});
