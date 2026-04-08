import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseChannelAdapter } from '../channels/base.js';
import { initBridgeContext } from '../context.js';
import { QueryOrchestrator } from '../engine/query-orchestrator.js';
import { SessionStateManager } from '../engine/session-state.js';

function createAdapter(channelType = 'telegram'): BaseChannelAdapter {
  return {
    channelType,
    send: vi.fn().mockResolvedValue({ messageId: 'out-1', success: true }),
    editMessage: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(undefined),
  } as unknown as BaseChannelAdapter;
}

describe('QueryOrchestrator', () => {
  const binding = {
    channelType: 'telegram',
    chatId: 'chat-1',
    sessionId: 'session-1',
    createdAt: '2026-01-01T00:00:00Z',
  };
  let mockStore: any;

  beforeEach(() => {
    mockStore = {
      acquireLock: vi.fn().mockResolvedValue(true),
      renewLock: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
      getBinding: vi.fn().mockResolvedValue(binding),
      saveBinding: vi.fn().mockResolvedValue(undefined),
      deleteBinding: vi.fn(),
      listBindings: vi.fn(),
      isDuplicate: vi.fn().mockResolvedValue(false),
      markProcessed: vi.fn(),
    };
    initBridgeContext({
      defaultWorkdir: '/tmp/project',
      store: mockStore,
      llm: {} as any,
      core: null,
    });
  });

  it('persists sdk session id and marks the query as done', async () => {
    const state = new SessionStateManager();
    const engine = {
      processMessage: vi.fn().mockImplementation(async (params) => {
        await params.onSdkSessionId?.('sdk-2');
        params.onTextDelta?.('hello');
        await params.onQueryResult?.({
          sessionId: 'sdk-2',
          isError: false,
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
        });
      }),
    } as any;
    const router = {
      resolve: vi.fn().mockResolvedValue({ ...binding }),
      rebind: vi.fn(),
    } as any;
    const permissions = {
      clearSessionWhitelist: vi.fn(),
      getGateway: vi.fn().mockReturnValue({
        waitFor: vi.fn(),
        resolve: vi.fn(),
      }),
      setPendingSdkPerm: vi.fn(),
      clearPendingSdkPerm: vi.fn(),
      isToolAllowed: vi.fn().mockReturnValue(false),
      storeQuestionData: vi.fn(),
      trackPermissionMessage: vi.fn(),
    } as any;
    const sdkEngine = {
      getQuestionState: vi.fn().mockReturnValue({
        sdkQuestionData: new Map(),
        sdkQuestionAnswers: new Map(),
        sdkQuestionTextAnswers: new Map(),
      }),
      setControlsForChat: vi.fn(),
    } as any;
    const adapter = createAdapter();

    const orchestrator = new QueryOrchestrator({
      engine,
      router,
      state,
      permissions,
      sdkEngine,
      store: mockStore,
      defaultWorkdir: '/tmp/project',
      port: 8080,
      token: 'token',
      isCoreAvailable: () => true,
    });

    await orchestrator.run(adapter, {
      channelType: 'telegram',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'hello',
      messageId: 'msg-1',
    });

    expect(mockStore.saveBinding).toHaveBeenCalledWith(expect.objectContaining({ sdkSessionId: 'sdk-2' }));
    expect(adapter.sendTyping).toHaveBeenCalledWith('chat-1');
    expect(adapter.addReaction).toHaveBeenCalledWith('chat-1', 'msg-1', expect.any(String));
    expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({ html: expect.stringContaining('hello') }));
  });
});
