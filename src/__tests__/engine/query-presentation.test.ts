import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeishuFormatter } from '../../channels/feishu/formatter.js';
import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import { QueryPresentationFactory } from '../../engine/coordinators/query-presentation.js';

function createMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channelType: 'feishu',
    chatId: 'chat-1',
    userId: 'user-1',
    text: 'run task',
    messageId: 'msg-1',
    ...overrides,
  };
}

function createAdapter(): BaseChannelAdapter {
  const formatter = new FeishuFormatter('zh');
  return {
    channelType: 'feishu',
    getLocale: vi.fn().mockReturnValue('zh'),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({ messageId: 'out-1', success: true }),
    editMessage: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(undefined),
    shouldRenderProgressPhase: vi.fn().mockReturnValue(true),
    shouldSplitProgressMessage: vi.fn().mockReturnValue(false),
    shouldSplitCompletedTrace: vi.fn().mockReturnValue(false),
    format: vi.fn().mockImplementation((msg) => formatter.format(msg)),
    formatContent: vi.fn().mockImplementation((chatId, content, buttons) =>
      formatter.formatContent(chatId, content, buttons),
    ),
  } as unknown as BaseChannelAdapter;
}

describe('QueryPresentationFactory', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts and stops typing for a query attempt', async () => {
    vi.useFakeTimers();
    const adapter = createAdapter();
    const factory = new QueryPresentationFactory({
      defaultWorkdir: '/work',
      typingIntervalMs: 1000,
    });

    const typing = factory.startTyping(adapter, createMessage());

    expect(adapter.sendTyping).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(adapter.sendTyping).toHaveBeenCalledTimes(2);

    typing.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(adapter.sendTyping).toHaveBeenCalledTimes(2);
  });

  it('wires presenter first-send message ids back to the query owner', async () => {
    const adapter = createAdapter();
    const factory = new QueryPresentationFactory({ defaultWorkdir: '/work' });
    const onMessageId = vi.fn();

    const { presenter } = factory.createTurn({
      adapter,
      msg: createMessage(),
      binding: { cwd: '/work', sdkSessionId: 'sdk-1' },
      sessionKey: 'feishu:chat-1:binding-1',
      reactions: {
        processing: 'Typing',
        done: 'OK',
        error: 'FACEPALM',
        stalled: 'OneSecond',
        permission: 'Pin',
      },
      typing: { stop: vi.fn() },
      onMessageId,
    } as any);

    await presenter.flush('hello', false);

    expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'chat-1' }));
    expect(onMessageId).toHaveBeenCalledWith('out-1');
  });
});
