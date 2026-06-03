import { afterEach, describe, it, expect, vi } from 'vitest';
import { FileDeliveryService } from '../../server/services/file-delivery.js';
import { chunkByParagraph } from '../../shared/formatting/text-chunk.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('paragraph-aware chunking', () => {
  it('keeps paragraphs together when possible', () => {
    const text = ['first paragraph', 'second paragraph', 'third paragraph'].join('\n\n');
    const chunks = chunkByParagraph(text, 28);
    expect(chunks).toEqual(['first paragraph', 'second paragraph', 'third paragraph']);
  });
});

describe('fence-aware chunking', () => {
  it('preserves code block fences across chunks', () => {
    const text = '# Title\n```js\n' + 'let x = 1;\n'.repeat(100) + '```\nEnd.';
    const chunks = chunkByParagraph(text, 200);
    for (const chunk of chunks) {
      const opens = (chunk.match(/```/g) || []).length;
      expect(opens % 2).toBe(0);
    }
  });

  it('reopens code block in next chunk', () => {
    const text = '```\n' + 'line\n'.repeat(50) + '```';
    const chunks = chunkByParagraph(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].trimEnd().endsWith('```')).toBe(true);
    expect(chunks[1].startsWith('```')).toBe(true);
  });

  it('handles text without code blocks normally', () => {
    const text = 'Hello\nWorld\nFoo\nBar';
    const chunks = chunkByParagraph(text, 12);
    expect(chunks).toEqual(['Hello\nWorld', 'Foo\nBar']);
  });

  it('returns single chunk if within limit', () => {
    expect(chunkByParagraph('short text', 100)).toEqual(['short text']);
  });

  it('splits long line without code block', () => {
    const text = 'A'.repeat(300);
    const chunks = chunkByParagraph('A'.repeat(300), 100);
    expect(chunks.every(chunk => chunk.length <= 100)).toBe(true);
    expect(chunks.join('')).toBe(text);
  });
});

describe('FileDeliveryService URL diagnostics', () => {
  it('sends image content through a route token target', async () => {
    const adapter = {
      formatContent: vi.fn().mockImplementation((chatId: string, content: string) => ({
        chatId,
        text: content,
      })),
      send: vi.fn().mockResolvedValue({ messageId: 'out-1', success: true }),
    };
    const bridge = {
      getAdapter: vi.fn().mockReturnValue(adapter),
      getBinding: vi.fn(),
      resolveFileDeliveryToken: vi.fn().mockReturnValue({
        channelType: 'feishu',
        chatId: 'chat-1',
        scopeId: 'chat-1#thread:thread-1',
        threadId: 'thread-1',
        replyToMessageId: 'msg-topic-1',
        replyInThread: true,
        cwd: '/workdir',
        sessionKey: 'session-key',
      }),
    };
    const service = new FileDeliveryService({
      bridge: bridge as any,
      defaultWorkdir: '/tmp',
    });

    const result = await service.sendContent({
      routeToken: 'route-token',
      fileName: 'image.png',
      mimeType: 'image/png',
      base64Data: Buffer.from('png body').toString('base64'),
      caption: 'done',
    });

    expect(result).toEqual({ success: true, filename: 'image.png' });
    expect(bridge.resolveFileDeliveryToken).toHaveBeenCalledWith('route-token');
    expect(adapter.formatContent).toHaveBeenCalledWith('chat-1', 'done');
    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        threadId: 'thread-1',
        replyToMessageId: 'msg-topic-1',
        replyInThread: true,
        media: expect.objectContaining({
          type: 'image',
          filename: 'image.png',
          mimeType: 'image/png',
        }),
      }),
    );
  });

  it('explains that localhost URLs are fetched by the MCP server side', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('fetch failed')) as any;
    const service = new FileDeliveryService({
      bridge: {
        getAdapter: vi.fn(),
        getBinding: vi.fn(),
      } as any,
      defaultWorkdir: '/tmp',
    });

    const result = await service.sendUrl({
      channelType: 'feishu',
      chatId: 'chat-1',
      url: 'http://127.0.0.1:8765/image.png',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('TLive MCP server');
    expect(result.error).toContain('not the execution client');
  });
});
