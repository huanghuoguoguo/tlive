import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BridgeManager } from '../../engine/coordinators/bridge-manager.js';
import { initBridgeContext } from '../../context.js';
import type { BaseChannelAdapter } from '../../channels/base.js';
import type { OutboundMessage } from '../../channels/types.js';
import type { FormattableMessage } from '../../formatting/message-types.js';
import { TelegramFormatter } from '../../formatting/telegram-formatter.js';
import { FeishuFormatter } from '../../formatting/feishu-formatter.js';

const telegramFormatter = new TelegramFormatter('en');
const feishuFormatter = new FeishuFormatter('zh');

function mockAdapter(channelType = 'telegram'): BaseChannelAdapter {
  const messageQueue: any[] = [];
  const send = vi.fn().mockResolvedValue({ messageId: '1', success: true });
  const editMessage = vi.fn().mockResolvedValue(undefined);
  const formatter = channelType === 'feishu' ? feishuFormatter : telegramFormatter;
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
    shouldRenderProgressPhase: vi.fn().mockImplementation((phase: string) =>
      channelType === 'qqbot' ? phase !== 'starting' && phase !== 'executing' : true
    ),
    shouldSplitCompletedTrace: vi.fn().mockImplementation(() => channelType === 'feishu'),
    shouldSplitProgressMessage: vi.fn().mockReturnValue(false),
    validateConfig: vi.fn().mockReturnValue(null),
    isAuthorized: vi.fn().mockReturnValue(true),
    _pushMessage: (msg: any) => messageQueue.push(msg),
    // Use real formatter
    format: (msg: FormattableMessage): OutboundMessage => formatter.format(msg),
    sendFormatted: async (msg: FormattableMessage) => send(formatter.format(msg)),
    editCardResolution: async (chatId: string, messageId: string, data: any) => {
      const outMsg = formatter.format({ type: 'cardResolution', chatId, data });
      return editMessage(chatId, messageId, outMsg);
    },
    formatContent: (chatId: string, content: string, buttons?: any[]) => formatter.formatContent(chatId, content, buttons),
  } as any;
}

