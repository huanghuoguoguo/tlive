import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BaseChannelAdapter } from '../../channels/base.js';
import { FeishuFormatter } from '../../channels/feishu/formatter.js';
import { QueryOrchestrator } from '../../engine/coordinators/query.js';
import { SessionStateManager } from '../../engine/state/session-state.js';

const feishuFormatter = new FeishuFormatter('zh');
const defaultBinding = {
  channelType: 'feishu',
  chatId: 'chat-1',
  sessionId: 'session-1',
  createdAt: '2026-01-01T00:00:00Z',
};

function createAdapter(channelType = 'feishu'): BaseChannelAdapter {
  let sendCount = 0;
  return {
    channelType,
    getLocale: () => 'zh',
    send: vi.fn().mockImplementation(async () => {
      sendCount += 1;
      return { messageId: `out-${sendCount}`, success: true };
    }),
    editMessage: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(undefined),
    createStreamingSession: vi.fn().mockReturnValue(null),
    getLifecycleReactions: vi.fn().mockReturnValue({
      processing: '🤔',
      done: '👍',
      error: '😱',
      stalled: '⏳',
      permission: '🔐',
    }),
    getPermissionDecisionReaction: vi.fn().mockImplementation((decision: string) =>
      channelType === 'feishu'
        ? decision === 'deny' ? 'No' : decision === 'allow_always' ? 'DONE' : 'OK'
        : decision === 'deny' ? '👎' : decision === 'allow_always' ? '👌' : '👍'
    ),
    shouldRenderProgressPhase: vi.fn().mockReturnValue(true),
    shouldSplitCompletedTrace: vi.fn().mockReturnValue(false),
    shouldSplitProgressMessage: vi.fn().mockReturnValue(false),
    format: (msg: any) => feishuFormatter.format(msg),
    formatContent: (chatId: string, content: string, buttons?: any[]) =>
      feishuFormatter.formatContent(chatId, content, buttons),
    editCardResolution: vi.fn().mockResolvedValue(undefined),
  } as unknown as BaseChannelAdapter;
}

function createPermissions(overrides: Record<string, unknown> = {}) {
  return {
    clearSessionWhitelist: vi.fn(),
    getGateway: vi.fn().mockReturnValue({
      waitFor: vi.fn(),
      resolve: vi.fn(),
    }),
    setPendingSdkPerm: vi.fn(),
    clearPendingSdkPerm: vi.fn(),
    notePermissionPending: vi.fn(),
    notePermissionResolved: vi.fn(),
    clearPendingPermissionSnapshot: vi.fn(),
    isToolAllowed: vi.fn().mockReturnValue(false),
    rememberSessionAllowance: vi.fn(),
    storeQuestionData: vi.fn(),
    trackPermissionMessage: vi.fn(),
    cleanupQuestion: vi.fn(),
    ...overrides,
  } as any;
}

function createSdkEngine(overrides: Record<string, unknown> = {}) {
  return {
    getInteractionState: vi.fn().mockReturnValue({
      beginSdkQuestion: vi.fn(),
      cleanupSdkQuestion: vi.fn(),
      consumeSdkQuestionAnswer: vi.fn().mockReturnValue({}),
    }),
    getQuestionState: vi.fn().mockReturnValue({
      sdkQuestionData: new Map(),
      sdkQuestionAnswers: new Map(),
      sdkQuestionTextAnswers: new Map(),
    }),
    setControlsForChat: vi.fn(),
    setActiveMessageId: vi.fn(),
    registerFileDeliveryRoute: vi.fn().mockReturnValue('route-token'),
    closeSession: vi.fn(),
    getOrCreateSession: vi.fn().mockReturnValue(undefined),
    ...overrides,
  } as any;
}

