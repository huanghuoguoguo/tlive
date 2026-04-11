import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseChannelAdapter } from '../channels/base.js';
import { initBridgeContext } from '../context.js';
import { QueryOrchestrator } from '../engine/query-orchestrator.js';
import { SessionStateManager } from '../engine/session-state.js';
import { FeishuFormatter } from '../formatting/feishu-formatter.js';
import { TelegramFormatter } from '../formatting/telegram-formatter.js';

const telegramFormatter = new TelegramFormatter('en');
const feishuFormatter = new FeishuFormatter('zh');

function createAdapter(channelType = 'telegram'): BaseChannelAdapter {
  const formatter = channelType === 'feishu' ? feishuFormatter : telegramFormatter;
  return {
    channelType,
    send: vi.fn().mockResolvedValue({ messageId: 'out-1', success: true }),
    editMessage: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(undefined),
    format: (msg: any) => formatter.format(msg),
    formatContent: (chatId: string, content: string, buttons?: any[]) => formatter.formatContent(chatId, content, buttons),
    supportsRichCards: () => formatter.hasRichCardSupport(),
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
});
