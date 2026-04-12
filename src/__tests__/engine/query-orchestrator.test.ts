import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseChannelAdapter } from '../../channels/base.js';
import { initBridgeContext } from '../../context.js';
import { QueryOrchestrator } from '../../engine/coordinators/query.js';
import { SessionStateManager } from '../../engine/state/session-state.js';
import { FeishuFormatter } from '../../platforms/feishu/formatter.js';
import { QQBotFormatter } from '../../platforms/qqbot/formatter.js';
import { TelegramFormatter } from '../../platforms/telegram/formatter.js';

const telegramFormatter = new TelegramFormatter('en');
const feishuFormatter = new FeishuFormatter('zh');
const qqbotFormatter = new QQBotFormatter('zh');

function createAdapter(channelType = 'telegram'): BaseChannelAdapter {
  const formatter = channelType === 'feishu'
    ? feishuFormatter
    : channelType === 'qqbot'
      ? qqbotFormatter
      : telegramFormatter;
  let sendCount = 0;
  return {
    channelType,
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
    shouldRenderProgressPhase: vi.fn().mockImplementation((phase: string) =>
      channelType === 'qqbot' ? phase !== 'starting' && phase !== 'executing' : true
    ),
    shouldSplitCompletedTrace: vi.fn().mockImplementation((stats: any) => {
      if (channelType !== 'feishu') return false;
      const hasLongTrace = stats.thinkingTextLength > 80 || stats.timelineLength >= 4;
      const hasMeaningfulTooling = stats.toolEntries >= 2 || (stats.toolEntries >= 1 && stats.thinkingEntries >= 1);
      const hasLongAnswer = stats.responseTextLength > 200;
      return hasMeaningfulTooling || hasLongTrace || (stats.toolEntries >= 1 && hasLongAnswer);
    }),
    shouldSplitProgressMessage: vi.fn().mockReturnValue(false),
    format: (msg: any) => formatter.format(msg),
    formatContent: (chatId: string, content: string, buttons?: any[]) => formatter.formatContent(chatId, content, buttons),
    editCardResolution: vi.fn().mockResolvedValue(undefined),
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
      notePermissionPending: vi.fn(),
      notePermissionResolved: vi.fn(),
      clearPendingPermissionSnapshot: vi.fn(),
      isToolAllowed: vi.fn().mockReturnValue(false),
      rememberSessionAllowance: vi.fn(),
      storeQuestionData: vi.fn(),
      trackPermissionMessage: vi.fn(),
    } as any;
    const sdkEngine = {
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
      closeSession: vi.fn(),
      getOrCreateSession: vi.fn().mockReturnValue(undefined),
    } as any;
    const adapter = createAdapter();
    const llm = {} as any;

    const orchestrator = new QueryOrchestrator({
      engine,
      llm,
      router,
      state,
      permissions,
      sdkEngine,
      store: mockStore,
      defaultWorkdir: '/tmp/project',
      defaultClaudeSettingSources: ['user', 'project', 'local'],
      port: 8080,
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

  it('splits Feishu completion into trace edit plus a separate result bubble', async () => {
    const state = new SessionStateManager();
    const engine = {
      processMessage: vi.fn().mockImplementation(async (params) => {
        params.onThinkingDelta?.('先检查代码');
        params.onToolStart?.({ name: 'Read', input: { file_path: 'src/main.ts' }, id: 'tool-1' });
        params.onToolResult?.({ toolUseId: 'tool-1', content: 'ok', isError: false });
        params.onTextDelta?.('最终答案');
        await params.onQueryResult?.({
          sessionId: 'sdk-2',
          isError: false,
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
        });
      }),
    } as any;
    const router = {
      resolve: vi.fn().mockResolvedValue({ ...binding, channelType: 'feishu' }),
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
      notePermissionPending: vi.fn(),
      notePermissionResolved: vi.fn(),
      clearPendingPermissionSnapshot: vi.fn(),
      isToolAllowed: vi.fn().mockReturnValue(false),
      rememberSessionAllowance: vi.fn(),
      storeQuestionData: vi.fn(),
      trackPermissionMessage: vi.fn(),
    } as any;
    const sdkEngine = {
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
      closeSession: vi.fn(),
      getOrCreateSession: vi.fn().mockReturnValue(undefined),
    } as any;
    const adapter = createAdapter('feishu');
    const llm = {} as any;

    const orchestrator = new QueryOrchestrator({
      engine,
      llm,
      router,
      state,
      permissions,
      sdkEngine,
      store: mockStore,
      defaultWorkdir: '/tmp/project',
      defaultClaudeSettingSources: ['user', 'project', 'local'],
      port: 8080,
    });

    await orchestrator.run(adapter, {
      channelType: 'feishu',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'hello',
      messageId: 'msg-1',
    });

    expect(adapter.send).toHaveBeenCalledTimes(2);
    const traceMessage = (adapter.send as any).mock.calls[0][0];
    expect(traceMessage.feishuHeader.title).toContain('已完成');
    const finalMessage = (adapter.send as any).mock.calls[1][0];
    expect(finalMessage.feishuHeader.title).toContain('任务摘要');
    const finalContent = (finalMessage.feishuElements ?? []).map((e: any) => e.content || '').join('\n');
    expect(finalContent).toContain('最终答案');
    expect(adapter.editMessage).not.toHaveBeenCalled();
  });

  it('keeps short Feishu replies in a single bubble when there is no meaningful trace', async () => {
    const state = new SessionStateManager();
    const engine = {
      processMessage: vi.fn().mockImplementation(async (params) => {
        params.onTextDelta?.('简短答复');
        await params.onQueryResult?.({
          sessionId: 'sdk-2',
          isError: false,
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
        });
      }),
    } as any;
    const router = {
      resolve: vi.fn().mockResolvedValue({ ...binding, channelType: 'feishu' }),
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
      notePermissionPending: vi.fn(),
      notePermissionResolved: vi.fn(),
      clearPendingPermissionSnapshot: vi.fn(),
      isToolAllowed: vi.fn().mockReturnValue(false),
      rememberSessionAllowance: vi.fn(),
      storeQuestionData: vi.fn(),
      trackPermissionMessage: vi.fn(),
    } as any;
    const sdkEngine = {
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
      closeSession: vi.fn(),
      getOrCreateSession: vi.fn().mockReturnValue(undefined),
    } as any;
    const adapter = createAdapter('feishu');
    const llm = {} as any;

    const orchestrator = new QueryOrchestrator({
      engine,
      llm,
      router,
      state,
      permissions,
      sdkEngine,
      store: mockStore,
      defaultWorkdir: '/tmp/project',
      defaultClaudeSettingSources: ['user', 'project', 'local'],
      port: 8080,
    });

    await orchestrator.run(adapter, {
      channelType: 'feishu',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'hello',
      messageId: 'msg-1',
    });

    expect(adapter.send).toHaveBeenCalledTimes(1);
    const onlyMessage = (adapter.send as any).mock.calls[0][0];
    const content = (onlyMessage.feishuElements ?? []).map((e: any) => e.content || '').join('\n');
    expect(content).toContain('简短答复');
    expect(adapter.editMessage).not.toHaveBeenCalled();
  });

  it('edits Feishu progress cards during execution instead of using streaming cards', async () => {
    const state = new SessionStateManager();
    const engine = {
      processMessage: vi.fn().mockImplementation(async (params) => {
        params.onThinkingDelta?.('先读取相关文件');
        params.onToolStart?.({ name: 'Read', input: { file_path: 'src/main.ts' }, id: 'tool-1' });
        await new Promise(resolve => setTimeout(resolve, 10));
        params.onToolResult?.({ toolUseId: 'tool-1', content: '文件内容', isError: false });
        params.onTextDelta?.('第一段');
        await new Promise(resolve => setTimeout(resolve, 10));
        params.onTextDelta?.('第二段');
        await params.onQueryResult?.({
          sessionId: 'sdk-2',
          isError: false,
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
        });
      }),
    } as any;
    const router = {
      resolve: vi.fn().mockResolvedValue({ ...binding, channelType: 'feishu' }),
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
      notePermissionPending: vi.fn(),
      notePermissionResolved: vi.fn(),
      clearPendingPermissionSnapshot: vi.fn(),
      isToolAllowed: vi.fn().mockReturnValue(false),
      rememberSessionAllowance: vi.fn(),
      storeQuestionData: vi.fn(),
      trackPermissionMessage: vi.fn(),
    } as any;
    const sdkEngine = {
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
      closeSession: vi.fn(),
      getOrCreateSession: vi.fn().mockReturnValue(undefined),
    } as any;
    const adapter = createAdapter('feishu');
    const orchestrator = new QueryOrchestrator({
      engine,
      llm: {} as any,
      router,
      state,
      permissions,
      sdkEngine,
      store: mockStore,
      defaultWorkdir: '/tmp/project',
      defaultClaudeSettingSources: ['user', 'project', 'local'],
      port: 8080,
    });

    await orchestrator.run(adapter, {
      channelType: 'feishu',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'hello',
      messageId: 'msg-1',
    });

    expect(adapter.createStreamingSession).not.toHaveBeenCalled();
    expect(adapter.send).toHaveBeenCalled();
    expect(adapter.editMessage).toHaveBeenCalled();

    const editedProgressCard = (adapter.editMessage as any).mock.calls
      .map((call: any[]) => call[2])
      .find((message: any) => (message?.feishuElements ?? []).some((el: any) => el.tag === 'collapsible_panel'));
    expect(editedProgressCard).toBeDefined();

    const progressPanels = (editedProgressCard.feishuElements ?? []).filter((el: any) => el.tag === 'collapsible_panel');
    expect(progressPanels.length).toBeGreaterThan(0);

    const firstPanelContent = progressPanels[0].elements?.[0]?.content ?? '';
    expect(firstPanelContent).toContain('先读取相关文件');
    expect(firstPanelContent).toContain('src/main.ts');

    const sentContents = (adapter.send as any).mock.calls
      .map((call: any[]) => call[0])
      .flatMap((message: any) => (message?.feishuElements ?? []).map((el: any) => el.content || ''))
      .join('\n');
    expect(sentContents).toContain('第一段第二段');
  });

  it('remembers allow_always approvals within the current bridge session', async () => {
    const state = new SessionStateManager();
    const engine = {
      processMessage: vi.fn().mockImplementation(async (params) => {
        await params.sdkPermissionHandler?.('Edit', { file_path: 'src/main.ts' }, 'Need edit');
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
        waitFor: vi.fn().mockResolvedValue({ behavior: 'allow_always' }),
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
    } as any;
    const sdkEngine = {
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
      closeSession: vi.fn(),
      getOrCreateSession: vi.fn().mockReturnValue(undefined),
    } as any;

    const orchestrator = new QueryOrchestrator({
      engine,
      llm: {} as any,
      router,
      state,
      permissions,
      sdkEngine,
      store: mockStore,
      defaultWorkdir: '/tmp/project',
      defaultClaudeSettingSources: ['user', 'project', 'local'],
      port: 8080,
    });

    await orchestrator.run(createAdapter(), {
      channelType: 'telegram',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'hello',
      messageId: 'msg-1',
    });

    expect(permissions.isToolAllowed).toHaveBeenCalledWith('session-1', 'Edit', { file_path: 'src/main.ts' });
    expect(permissions.rememberSessionAllowance).toHaveBeenCalledWith(
      'session-1',
      'Edit',
      { file_path: 'src/main.ts' },
    );
  });

  it('asks SDK questions sequentially and returns answers for all prompts', async () => {
    const state = new SessionStateManager();
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
            options: [
              { label: '方案 A' },
              { label: '方案 B' },
            ],
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
    } as any;
    const router = {
      resolve: vi.fn().mockResolvedValue({ ...binding }),
      rebind: vi.fn(),
    } as any;
    const permissions = {
      clearSessionWhitelist: vi.fn(),
      getGateway: vi.fn().mockReturnValue(gateway),
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
    } as any;
    const sdkEngine = {
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
      setControlsForChat: vi.fn(),
      setActiveMessageId: vi.fn(),
      closeSession: vi.fn(),
      getOrCreateSession: vi.fn().mockReturnValue(undefined),
    } as any;
    const adapter = createAdapter('feishu');

    const orchestrator = new QueryOrchestrator({
      engine,
      llm: {} as any,
      router,
      state,
      permissions,
      sdkEngine,
      store: mockStore,
      defaultWorkdir: '/tmp/project',
      defaultClaudeSettingSources: ['user', 'project', 'local'],
      port: 8080,
    });

    await orchestrator.run(adapter, {
      channelType: 'feishu',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'hello',
      messageId: 'msg-1',
    });

    expect(gateway.waitFor).toHaveBeenCalledTimes(2);
    expect(permissions.trackPermissionMessage).toHaveBeenCalledTimes(2);
    expect(permissions.cleanupQuestion).toHaveBeenCalledTimes(2);
    const questionCards = (adapter.send as any).mock.calls
      .map((call: any[]) => call[0])
      .filter((message: any) => message.feishuHeader?.title?.includes('等待回答'));
    expect(questionCards).toHaveLength(2);
  });

  it('uses binding setting sources instead of the default fallback', async () => {
    const state = new SessionStateManager();
    const engine = {
      processMessage: vi.fn().mockImplementation(async (params) => {
        expect(params.settingSources).toEqual(['user']);
        await params.onQueryResult?.({
          sessionId: 'sdk-2',
          isError: false,
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      }),
    } as any;
    const router = {
      resolve: vi.fn().mockResolvedValue({ ...binding, claudeSettingSources: ['user'] }),
      rebind: vi.fn(),
    } as any;
    const permissions = {
      clearSessionWhitelist: vi.fn(),
      getGateway: vi.fn().mockReturnValue({ waitFor: vi.fn(), resolve: vi.fn() }),
      setPendingSdkPerm: vi.fn(),
      clearPendingSdkPerm: vi.fn(),
      notePermissionPending: vi.fn(),
      notePermissionResolved: vi.fn(),
      clearPendingPermissionSnapshot: vi.fn(),
      isToolAllowed: vi.fn().mockReturnValue(false),
      rememberSessionAllowance: vi.fn(),
      storeQuestionData: vi.fn(),
      trackPermissionMessage: vi.fn(),
    } as any;
    const sdkEngine = {
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
      closeSession: vi.fn(),
      getOrCreateSession: vi.fn().mockReturnValue(undefined),
    } as any;

    const orchestrator = new QueryOrchestrator({
      engine,
      llm: {} as any,
      router,
      state,
      permissions,
      sdkEngine,
      store: mockStore,
      defaultWorkdir: '/tmp/project',
      defaultClaudeSettingSources: ['user', 'project', 'local'],
      port: 8080,
    });

    await orchestrator.run(createAdapter(), {
      channelType: 'telegram',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'hello',
      messageId: 'msg-1',
    });

    expect(sdkEngine.getOrCreateSession).toHaveBeenCalledWith(
      expect.anything(),
      'telegram',
      'chat-1',
      '/tmp/project',
      expect.objectContaining({ settingSources: ['user'] }),
    );
  });

  it('qqbot sends only the final result instead of streaming progress bubbles', async () => {
    const state = new SessionStateManager();
    const engine = {
      processMessage: vi.fn().mockImplementation(async (params) => {
        params.onTextDelta?.('第一段');
        params.onTextDelta?.('第二段');
        await params.onQueryResult?.({
          sessionId: 'sdk-2',
          isError: false,
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
        });
      }),
    } as any;
    const router = {
      resolve: vi.fn().mockResolvedValue({ ...binding, channelType: 'qqbot' }),
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
      notePermissionPending: vi.fn(),
      notePermissionResolved: vi.fn(),
      clearPendingPermissionSnapshot: vi.fn(),
      isToolAllowed: vi.fn().mockReturnValue(false),
      rememberSessionAllowance: vi.fn(),
      storeQuestionData: vi.fn(),
      trackPermissionMessage: vi.fn(),
    } as any;
    const sdkEngine = {
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
      closeSession: vi.fn(),
      getOrCreateSession: vi.fn().mockReturnValue(undefined),
    } as any;
    const adapter = createAdapter('qqbot');

    const orchestrator = new QueryOrchestrator({
      engine,
      llm: {} as any,
      router,
      state,
      permissions,
      sdkEngine,
      store: mockStore,
      defaultWorkdir: '/tmp/project',
      defaultClaudeSettingSources: ['user', 'project', 'local'],
      port: 8080,
    });

    await orchestrator.run(adapter, {
      channelType: 'qqbot',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'hello',
      messageId: 'msg-1',
    });

    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('第一段第二段'),
      }),
    );
    expect(adapter.editMessage).not.toHaveBeenCalled();
  });
});