describe('QueryOrchestrator', () => {
  let mockStore: any;
  const previousTliveHome = process.env.TLIVE_HOME;
  let tliveHome = '';

  beforeEach(() => {
    mockStore = {
      acquireLock: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
      getBinding: vi.fn().mockResolvedValue(defaultBinding),
      getBindingBySessionId: vi.fn().mockResolvedValue(defaultBinding),
      saveBinding: vi.fn().mockResolvedValue(undefined),
      listBindings: vi.fn(),
    };
  });

  afterEach(() => {
    if (tliveHome) {
      rmSync(tliveHome, { recursive: true, force: true });
      tliveHome = '';
    }
    if (previousTliveHome === undefined) {
      delete process.env.TLIVE_HOME;
    } else {
      process.env.TLIVE_HOME = previousTliveHome;
    }
  });

  function createHarness(options: {
    engine?: any;
    router?: any;
    permissions?: any;
    sdkEngine?: any;
    adapter?: BaseChannelAdapter;
    state?: SessionStateManager;
    onConversationMessageResolved?: any;
  } = {}) {
    const engine = options.engine ?? { processMessage: vi.fn().mockResolvedValue({ text: '' }) };
    const router = options.router ?? {
      resolve: vi.fn().mockResolvedValue({ ...defaultBinding }),
      rebind: vi.fn(),
    };
    const permissions = options.permissions ?? createPermissions();
    const sdkEngine = options.sdkEngine ?? createSdkEngine();
    const state = options.state ?? new SessionStateManager();
    const adapter = options.adapter ?? createAdapter();
    const orchestrator = new QueryOrchestrator({
      engine,
      llm: {} as any,
      router,
      state,
      permissions,
      sdkEngine,
      store: mockStore,
      defaultWorkdir: '/tmp/project',
      defaultAgentSettingSources: ['user', 'project', 'local'],
      port: 8080,
      onConversationMessageResolved: options.onConversationMessageResolved,
    });

    return { adapter, engine, orchestrator, permissions, router, sdkEngine, state };
  }

  function inbound(overrides: Record<string, unknown> = {}) {
    return {
      channelType: 'feishu',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'hello',
      messageId: 'msg-1',
      ...overrides,
    } as any;
  }

  it('persists sdk session id and marks the query as done', async () => {
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
    };
    const { adapter, orchestrator } = createHarness({ engine });

    await orchestrator.run(adapter, inbound());

    expect(mockStore.saveBinding).toHaveBeenCalledWith(
      expect.objectContaining({ sdkSessionId: 'sdk-2' }),
    );
    expect(adapter.sendTyping).toHaveBeenCalledWith('chat-1');
    expect(adapter.addReaction).toHaveBeenCalledWith('chat-1', 'msg-1', expect.any(String));
    expect(JSON.stringify((adapter.send as any).mock.calls[0][0])).toContain('hello');
  });

  it('renders backend errors as failed turns instead of marking them done', async () => {
    const engine = {
      processMessage: vi.fn().mockImplementation(async (params) => {
        await params.onError?.('backend exploded');
      }),
    };
    const { adapter, orchestrator } = createHarness({ engine });

    await orchestrator.run(adapter, inbound());

    expect(JSON.stringify((adapter.send as any).mock.calls[0][0])).toContain('backend exploded');
    expect(adapter.addReaction).toHaveBeenCalledWith('chat-1', 'msg-1', '😱');
    expect(adapter.addReaction).not.toHaveBeenCalledWith('chat-1', 'msg-1', '👍');
  });

  it('prepares file attachments before starting a live Claude turn', async () => {
    tliveHome = join(tmpdir(), `tlive-query-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    process.env.TLIVE_HOME = tliveHome;
    const engine = { processMessage: vi.fn().mockResolvedValue({ text: '' }) };
    const startTurn = vi.fn().mockReturnValue({
      stream: new ReadableStream({ start: controller => controller.close() }),
    });
    const sdkEngine = createSdkEngine({
      getOrCreateSession: vi.fn().mockReturnValue({ startTurn }),
    });
    const { adapter, orchestrator } = createHarness({ engine, sdkEngine });

    await orchestrator.run(adapter, inbound({
      text: 'please inspect',
      attachments: [
        {
          type: 'file',
          name: 'report.pdf',
          mimeType: 'application/pdf',
          base64Data: Buffer.from('pdf body').toString('base64'),
        },
        {
          type: 'image',
          name: 'photo.png',
          mimeType: 'image/png',
          base64Data: Buffer.from('png body').toString('base64'),
        },
      ],
    }));

    expect(startTurn).toHaveBeenCalledOnce();
    expect(startTurn.mock.calls[0][0]).toContain('report.pdf');
    expect(startTurn.mock.calls[0][0]).toContain('Path: `');
    expect(startTurn.mock.calls[0][1].attachments).toEqual([
      expect.objectContaining({ type: 'image', name: 'photo.png' }),
    ]);
    expect(engine.processMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('report.pdf'),
      attachments: [expect.objectContaining({ type: 'image', name: 'photo.png' })],
      streamResult: expect.any(Object),
    }));
  });

  it('uses the Feishu topic scope for session routing while sending to the real chat', async () => {
    const scopeId = 'chat-1#thread:thread-1';
    const topicBinding = { ...defaultBinding, chatId: scopeId };
    const router = {
      resolve: vi.fn().mockResolvedValue(topicBinding),
      rebind: vi.fn(),
    };
    const engine = {
      processMessage: vi.fn().mockImplementation(async (params) => {
        params.onTextDelta?.('topic reply');
        await params.onQueryResult?.({
          sessionId: 'sdk-topic',
          isError: false,
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        });
      }),
    };
    const { adapter, orchestrator, sdkEngine } = createHarness({ engine, router });

    await orchestrator.run(adapter, inbound({
      scopeId,
      threadId: 'thread-1',
      replyInThread: true,
      replyTargetMessageId: 'msg-topic-1',
      text: 'hello topic',
    }));

    expect(mockStore.getBinding).toHaveBeenCalledWith('feishu', scopeId);
    expect(sdkEngine.getOrCreateSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channelType: 'feishu',
        chatId: scopeId,
        bindingSessionId: topicBinding.sessionId,
        workdir: '/tmp/project',
      }),
    );
    expect((adapter.send as any).mock.calls[0][0]).toMatchObject({
      chatId: 'chat-1',
      replyToMessageId: 'msg-topic-1',
      replyInThread: true,
    });
  });

  it('auto-starts a Feishu topic for main-chat queries', async () => {
    const scopeId = 'chat-1#thread:thread-auto';
    const topicBinding = { ...defaultBinding, chatId: scopeId };
    mockStore.getBinding.mockImplementation(async (_channelType: string, chatId: string) =>
      chatId === scopeId ? null : defaultBinding
    );
    const router = {
      resolve: vi.fn().mockResolvedValue(topicBinding),
      rebind: vi.fn(),
    };
    const engine = {
      processMessage: vi.fn().mockImplementation(async (params) => {
        params.onTextDelta?.('auto topic reply');
        await params.onQueryResult?.({
          sessionId: 'sdk-topic',
          isError: false,
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        });
      }),
    };
    const adapter = createAdapter();
    (adapter as any).startThreadFromMessage = vi.fn().mockResolvedValue({
      threadId: 'thread-auto',
      messageId: 'msg-topic-start',
    });
    const onConversationMessageResolved = vi.fn();
    const { orchestrator, sdkEngine } = createHarness({
      adapter,
      engine,
      router,
      onConversationMessageResolved,
    });

    await orchestrator.run(adapter, inbound({
      text: 'start from main',
      messageId: 'msg-main-1',
    }));

    expect((adapter as any).startThreadFromMessage).toHaveBeenCalledWith(
      'chat-1',
      'msg-main-1',
      expect.any(String),
    );
    expect(router.resolve).toHaveBeenCalledWith('feishu', scopeId);
    expect(sdkEngine.getOrCreateSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channelType: 'feishu',
        chatId: scopeId,
        bindingSessionId: topicBinding.sessionId,
        workdir: '/tmp/project',
      }),
    );
    expect((adapter.send as any).mock.calls[0][0]).toMatchObject({
      chatId: 'chat-1',
      replyToMessageId: 'msg-topic-start',
      replyInThread: true,
    });
    expect(onConversationMessageResolved).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        scopeId,
        threadId: 'thread-auto',
        replyTargetMessageId: 'msg-topic-start',
        replyInThread: true,
      }),
      expect.objectContaining({
        chatId: 'chat-1',
        messageId: 'msg-main-1',
      }),
    );
  });

  it('asks SDK questions sequentially and returns answers for all prompts', async () => {
    const sdkQuestionData = new Map();
    const sdkQuestionAnswers = new Map();
    const sdkQuestionTextAnswers = new Map();
    let questionCount = 0;
    const gateway = {
      waitFor: vi.fn().mockImplementation(async () => {
        questionCount += 1;
        const permId = Array.from(sdkQuestionData.keys()).at(-1) as string;
        if (questionCount === 1) {
          sdkQuestionAnswers.set(permId, 1);
        } else {
          sdkQuestionTextAnswers.set(permId, '因为要兼容老接口');
        }
        return { behavior: 'allow' };
      }),
      resolve: vi.fn(),
    };
    const engine = {
      processMessage: vi.fn().mockImplementation(async (params) => {
        const answers = await params.sdkAskQuestionHandler?.([
          {
            question: '使用哪个方案？',
            header: '方案选择',
            options: [{ label: '方案 A' }, { label: '方案 B' }],
            multiSelect: false,
          },
          {
            question: '为什么这样做？',
            header: '补充说明',
            options: [],
            multiSelect: false,
          },
        ]);
        expect(answers).toEqual({
          '使用哪个方案？': '方案 B',
          '为什么这样做？': '因为要兼容老接口',
        });
        await params.onQueryResult?.({
          sessionId: 'sdk-2',
          isError: false,
          usage: { inputTokens: 2, outputTokens: 2, costUsd: 0.01 },
        });
      }),
    };
    const permissions = createPermissions({
      getGateway: vi.fn().mockReturnValue(gateway),
    });
    const sdkEngine = createSdkEngine({
      getInteractionState: vi.fn().mockReturnValue({
        beginSdkQuestion: (permId: string, questions: any, chatId: string) => {
          sdkQuestionData.set(permId, { questions, chatId });
        },
        consumeSdkQuestionAnswer: (permId: string) => {
          const textAnswer = sdkQuestionTextAnswers.get(permId);
          const optionIndex = sdkQuestionAnswers.get(permId);
          sdkQuestionTextAnswers.delete(permId);
          sdkQuestionAnswers.delete(permId);
          return { textAnswer, optionIndex };
        },
        cleanupSdkQuestion: (permId: string) => {
          sdkQuestionData.delete(permId);
          sdkQuestionAnswers.delete(permId);
          sdkQuestionTextAnswers.delete(permId);
        },
      }),
      getQuestionState: vi.fn().mockReturnValue({
        sdkQuestionData,
        sdkQuestionAnswers,
        sdkQuestionTextAnswers,
      }),
    });
    const { adapter, orchestrator } = createHarness({ engine, permissions, sdkEngine });

    await orchestrator.run(adapter, inbound());

    expect(gateway.waitFor).toHaveBeenCalledTimes(2);
    expect(permissions.trackPermissionMessage).toHaveBeenCalledTimes(2);
    expect(permissions.cleanupQuestion).toHaveBeenCalledTimes(2);
    const questionCards = (adapter.send as any).mock.calls
      .map((call: any[]) => call[0])
      .filter((message: any) => message.feishuHeader?.title?.includes('等待回答'));
    expect(questionCards).toHaveLength(2);
  });

  it('uses binding setting sources instead of the default fallback', async () => {
    mockStore.getBinding.mockResolvedValue({ ...defaultBinding, agentSettingSources: ['user'] });
    const engine = {
      processMessage: vi.fn().mockImplementation(async (params) => {
        expect(params.settingSources).toEqual(['user']);
        await params.onQueryResult?.({
          sessionId: 'sdk-2',
          isError: false,
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      }),
    };
    const router = {
      resolve: vi.fn().mockResolvedValue({ ...defaultBinding, agentSettingSources: ['user'] }),
      rebind: vi.fn(),
    };
    const { orchestrator, sdkEngine } = createHarness({ engine, router });

    await orchestrator.run(createAdapter(), inbound());

    expect(sdkEngine.getOrCreateSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channelType: 'feishu',
        chatId: 'chat-1',
        bindingSessionId: 'session-1',
        workdir: '/tmp/project',
        options: expect.objectContaining({ settingSources: ['user'] }),
      }),
    );
  });
});