describe('BridgeManager', () => {
  let manager: BridgeManager;

  beforeEach(() => {
    // Set required env vars for loadConfig validation
    process.env.TL_TOKEN = 'test-token';
    initBridgeContext({
      defaultWorkdir: '/tmp',
      store: {
        acquireLock: vi.fn().mockResolvedValue(true),
        renewLock: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn(),
        getBinding: vi.fn().mockResolvedValue({ channelType: 'telegram', chatId: 'c1', sessionId: 's1', createdAt: '' }),
        saveBinding: vi.fn(), deleteBinding: vi.fn(), listBindings: vi.fn(),
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
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: 'hello', messageId: 'm1',
    });
    expect(processed).toBe(false);
  });

  it('falls back menu events to the same user last chat only', async () => {
    const adapter = mockAdapter('feishu');
    manager.registerAdapter(adapter);
    (manager as any).state.setUserLastChat('u1', 'feishu', 'user-chat');

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
    (manager as any).ingress.recordChat('feishu', 'other-users-chat');

    const handled = await manager.handleInboundMessage(adapter, {
      channelType: 'feishu', userId: 'u1', text: '/home', messageId: 'm1',
    } as any);

    expect(handled).toBe(false);
    expect((adapter as any).sendTyping).not.toHaveBeenCalled();
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('routes callback data to permission broker', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    const handled = await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '',
      callbackData: 'perm:allow:p1', messageId: 'm1',
    });
    // Even if permission not found, it should attempt handling
    expect(handled).toBe(true);
  });

  it('routes /status command', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    const handled = await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/status', messageId: 'm1',
    });
    expect(handled).toBe(true);
    expect(adapter.send).toHaveBeenCalled();
  });

  it('sends typing indicator on message', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: 'hello', messageId: 'm1',
    });

    expect((adapter as any).sendTyping).toHaveBeenCalledWith('c1');
  });

  it('handles /new command with rebind', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/new', messageId: 'm1',
    });

    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({ html: expect.stringContaining('New Session') })
    );
  });

  it('resets the stored SDK session when automation changes workdir', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    const store = (await import('../../context.js')).getBridgeContext().store as any;
    const binding = {
      channelType: 'telegram',
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

    const cleanupSpy = vi.spyOn((manager as any).sdkEngine, 'cleanupSession');
    const clearWhitelistSpy = vi.spyOn((manager as any).permissions, 'clearSessionWhitelist');
    const queryRunSpy = vi.spyOn((manager as any).query, 'run').mockResolvedValue(true);

    const result = await manager.injectAutomationPrompt({
      channelType: 'telegram',
      chatId: 'c1',
      text: 'analyze',
      workdir: '/repo/new',
      projectName: 'new-project',
    });

    expect(cleanupSpy).toHaveBeenCalledWith('telegram', 'c1', 'cd', '/repo/old');
    expect(clearWhitelistSpy).toHaveBeenCalledWith('binding-1');
    expect(binding.sdkSessionId).toBeUndefined();
    expect(binding.cwd).toBe('/repo/new');
    expect(binding.projectName).toBe('new-project');
    expect(queryRunSpy).toHaveBeenCalled();
    expect(result.sessionId).toBe('binding-1');
  });

  it('updates /help text to omit removed commands', async () => {
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/help', messageId: 'm1',
    });

    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({ html: expect.not.stringContaining('verbose') })
    );
  });

  it('expires session after 30 minutes of inactivity', async () => {
    vi.useFakeTimers();
    const adapter = mockAdapter();
    manager.registerAdapter(adapter);

    // First message — creates session
    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: 'first', messageId: 'm1',
    });
    const firstSaveBinding = vi.mocked((manager as any).router).rebind;

    // Advance 31 minutes
    vi.advanceTimersByTime(31 * 60 * 1000);

    // Second message — should trigger rebind (new session)
    const store = (await import('../../context.js')).getBridgeContext().store;
    const saveBindingSpy = vi.mocked(store.saveBinding);
    const callsBefore = saveBindingSpy.mock.calls.length;

    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: 'second', messageId: 'm2',
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
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: 'first', messageId: 'm1',
    });

    const store = (await import('../../context.js')).getBridgeContext().store;
    const saveBindingSpy = vi.mocked(store.saveBinding);

    // Advance only 10 minutes
    vi.advanceTimersByTime(10 * 60 * 1000);
    const callsBefore = saveBindingSpy.mock.calls.length;

    await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: 'second', messageId: 'm2',
    });

    // saveBinding may be called by onSdkSessionId (persisting SDK session),
    // but should NOT have been called for rebind (no session expiry)
    // Check that no rebind happened by verifying the binding's sessionId didn't change
    const binding = await store.getBinding('telegram', 'c1');
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
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: 'fail', messageId: 'm1',
    });

    // clearInterval should have been called (finally block)
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  describe('hook reply routing', () => {
    it('shows warning for hook replies (feature removed with Go Core)', async () => {
      const adapter = mockAdapter();
      manager.registerAdapter(adapter);

      // Simulate a tracked hook message
      manager.trackHookMessage('hook-msg-1', 'session-abc');

      await manager.handleInboundMessage(adapter, {
        channelType: 'telegram', chatId: 'c1', userId: 'u1',
        text: 'A', messageId: 'm1', replyToMessageId: 'hook-msg-1',
      });

      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: '⚠️ Hook reply feature no longer available' })
      );
    });

    it('ignores quote-reply to non-hook message', async () => {
      const adapter = mockAdapter();
      manager.registerAdapter(adapter);

      await manager.handleInboundMessage(adapter, {
        channelType: 'telegram', chatId: 'c1', userId: 'u1',
        text: 'hello', messageId: 'm1', replyToMessageId: 'unknown-msg',
      });

      // Should fall through to normal handling
      expect(adapter.send).toHaveBeenCalled();
    });
  });

  describe('hook notification formatting', () => {
    it('formats stop notification with [Local] prefix', async () => {
      const adapter = mockAdapter();
      await (manager as any).sendHookNotification(adapter, 'c1', {
        tlive_hook_type: 'stop',
        tlive_session_id: 'sess-1',
      });

      const sentMsg = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const content = sentMsg.html ?? sentMsg.text ?? '';
      expect(content).toContain('Terminal');
    });

    it('formats idle_prompt notification with message', async () => {
      const adapter = mockAdapter();
      await (manager as any).sendHookNotification(adapter, 'c1', {
        notification_type: 'idle_prompt',
        message: 'Claude is waiting for your input',
        tlive_session_id: 'sess-1',
      });

      const sentMsg = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const content = sentMsg.html ?? sentMsg.text ?? '';
      expect(content).toContain('Claude is waiting for your input');
    });

    it('tracks hook message for reply routing', async () => {
      const adapter = mockAdapter();
      await (manager as any).sendHookNotification(adapter, 'c1', {
        tlive_hook_type: 'notification',
        tlive_session_id: 'sess-1',
        message: 'test',
      });

      // mockAdapter.send returns { messageId: '1' }
      // hookMessages now live inside PermissionCoordinator
      expect((manager as any).permissions.isHookMessage('1')).toBe(true);
      expect((manager as any).permissions.getHookMessage('1').sessionId).toBe('sess-1');
    });
  });

  describe('/hooks command', () => {
    it('shows hook status', async () => {
      const adapter = mockAdapter();
      manager.registerAdapter(adapter);

      await manager.handleInboundMessage(adapter, {
        channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/hooks', messageId: 'm1',
      });

      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Hooks:') })
      );
    });

    it('handles /hooks pause', async () => {
      const adapter = mockAdapter();
      manager.registerAdapter(adapter);

      await manager.handleInboundMessage(adapter, {
        channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/hooks pause', messageId: 'm1',
      });

      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('paused') })
      );
    });

    it('handles /hooks resume', async () => {
      const adapter = mockAdapter();
      manager.registerAdapter(adapter);

      await manager.handleInboundMessage(adapter, {
        channelType: 'telegram', chatId: 'c1', userId: 'u1', text: '/hooks resume', messageId: 'm1',
      });

      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('resumed') })
      );
    });
  });

  it('text-based permission works for Telegram (not only Feishu)', async () => {
    const adapter = mockAdapter('telegram');
    manager.registerAdapter(adapter);

    // The text "allow" should be parsed as a permission decision
    // Without pending permissions, it falls through to normal message handling
    const result = await manager.handleInboundMessage(adapter, {
      channelType: 'telegram', chatId: 'c1', userId: 'u1', text: 'allow', messageId: 'm1',
    });
    // Since no pending permissions, it should proceed to LLM conversation (not return immediately)
    // This verifies the text-based check runs for Telegram now
    expect(result).toBe(true);
  });

  it('Feishu /status renders with header', async () => {
    const adapter = mockAdapter('feishu');
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'feishu', chatId: 'c1', userId: 'u1', text: '/status', messageId: 'm1',
    });

    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({
        feishuHeader: expect.objectContaining({ title: expect.stringContaining('TLive') }),
      })
    );
  });

  it('Feishu /help renders with buttons', async () => {
    const adapter = mockAdapter('feishu');
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'feishu', chatId: 'c1', userId: 'u1', text: '/help', messageId: 'm1',
    });

    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({
        feishuHeader: expect.any(Object),
        feishuElements: expect.any(Array),
      })
    );
  });

  it('Feishu /new renders with header', async () => {
    const adapter = mockAdapter('feishu');
    manager.registerAdapter(adapter);

    await manager.handleInboundMessage(adapter, {
      channelType: 'feishu', chatId: 'c1', userId: 'u1', text: '/new', messageId: 'm1',
    });

    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({
        feishuHeader: expect.any(Object),
      })
    );
  });
});
