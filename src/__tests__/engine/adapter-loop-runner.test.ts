import { describe, expect, it, vi } from 'vitest';
import type { BaseChannelAdapter } from '../../server/channels/base.js';
import type { InboundMessage } from '../../server/channels/types.js';
import { AdapterLoopRunner } from '../../server/engine/coordinators/adapter-loop-runner.js';

function createAdapter(): BaseChannelAdapter {
  return {
    channelType: 'feishu',
    send: vi.fn().mockResolvedValue({ messageId: 'out-1', success: true }),
    getLocale: vi.fn().mockReturnValue('zh'),
  } as unknown as BaseChannelAdapter;
}

function createMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channelType: 'feishu',
    chatId: 'chat-1',
    userId: 'user-1',
    text: 'hello',
    messageId: 'msg-1',
    ...overrides,
  };
}

describe('AdapterLoopRunner', () => {
  it('dispatches quick messages inline', async () => {
    const adapter = createAdapter();
    const msg = createMessage({ text: '/status' });
    let running = true;
    const ingress = {
      getNextMessage: vi.fn().mockResolvedValue(msg),
      coalesceMessages: vi.fn(),
    };
    const loop = {
      isQuickMessage: vi.fn().mockReturnValue(true),
      dispatchSlowMessage: vi.fn(),
    };
    const handleInboundMessage = vi.fn().mockImplementation(async () => {
      running = false;
      return true;
    });

    const runner = new AdapterLoopRunner({
      ingress: ingress as any,
      loop: loop as any,
      handleInboundMessage,
      pollDelayMs: 1,
    });

    await runner.run(adapter, () => running);

    expect(ingress.getNextMessage).toHaveBeenCalledWith(adapter);
    expect(loop.isQuickMessage).toHaveBeenCalledWith(adapter, msg);
    expect(handleInboundMessage).toHaveBeenCalledWith(adapter, msg, expect.any(String));
    expect(loop.dispatchSlowMessage).not.toHaveBeenCalled();
  });

  it('routes slow dispatch errors to user-visible notifications', async () => {
    const adapter = createAdapter();
    const msg = createMessage();
    let running = true;
    const ingress = {
      getNextMessage: vi.fn().mockResolvedValue(msg),
      coalesceMessages: vi.fn(),
    };
    const loop = {
      isQuickMessage: vi.fn().mockReturnValue(false),
      dispatchSlowMessage: vi.fn().mockImplementation(async (options) => {
        options.onError(new Error('slow boom'), options.requestId, options.msg);
        running = false;
      }),
    };

    const runner = new AdapterLoopRunner({
      ingress: ingress as any,
      loop: loop as any,
      handleInboundMessage: vi.fn(),
      pollDelayMs: 1,
    });

    await runner.run(adapter, () => running);

    expect(loop.dispatchSlowMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter,
        msg,
        requestId: expect.any(String),
      }),
    );
    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        text: expect.stringContaining('slow boom'),
      }),
    );
  });

  it('preserves topic reply context for error notifications', () => {
    const adapter = createAdapter();
    const runner = new AdapterLoopRunner({
      ingress: {} as any,
      loop: {} as any,
      handleInboundMessage: vi.fn(),
    });

    runner.sendErrorNotification(adapter, 'chat-1', new Error('topic boom'), 'req-topic', createMessage({
      scopeId: 'chat-1#thread:thread-1',
      threadId: 'thread-1',
      replyInThread: true,
      replyTargetMessageId: 'topic-root',
    }));

    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        threadId: 'thread-1',
        replyToMessageId: 'topic-root',
        replyInThread: true,
        text: expect.stringContaining('topic boom'),
      }),
    );
  });

  it('does not notify when no chat id is available', () => {
    const adapter = createAdapter();
    const runner = new AdapterLoopRunner({
      ingress: {} as any,
      loop: {} as any,
      handleInboundMessage: vi.fn(),
    });

    runner.sendErrorNotification(adapter, undefined, new Error('hidden'), 'req-no-chat');

    expect(adapter.send).not.toHaveBeenCalled();
  });
});
