import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import { IngressCoordinator } from '../engine/ingress-coordinator.js';

function tempChatIdFile(): string {
  return join(tmpdir(), `tlive-ingress-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
}

function createAdapter(channelType: 'telegram' | 'feishu' | 'qqbot' = 'telegram') {
  const queue: Array<InboundMessage> = [];
  return {
    adapter: {
      channelType,
      consumeOne: vi.fn().mockImplementation(async () => queue.shift() ?? null),
    } as unknown as BaseChannelAdapter,
    push: (msg: InboundMessage) => queue.push(msg),
  };
}

describe('IngressCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('persists last chat ids for hook routing', () => {
    vi.useFakeTimers();
    const chatIdFile = tempChatIdFile();
    if (existsSync(chatIdFile)) {
      rmSync(chatIdFile);
    }

    const ingress = new IngressCoordinator({ chatIdFile, persistDebounceMs: 10 });
    ingress.recordChat('telegram', 'chat-1');
    vi.advanceTimersByTime(10);
    ingress.dispose();

    const reloaded = new IngressCoordinator({ chatIdFile, persistDebounceMs: 10 });
    expect(reloaded.getLastChatId('telegram')).toBe('chat-1');

    reloaded.dispose();
    rmSync(chatIdFile);
  });

  it('buffers image-only messages and merges them into the next text message', () => {
    const chatIdFile = tempChatIdFile();
    const ingress = new IngressCoordinator({ chatIdFile });
    const imageOnly = ingress.prepareAttachments({
      channelType: 'telegram',
      chatId: 'chat-1',
      userId: 'user-1',
      text: '',
      messageId: 'msg-1',
      attachments: [{
        type: 'image',
        name: 'diagram.png',
        mimeType: 'image/png',
        base64Data: 'aGVsbG8=',
      }],
    });

    expect(imageOnly.handled).toBe(true);

    const merged = ingress.prepareAttachments({
      channelType: 'telegram',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'please review this',
      messageId: 'msg-2',
    });

    expect(merged.handled).toBe(false);
    expect(merged.message.attachments).toHaveLength(1);
    expect(merged.message.attachments?.[0]?.name).toBe('diagram.png');

    ingress.dispose();
  });

  it('coalesces long split messages and preserves unrelated follow-up via pushback', async () => {
    vi.useFakeTimers();
    const { adapter, push } = createAdapter();
    const ingress = new IngressCoordinator({ chatIdFile: tempChatIdFile() });

    push({
      channelType: 'telegram',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'second chunk',
      messageId: 'msg-2',
    });
    push({
      channelType: 'telegram',
      chatId: 'chat-2',
      userId: 'user-2',
      text: 'other message',
      messageId: 'msg-3',
    });

    const coalescePromise = ingress.coalesceMessages(adapter, {
      channelType: 'telegram',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'a'.repeat(3900),
      messageId: 'msg-1',
    });

    await vi.advanceTimersByTimeAsync(600);
    const merged = await coalescePromise;

    expect(merged.text).toBe(`${'a'.repeat(3900)}\nsecond chunk`);

    const pushedBack = await ingress.getNextMessage(adapter);
    expect(pushedBack?.chatId).toBe('chat-2');
    expect(pushedBack?.text).toBe('other message');

    ingress.dispose();
  });
});
