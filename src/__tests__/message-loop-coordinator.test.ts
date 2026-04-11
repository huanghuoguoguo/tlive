import { describe, expect, it, vi } from 'vitest';
import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import { MessageLoopCoordinator } from '../engine/message-loop-coordinator.js';
import { SessionStateManager } from '../engine/session-state.js';

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

describe('MessageLoopCoordinator', () => {
  it('classifies commands and pending questions as quick messages', () => {
    const state = new SessionStateManager();
    const sdkEngine = {
      sendWithContext: vi.fn().mockResolvedValue({ sent: false, mode: 'none' }),
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
    } as any;
    const permissions = {
      getLatestPendingQuestion: vi.fn().mockReturnValue(null),
      parsePermissionText: vi.fn().mockReturnValue(null),
    } as any;

    const coordinator = new MessageLoopCoordinator({
      state,
      sdkEngine,
      permissions,
      quickCommands: new Set(),
      hasPendingSdkQuestion: () => false,
    });
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
      expect.objectContaining({ text: '💬 Message injected into active session' }),
    );
  });

  it('queues follow-up messages when turn is not active', async () => {
    const state = new SessionStateManager();
    const chatKey = state.stateKey('telegram', 'chat-1');
    state.setProcessing(chatKey, true);

    const sdkEngine = {
      sendWithContext: vi.fn().mockResolvedValue({ sent: true, mode: 'queue', sessionKey: 'session-1' }),
    } as any;
    const permissions = {
      getLatestPendingQuestion: vi.fn().mockReturnValue(null),
      parsePermissionText: vi.fn().mockReturnValue(null),
    } as any;

    const coordinator = new MessageLoopCoordinator({
      state,
      sdkEngine,
      permissions,
      quickCommands: new Set(),
      hasPendingSdkQuestion: () => false,
    });
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
      expect.objectContaining({ text: '📥 Queued — will process after current task' }),
    );
  });

  it('steers to specific session when replying to a bubble', async () => {
    const state = new SessionStateManager();
    const chatKey = state.stateKey('telegram', 'chat-1');
    state.setProcessing(chatKey, true);

    const sdkEngine = {
      sendWithContext: vi.fn().mockResolvedValue({ sent: true, mode: 'steer', sessionKey: 'session-2' }),
    } as any;
    const permissions = {
      getLatestPendingQuestion: vi.fn().mockReturnValue(null),
      parsePermissionText: vi.fn().mockReturnValue(null),
    } as any;

    const coordinator = new MessageLoopCoordinator({
      state,
      sdkEngine,
      permissions,
      quickCommands: new Set(),
      hasPendingSdkQuestion: () => false,
    });
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
      expect.objectContaining({ text: '💬 Message injected into active session' }),
    );
  });

  it('prompts user when no active session found', async () => {
    const state = new SessionStateManager();
    const chatKey = state.stateKey('telegram', 'chat-1');
    state.setProcessing(chatKey, true);

    const sdkEngine = {
      sendWithContext: vi.fn().mockResolvedValue({ sent: false, mode: 'none' }),
    } as any;
    const permissions = {
      getLatestPendingQuestion: vi.fn().mockReturnValue(null),
      parsePermissionText: vi.fn().mockReturnValue(null),
    } as any;

    const coordinator = new MessageLoopCoordinator({
      state,
      sdkEngine,
      permissions,
      quickCommands: new Set(),
      hasPendingSdkQuestion: () => false,
    });
    const adapter = createAdapter();

    await coordinator.dispatchSlowMessage({
      adapter,
      msg: createMessage('no session'),
      coalesceMessage: async (_adapter, msg) => msg,
      handleMessage: vi.fn(),
      onError: vi.fn(),
    });

    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: '⚠️ No active session — please start a task first' }),
    );
  });
});
