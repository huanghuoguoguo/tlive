import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QQBotAdapter } from '../channels/qqbot.js';

describe('QQBotAdapter', () => {
  const defaultConfig = {
    appId: 'app-123',
    clientSecret: 'secret-123',
    allowedUsers: ['user-1'],
    proxy: '',
  };

  let adapter: QQBotAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new QQBotAdapter(defaultConfig);
  });

  it('preserves FIFO order when attachment download is slower than later messages', async () => {
    let resolveFirstFetch: ((value: Response) => void) | null = null;
    global.fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => {
      resolveFirstFetch = resolve as (value: Response) => void;
    })) as any;

    (adapter as any).handleGroupMessage({
      id: 'msg-1',
      group_openid: 'group-1',
      content: '',
      timestamp: '2026-04-06T00:00:00Z',
      author: { id: 'author-1', member_openid: 'user-1' },
      attachments: [{ content_type: 'image/png', url: 'https://example.com/a.png', filename: 'a.png' }],
    });

    (adapter as any).handleGroupMessage({
      id: 'msg-2',
      group_openid: 'group-1',
      content: 'follow-up text',
      timestamp: '2026-04-06T00:00:01Z',
      author: { id: 'author-1', member_openid: 'user-1' },
      attachments: [],
    });

    const firstConsume = adapter.consumeOne();
    const secondConsume = adapter.consumeOne();

    let secondResolved = false;
    void secondConsume.then(() => {
      secondResolved = true;
    });
    await Promise.resolve();

    expect(secondResolved).toBe(false);

    expect(resolveFirstFetch).toBeTypeOf('function');
    resolveFirstFetch!(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );

    const first = await firstConsume;
    const second = await secondConsume;

    expect(first?.messageId).toBe('msg-1');
    expect(first?.attachments).toHaveLength(1);
    expect(second?.messageId).toBe('msg-2');
    expect(second?.text).toBe('follow-up text');
  });

  it('falls back to the original message when attachment download fails', async () => {
    global.fetch = vi.fn().mockRejectedValueOnce(new Error('network down')) as any;

    (adapter as any).handleC2CMessage({
      id: 'msg-3',
      content: 'hello',
      timestamp: '2026-04-06T00:00:00Z',
      author: { id: 'author-2', user_openid: 'user-2' },
      attachments: [{ content_type: 'image/png', url: 'https://example.com/b.png', filename: 'b.png' }],
    });

    const msg = await adapter.consumeOne();
    expect(msg).toMatchObject({
      messageId: 'msg-3',
      chatId: 'user-2',
      userId: 'user-2',
      text: 'hello',
    });
    expect(msg?.attachments).toBeUndefined();
  });

  it('processes attachments for guild messages too', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(new Uint8Array([4, 5, 6]), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      }),
    ) as any;

    (adapter as any).handleGuildMessage({
      id: 'msg-4',
      channel_id: 'channel-1',
      guild_id: 'guild-1',
      content: '<@app-123> hi',
      timestamp: '2026-04-06T00:00:00Z',
      author: { id: 'author-3' },
      attachments: [{ content_type: 'image/jpeg', url: 'https://example.com/c.jpg', filename: 'c.jpg' }],
    });

    const msg = await adapter.consumeOne();
    expect(msg).toMatchObject({
      messageId: 'msg-4',
      chatId: 'channel-1',
      userId: 'author-3',
      text: 'hi',
    });
    expect(msg?.attachments).toHaveLength(1);
  });

  it('formats progress messages without QQ-native buttons', () => {
    const msg = adapter.format({
      type: 'progress',
      chatId: 'user-1',
      data: {
        phase: 'executing',
        taskSummary: '你好',
        elapsedSeconds: 0,
        renderedText: '我是 TLive，通过 Claude Code 帮你处理任务。',
        todoItems: [],
        totalTools: 0,
      },
    });

    expect(msg.text).toContain('我是 TLive');
    expect(msg.buttons).toBeUndefined();
  });
});
