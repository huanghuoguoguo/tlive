import { describe, expect, it, vi } from 'vitest';
import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import { MessageLoopCoordinator } from '../../engine/coordinators/message-loop.js';
import { SessionStateManager } from '../../engine/state/session-state.js';
import type { SendWithContextResult } from '../../engine/sdk/engine.js';

function createAdapter(channelType = 'telegram'): BaseChannelAdapter {
  return {
    channelType,
    send: vi.fn().mockResolvedValue({ messageId: '1', success: true }),
  } as unknown as BaseChannelAdapter;
}

function createMessage(text: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channelType: 'telegram',
    chatId: 'chat-1',
    userId: 'user-1',
    text,
    messageId: 'msg-1',
    ...overrides,
  };
}

function createCoordinator(
  state: SessionStateManager,
  sdkEngine: any,
  permissions: any,
  resolveProcessingKey?: (msg: InboundMessage) => Promise<string>,
): MessageLoopCoordinator {
  return new MessageLoopCoordinator({
    state,
    sdkEngine,
    permissions,
    quickCommands: new Set(),
    hasPendingSdkQuestion: () => false,
    resolveProcessingKey: resolveProcessingKey
      ?? (async (msg) => msg.replyToMessageId ? 'session-2' : state.stateKey(msg.channelType, msg.chatId)),
  });
}

