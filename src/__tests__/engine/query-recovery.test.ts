import { describe, expect, it, vi } from 'vitest';
import { QueryRecoveryPolicy } from '../../engine/coordinators/query-recovery.js';

function createPolicy() {
  const sdkEngine = {
    updateSessionSdkSessionId: vi.fn(),
    resetSessionRuntime: vi.fn(),
    setControlsForChat: vi.fn(),
  };
  const state = {
    getPermMode: vi.fn().mockReturnValue('default'),
    stateKey: vi.fn().mockReturnValue('feishu:scope-1'),
  };
  const store = {
    saveBinding: vi.fn().mockResolvedValue(undefined),
  };

  return {
    sdkEngine,
    state,
    store,
    policy: new QueryRecoveryPolicy({
      defaultWorkdir: '/work',
      sdkEngine: sdkEngine as any,
      state: state as any,
      store: store as any,
    }),
  };
}

function createAdapter() {
  return {
    format: vi.fn().mockImplementation((message) => message),
    send: vi.fn().mockResolvedValue({ messageId: 'out-1', success: true }),
    getLocale: () => 'zh',
  };
}

describe('QueryRecoveryPolicy', () => {
  it('clears stale sdk state and saves current bindings before retrying fresh', async () => {
    const { policy, sdkEngine, state, store } = createPolicy();
    const adapter = createAdapter();
    const binding = {
      channelType: 'feishu',
      chatId: 'scope-1',
      sessionId: 'binding-1',
      sdkSessionId: 'sdk-old',
      cwd: '/work/project',
      createdAt: '2026-01-01T00:00:00Z',
    };
    const renderer = { dispose: vi.fn() };
    const presenter = { dispose: vi.fn().mockResolvedValue(undefined) };

    const recovered = await policy.recoverStaleSession({
      adapter: adapter as any,
      msg: {
        channelType: 'feishu',
        chatId: 'chat-1',
        scopeId: 'scope-1',
        userId: 'user-1',
        text: 'run',
        messageId: 'msg-1',
        replyTargetMessageId: 'reply-1',
      },
      scopeId: 'scope-1',
      currentBinding: binding,
      sessionTarget: {
        sessionKey: 'feishu:scope-1:binding-1',
        bindingSessionId: 'binding-1',
        workdir: '/work/project',
        sdkSessionId: 'sdk-old',
        source: 'current',
      },
      requestId: 'req-1',
      renderer,
      presenter,
    });

    expect(recovered.routeBinding.sdkSessionId).toBeUndefined();
    expect(recovered.sessionTarget.sdkSessionId).toBeUndefined();
    expect(recovered.resumeFallbackMessage).toContain('旧会话无法恢复');
    expect(sdkEngine.updateSessionSdkSessionId).toHaveBeenCalledWith(
      'feishu:scope-1:binding-1',
      undefined,
    );
    expect(sdkEngine.resetSessionRuntime).toHaveBeenCalledWith(
      'feishu:scope-1:binding-1',
      'expire',
    );
    expect(store.saveBinding).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'binding-1',
      sdkSessionId: undefined,
    }));
    expect(state.getPermMode).toHaveBeenCalledWith('feishu', 'scope-1', 'binding-1');
    expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'chat-1',
      replyToMessageId: 'reply-1',
    }));
    expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(presenter.dispose).toHaveBeenCalledOnce();
    expect(sdkEngine.setControlsForChat).toHaveBeenCalledWith(
      'feishu:scope-1',
      undefined,
      'feishu:scope-1:binding-1',
    );
  });

  it('does not persist reply-routed bindings that are not the current binding', async () => {
    const { policy, store } = createPolicy();
    const adapter = createAdapter();

    await policy.recoverStaleSession({
      adapter: adapter as any,
      msg: {
        channelType: 'feishu',
        chatId: 'chat-1',
        userId: 'user-1',
        text: 'run',
        messageId: 'msg-1',
      },
      scopeId: 'scope-1',
      currentBinding: {
        channelType: 'feishu',
        chatId: 'scope-1',
        sessionId: 'reply-binding',
        sdkSessionId: 'sdk-old',
        createdAt: '2026-01-01T00:00:00Z',
      },
      sessionTarget: {
        sessionKey: 'feishu:old:reply-binding',
        bindingSessionId: 'reply-binding',
        workdir: '/work',
        sdkSessionId: 'sdk-old',
        source: 'reply',
      },
      renderer: { dispose: vi.fn() },
      presenter: { dispose: vi.fn() },
    });

    expect(store.saveBinding).not.toHaveBeenCalled();
  });
});
