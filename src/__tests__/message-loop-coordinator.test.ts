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
      canSteer: vi.fn().mockReturnValue(false),
      hasActiveSession: vi.fn().mockReturnValue(false),
      steer: vi.fn().mockResolvedValue(false),
      queue: vi.fn().mockResolvedValue(false),
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

  it('steers the active session when a busy chat replies to the working card', async () => {
    const state = new SessionStateManager();
    const chatKey = state.stateKey('telegram', 'chat-1');
    state.setProcessing(chatKey, true);

    const sdkEngine = {
      canSteer: vi.fn().mockReturnValue(true),
      hasActiveSession: vi.fn().mockReturnValue(true),
      steer: vi.fn().mockResolvedValue(true),
      queue: vi.fn().mockResolvedValue(false),
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
      msg: createMessage('follow-up', { replyToMessageId: 'card-1' }),
      coalesceMessage: async (_adapter, msg) => msg,
      handleMessage: vi.fn(),
      onError: vi.fn(),
    });

    expect(sdkEngine.steer).toHaveBeenCalledWith('telegram', 'chat-1', 'follow-up');
    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: '💬 Message injected into active session' }),
    );
  });

  it('queues follow-up messages when a busy chat cannot be steered', async () => {
    const state = new SessionStateManager();
    const chatKey = state.stateKey('telegram', 'chat-1');
    state.setProcessing(chatKey, true);

    const sdkEngine = {
      canSteer: vi.fn().mockReturnValue(false),
      hasActiveSession: vi.fn().mockReturnValue(true),
      steer: vi.fn().mockResolvedValue(false),
      queue: vi.fn().mockResolvedValue(true),
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

    expect(sdkEngine.queue).toHaveBeenCalledWith('telegram', 'chat-1', 'queued follow-up');
    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: '📥 Queued — will process after current task' }),
    );
  });
});
