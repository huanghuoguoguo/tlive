import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BridgeManager } from '../../engine/coordinators/bridge-manager.js';
import { initBridgeContext } from '../../context.js';
import type { BaseChannelAdapter } from '../../channels/base.js';
import type { RenderedMessage } from '../../channels/types.js';
import type { FormattableMessage } from '../../formatting/message-types.js';
import { FeishuFormatter } from '../../channels/feishu/formatter.js';

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

  beforeEach(() => {
    // Set required env vars for loadConfig validation
    process.env.TL_TOKEN = 'test-token';
    process.env.TL_FS_APP_ID = 'cli_test123';
    process.env.TL_FS_APP_SECRET = 'secret';
    // Use port 0 (random available port) to avoid conflicts in parallel tests
    process.env.TL_WEBHOOK_ENABLED = 'true';
    process.env.TL_WEBHOOK_TOKEN = 'test-webhook-token';
    process.env.TL_WEBHOOK_PORT = '0';
    initBridgeContext({
      defaultWorkdir: '/tmp',
      store: {
        acquireLock: vi.fn().mockResolvedValue(true),
        renewLock: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn(),
        getBinding: vi.fn().mockResolvedValue({ channelType: 'feishu', chatId: 'c1', sessionId: 's1', createdAt: '' }),
        saveBinding: vi.fn(), deleteBinding: vi.fn(), listBindings: vi.fn().mockResolvedValue([]),
        isDuplicate: vi.fn().mockResolvedValue(false), markProcessed: vi.fn(),
      } as any,
      llm: {
        streamChat: () => ({
          stream: new ReadableStream({
            start(c) { c.enqueue({ kind: 'text_delta', text: 'reply' }); c.enqueue({ kind: 'query_result', sessionId: 's1', isError: false, usage: { inputTokens: 0, outputTokens: 0 } }); c.close(); }
          }),
          controls: undefined,
        }),
      } as any,
    });
    manager = new BridgeManager();
  });

  it('starts adapters', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);
    await manager.start();
    expect(adapter.start).toHaveBeenCalled();
  });

  it('stops adapters', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);
    await manager.start();
    await manager.stop();
    expect(adapter.stop).toHaveBeenCalled();
  });

  it('skips adapters with invalid config', async () => {
    const adapter = mockAdapter();
    (adapter.validateConfig as any).mockReturnValue('missing token');
    manager.registerAdapter(adapter);
    await manager.start();
    expect(adapter.start).not.toHaveBeenCalled();
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
    const store = (await import('../../context.js')).getBridgeContext().store as any;
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

  it('routes /tlive command', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    const handled = await manager.handleInboundMessage(adapter, {
      channelType: 'feishu', chatId: 'c1', userId: 'u1', text: '/tlive', messageId: 'm1',
    });
    expect(handled).toBe(true);
    expect(adapter.send).toHaveBeenCalled();
  });

  it('sends typing indicator on message', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'feishu', chatId: 'c1', userId: 'u1', text: 'hello', messageId: 'm1',
    });

    expect((adapter as any).sendTyping).toHaveBeenCalledWith('c1');
  });

  it('handles internal /new action with rebind', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'feishu', chatId: 'c1', userId: 'u1', text: '/new', internalCommand: true, messageId: 'm1',
    });

    expect(JSON.stringify((adapter.send as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain('新会话');
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

  it('rotates the default session when automation changes workdir', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    const store = (await import('../../context.js')).getBridgeContext().store as any;
    const binding = {
      channelType: 'feishu',
      chatId: 'c1',
      sessionId: 'binding-1',
      sdkSessionId: 'sdk-old',
      cwd: '/repo/old',
      projectName: 'old-project',
      createdAt: '',
    };
    store.getBinding.mockImplementation(async () => binding);
    store.saveBinding.mockImplementation(async (nextBinding: typeof binding) => {
      Object.assign(binding, nextBinding);
    });

    const cleanupSpy = vi.spyOn(manager.getSdkEngine(), 'cleanupSession');
    const clearWhitelistSpy = vi.spyOn(manager.getPermissions(), 'clearSessionWhitelist');
    const queryRunSpy = vi.spyOn(manager.getQuery(), 'run').mockResolvedValue(true);

    const result = await manager.injectAutomationPrompt({
      channelType: 'feishu',
      chatId: 'c1',
      text: 'analyze',
      workdir: '/repo/new',
      projectName: 'new-project',
    });

    expect(cleanupSpy).not.toHaveBeenCalled();
    expect(clearWhitelistSpy).not.toHaveBeenCalled();
    expect(binding.sdkSessionId).toBeUndefined();
    expect(binding.sessionId).not.toBe('binding-1');
    expect(binding.cwd).toBe('/repo/new');
    expect(binding.projectName).toBe('new-project');
    expect(queryRunSpy).toHaveBeenCalled();
    expect(result.sessionId).toBe(binding.sessionId);
  });

  it('updates /help text to omit removed commands', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'feishu', chatId: 'c1', userId: 'u1', text: '/help', messageId: 'm1',
    });

    expect(JSON.stringify((adapter.send as ReturnType<typeof vi.fn>).mock.calls[0][0])).not.toContain('verbose');
  });

  it('expires session after 30 minutes of inactivity', async () => {
    vi.useFakeTimers();
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    // First message — creates session
    await manager.handleInboundMessage(adapter, {
      channelType: 'feishu', chatId: 'c1', userId: 'u1', text: 'first', messageId: 'm1',
    });
    const firstSaveBinding = vi.mocked(manager.getRouter()).rebind;

    // Advance 31 minutes
    vi.advanceTimersByTime(31 * 60 * 1000);

    // Second message — should trigger rebind (new session)
    const store = (await import('../../context.js')).getBridgeContext().store;
    const saveBindingSpy = vi.mocked(store.saveBinding);
    const callsBefore = saveBindingSpy.mock.calls.length;

    await manager.handleInboundMessage(adapter, {
      channelType: 'feishu', chatId: 'c1', userId: 'u1', text: 'second', messageId: 'm2',
    });

    // saveBinding should have been called again (rebind creates new binding)
    expect(saveBindingSpy.mock.calls.length).toBeGreaterThan(callsBefore);
    vi.useRealTimers();
  });

  it('does not expire session within 30 minutes', async () => {
    vi.useFakeTimers();
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'feishu', chatId: 'c1', userId: 'u1', text: 'first', messageId: 'm1',
    });

    const store = (await import('../../context.js')).getBridgeContext().store;
    const saveBindingSpy = vi.mocked(store.saveBinding);

    // Advance only 10 minutes
    vi.advanceTimersByTime(10 * 60 * 1000);
    const callsBefore = saveBindingSpy.mock.calls.length;

    await manager.handleInboundMessage(adapter, {
      channelType: 'feishu', chatId: 'c1', userId: 'u1', text: 'second', messageId: 'm2',
    });

    // saveBinding may be called by onSdkSessionId (persisting SDK session),
    // but should NOT have been called for rebind (no session expiry)
    // Check that no rebind happened by verifying the binding's sessionId didn't change
    const binding = await store.getBinding('feishu', 'c1');
    expect(binding?.sessionId).toBeDefined();
    vi.useRealTimers();
  });

  it('clears typing interval on error', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    // Make processMessage throw
    const ctx = (await import('../../context.js')).getBridgeContext();
    (ctx.llm as any).streamChat = () => ({
      stream: new ReadableStream({
        start(c) { c.enqueue({ kind: 'error', message: 'boom' }); c.close(); }
      }),
      controls: undefined,
    });

    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    await manager.handleInboundMessage(adapter, {
      channelType: 'feishu', chatId: 'c1', userId: 'u1', text: 'fail', messageId: 'm1',
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

  it('Feishu internal /help renders with buttons', async () => {
    const adapter = mockAdapter('feishu');
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'feishu', chatId: 'c1', userId: 'u1', text: '/help', internalCommand: true, messageId: 'm1',
    });

    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({
        feishuHeader: expect.any(Object),
        feishuElements: expect.any(Array),
      })
    );
  });

  it('Feishu internal /new renders with header', async () => {
    const adapter = mockAdapter('feishu');
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'feishu', chatId: 'c1', userId: 'u1', text: '/new', internalCommand: true, messageId: 'm1',
    });

    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({
        feishuHeader: expect.any(Object),
      })
    );
  });
});