describe('MessageLoopCoordinator', () => {
  it('classifies commands and pending questions as quick messages', () => {
    const state = new SessionStateManager();
    const sdkEngine = {
      sendWithContext: vi.fn().mockResolvedValue({ sent: false, mode: 'none' }),
      MAX_QUEUE_DEPTH: 3,
    } as any;
    const permissions = {
      getLatestPendingQuestion: vi.fn().mockReturnValue(null),
      parsePermissionText: vi.fn().mockReturnValue(null),
    } as any;

    const coordinator = new MessageLoopCoordinator({
      state,
      sdkEngine,
      permissions,
      quickCommands: new Set(['/status']),
      hasPendingSdkQuestion: () => false,
      resolveProcessingKey: async (msg) => state.stateKey(msg.channelType, msg.chatId),
    });

    expect(coordinator.isQuickMessage(createAdapter(), createMessage('/status'))).toBe(true);

    permissions.getLatestPendingQuestion.mockReturnValue({ hookId: 'q1' });
    expect(coordinator.isQuickMessage(createAdapter(), createMessage('hello'))).toBe(true);
  });

  it('steers the active session when turn is active', async () => {
    const state = new SessionStateManager();
    const chatKey = state.stateKey('telegram', 'chat-1');
    state.setProcessing(chatKey, true);

    const sdkEngine = {
      sendWithContext: vi.fn().mockResolvedValue({ sent: true, mode: 'steer', sessionKey: 'session-1' }),
      MAX_QUEUE_DEPTH: 3,
    } as any;
    const permissions = {
      getLatestPendingQuestion: vi.fn().mockReturnValue(null),
      parsePermissionText: vi.fn().mockReturnValue(null),
    } as any;

    const coordinator = createCoordinator(state, sdkEngine, permissions);
    const adapter = createAdapter();

    await coordinator.dispatchSlowMessage({
      adapter,
      msg: createMessage('follow-up'),
      coalesceMessage: async (_adapter, msg) => msg,
      handleMessage: vi.fn(),
      onError: vi.fn(),
    });

    expect(sdkEngine.sendWithContext).toHaveBeenCalledWith('telegram', 'chat-1', 'follow-up', undefined);
    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: '💬 已插入当前会话' }),
    );
  });

  it('queues follow-up messages when turn is not active', async () => {
    const state = new SessionStateManager();
    const chatKey = state.stateKey('telegram', 'chat-1');
    state.setProcessing(chatKey, true);

    const sdkEngine = {
      sendWithContext: vi.fn().mockResolvedValue({ sent: true, mode: 'queue', sessionKey: 'session-1', queuePosition: 1 }),
      MAX_QUEUE_DEPTH: 3,
    } as any;
    const permissions = {
      getLatestPendingQuestion: vi.fn().mockReturnValue(null),
      parsePermissionText: vi.fn().mockReturnValue(null),
    } as any;

    const coordinator = createCoordinator(state, sdkEngine, permissions);
    const adapter = createAdapter();

    await coordinator.dispatchSlowMessage({
      adapter,
      msg: createMessage('queued follow-up'),
      coalesceMessage: async (_adapter, msg) => msg,
      handleMessage: vi.fn(),
      onError: vi.fn(),
    });

    expect(sdkEngine.sendWithContext).toHaveBeenCalledWith('telegram', 'chat-1', 'queued follow-up', undefined);
    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: '📥 已排队（位置 1/3），当前任务结束后继续处理' }),
    );
  });

  it('shows queue position for subsequent queued messages', async () => {
    const state = new SessionStateManager();
    const chatKey = state.stateKey('telegram', 'chat-1');
    state.setProcessing(chatKey, true);

    const sdkEngine = {
      sendWithContext: vi.fn().mockResolvedValue({ sent: true, mode: 'queue', sessionKey: 'session-1', queuePosition: 2 }),
      MAX_QUEUE_DEPTH: 3,
    } as any;
    const permissions = {
      getLatestPendingQuestion: vi.fn().mockReturnValue(null),
      parsePermissionText: vi.fn().mockReturnValue(null),
    } as any;

    const coordinator = createCoordinator(state, sdkEngine, permissions);
    const adapter = createAdapter();

    await coordinator.dispatchSlowMessage({
      adapter,
      msg: createMessage('second queued message'),
      coalesceMessage: async (_adapter, msg) => msg,
      handleMessage: vi.fn(),
      onError: vi.fn(),
    });

    expect(sdkEngine.sendWithContext).toHaveBeenCalledWith('telegram', 'chat-1', 'second queued message', undefined);
    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: '📥 已排队（位置 2/3），当前任务结束后继续处理' }),
    );
  });

  it('rejects message when queue is full', async () => {
    const state = new SessionStateManager();
    const chatKey = state.stateKey('telegram', 'chat-1');
    state.setProcessing(chatKey, true);

    const sdkEngine = {
      sendWithContext: vi.fn().mockResolvedValue({ sent: false, mode: 'queue', sessionKey: 'session-1', queueFull: true }),
      MAX_QUEUE_DEPTH: 3,
    } as any;
    const permissions = {
      getLatestPendingQuestion: vi.fn().mockReturnValue(null),
      parsePermissionText: vi.fn().mockReturnValue(null),
    } as any;

    const coordinator = createCoordinator(state, sdkEngine, permissions);
    const adapter = createAdapter();

    await coordinator.dispatchSlowMessage({
      adapter,
      msg: createMessage('message when queue full'),
      coalesceMessage: async (_adapter, msg) => msg,
      handleMessage: vi.fn(),
      onError: vi.fn(),
    });

    expect(sdkEngine.sendWithContext).toHaveBeenCalledWith('telegram', 'chat-1', 'message when queue full', undefined);
    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: '⚠️ 排队已满（3/3），请稍后再发' }),
    );
  });

  it('warns when reply target session is missing', async () => {
    const state = new SessionStateManager();
    state.setProcessing('session-2', true);

    const sdkEngine = {
      sendWithContext: vi.fn().mockResolvedValue({
        sent: false,
        mode: 'none',
        failureReason: 'reply_target_missing',
      } satisfies SendWithContextResult),
      MAX_QUEUE_DEPTH: 3,
    } as any;
    const permissions = {
      getLatestPendingQuestion: vi.fn().mockReturnValue(null),
      parsePermissionText: vi.fn().mockReturnValue(null),
    } as any;

    const coordinator = createCoordinator(state, sdkEngine, permissions);
    const adapter = createAdapter();

    await coordinator.dispatchSlowMessage({
      adapter,
      msg: createMessage('reply to missing bubble', { replyToMessageId: 'bubble-missing' }),
      coalesceMessage: async (_adapter, msg) => msg,
      handleMessage: vi.fn(),
      onError: vi.fn(),
    });

    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: '⚠️ 引用的会话已失效，请直接发送消息或切换会话后重试' }),
    );
  });

  it('warns when session injection fails', async () => {
    const state = new SessionStateManager();
    const chatKey = state.stateKey('telegram', 'chat-1');
    state.setProcessing(chatKey, true);

    const sdkEngine = {
      sendWithContext: vi.fn().mockResolvedValue({
        sent: false,
        mode: 'none',
        sessionKey: 'session-1',
        failureReason: 'send_failed',
      } satisfies SendWithContextResult),
      MAX_QUEUE_DEPTH: 3,
    } as any;
    const permissions = {
      getLatestPendingQuestion: vi.fn().mockReturnValue(null),
      parsePermissionText: vi.fn().mockReturnValue(null),
    } as any;

    const coordinator = createCoordinator(state, sdkEngine, permissions);
    const adapter = createAdapter();

    await coordinator.dispatchSlowMessage({
      adapter,
      msg: createMessage('message when injection fails'),
      coalesceMessage: async (_adapter, msg) => msg,
      handleMessage: vi.fn(),
      onError: vi.fn(),
    });

    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: '⚠️ 会话注入失败，请稍后重试' }),
    );
  });

  it('steers to specific session when replying to a bubble', async () => {
    const state = new SessionStateManager();
    state.setProcessing('session-2', true);

    const sdkEngine = {
      sendWithContext: vi.fn().mockResolvedValue({ sent: true, mode: 'steer', sessionKey: 'session-2' }),
      MAX_QUEUE_DEPTH: 3,
    } as any;
    const permissions = {
      getLatestPendingQuestion: vi.fn().mockReturnValue(null),
      parsePermissionText: vi.fn().mockReturnValue(null),
    } as any;

    const coordinator = createCoordinator(state, sdkEngine, permissions);
    const adapter = createAdapter();

    await coordinator.dispatchSlowMessage({
      adapter,
      msg: createMessage('reply to bubble', { replyToMessageId: 'bubble-1' }),
      coalesceMessage: async (_adapter, msg) => msg,
      handleMessage: vi.fn(),
      onError: vi.fn(),
    });

    expect(sdkEngine.sendWithContext).toHaveBeenCalledWith('telegram', 'chat-1', 'reply to bubble', 'bubble-1');
    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: '💬 已插入当前会话' }),
    );
  });

  it('prompts user when no active session found', async () => {
    const state = new SessionStateManager();
    const chatKey = state.stateKey('telegram', 'chat-1');
    state.setProcessing(chatKey, true);

    const sdkEngine = {
      sendWithContext: vi.fn().mockResolvedValue({ sent: false, mode: 'none' }),
      MAX_QUEUE_DEPTH: 3,
    } as any;
    const permissions = {
      getLatestPendingQuestion: vi.fn().mockReturnValue(null),
      parsePermissionText: vi.fn().mockReturnValue(null),
    } as any;

    const coordinator = createCoordinator(state, sdkEngine, permissions);
    const adapter = createAdapter();

    await coordinator.dispatchSlowMessage({
      adapter,
      msg: createMessage('no session'),
      coalesceMessage: async (_adapter, msg) => msg,
      handleMessage: vi.fn(),
      onError: vi.fn(),
    });

    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: '⚠️ 无活跃会话，请先开始任务' }),
    );
  });

  it('allows a different reply-target session to run in parallel', async () => {
    const state = new SessionStateManager();
    state.setProcessing('session-1', true);

    const sdkEngine = {
      sendWithContext: vi.fn(),
      MAX_QUEUE_DEPTH: 3,
    } as any;
    const permissions = {
      getLatestPendingQuestion: vi.fn().mockReturnValue(null),
      parsePermissionText: vi.fn().mockReturnValue(null),
    } as any;
    const coordinator = createCoordinator(
      state,
      sdkEngine,
      permissions,
      async (msg) => msg.replyToMessageId === 'bubble-2' ? 'session-2' : 'session-1',
    );
    const adapter = createAdapter();
    const handleMessage = vi.fn().mockResolvedValue(undefined);

    await coordinator.dispatchSlowMessage({
      adapter,
      msg: createMessage('run on another session', { replyToMessageId: 'bubble-2' }),
      coalesceMessage: async (_adapter, msg) => msg,
      handleMessage,
      onError: vi.fn(),
    });

    expect(handleMessage).toHaveBeenCalled();
    expect(sdkEngine.sendWithContext).not.toHaveBeenCalled();
  });
});
