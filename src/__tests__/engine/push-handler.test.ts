import { describe, expect, it, vi, beforeEach } from 'vitest';
import { resolvePushTarget, type PushApiOptions } from '../../engine/automation/push-handler.js';
import type { BaseChannelAdapter } from '../../channels/base.js';
import type { BridgeManager } from '../../engine/coordinators/bridge-manager.js';

function createMockBridge(overrides?: Partial<BridgeManager>): BridgeManager {
  return {
    getAdapter: vi.fn().mockReturnValue({
      channelType: 'telegram',
      formatContent: vi.fn().mockReturnValue({ chatId: 'chat-1', text: '' }),
      send: vi.fn().mockResolvedValue({ success: true }),
    } as unknown as BaseChannelAdapter),
    getAdapters: vi.fn().mockReturnValue([
      { channelType: 'telegram' } as unknown as BaseChannelAdapter,
    ]),
    getLastChatId: vi.fn().mockReturnValue(null),
    getBinding: vi.fn().mockResolvedValue(null),
    pushToMobile: vi.fn().mockResolvedValue({ success: true, sessionId: 'session-1' }),
    ...overrides,
  } as unknown as BridgeManager;
}

describe('resolvePushTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns configured defaults when both are set', () => {
    const pushConfig = { defaultChannel: 'telegram', defaultChat: '123456789' };
    const bridge = createMockBridge();

    const result = resolvePushTarget(pushConfig, bridge);

    expect(result).toEqual({
      channelType: 'telegram',
      chatId: '123456789',
      fallback: false,
    });
    // Should NOT call getLastChatId when config is set
    expect(bridge.getLastChatId).not.toHaveBeenCalled();
  });

  it('returns null when no config and no last active chat', () => {
    const pushConfig = { defaultChannel: '', defaultChat: '' };
    const bridge = createMockBridge({
      getAdapters: vi.fn().mockReturnValue([]),
      getLastChatId: vi.fn().mockReturnValue(''),
    });

    const result = resolvePushTarget(pushConfig, bridge);

    expect(result).toBeNull();
  });

  it('falls back to last active chat when no config', () => {
    const pushConfig = { defaultChannel: '', defaultChat: '' };
    const bridge = createMockBridge({
      getLastChatId: vi.fn().mockReturnValue('chat-123'),
    });

    const result = resolvePushTarget(pushConfig, bridge);

    expect(result).toEqual({
      channelType: 'telegram',
      chatId: 'chat-123',
      fallback: true,
    });
  });

  it('iterates adapters to find last active chat', () => {
    const pushConfig = { defaultChannel: '', defaultChat: '' };
    const bridge = createMockBridge({
      getAdapters: vi.fn().mockReturnValue([
        { channelType: 'telegram' } as unknown as BaseChannelAdapter,
        { channelType: 'feishu' } as unknown as BaseChannelAdapter,
      ]),
      getLastChatId: vi.fn().mockImplementation((channelType: string) => {
        if (channelType === 'telegram') return '';
        if (channelType === 'feishu') return 'feishu-chat-456';
        return '';
      }),
    });

    const result = resolvePushTarget(pushConfig, bridge);

    expect(result).toEqual({
      channelType: 'feishu',
      chatId: 'feishu-chat-456',
      fallback: true,
    });
  });

  it('falls back when config has channel but no chat', () => {
    // Config validation should catch this, but resolver handles gracefully
    const pushConfig = { defaultChannel: 'telegram', defaultChat: '' };
    const bridge = createMockBridge({
      getLastChatId: vi.fn().mockReturnValue('fallback-chat'),
    });

    const result = resolvePushTarget(pushConfig, bridge);

    // Should fall back to last active chat since config is incomplete
    expect(result).toEqual({
      channelType: 'telegram',
      chatId: 'fallback-chat',
      fallback: true,
    });
  });
});