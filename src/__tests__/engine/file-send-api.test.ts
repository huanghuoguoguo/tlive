import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { handleFileSendRequest, sendFileToChat } from '../../engine/automation/file-send-api.js';
import type { BridgeManager } from '../../engine/coordinators/bridge-manager.js';
import type { DeliveryRoute } from '../../channels/delivery-route.js';

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  stat: vi.fn(),
}));

import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

const mockStat = vi.mocked(stat);
const mockReadFile = vi.mocked(readFile);

function createJsonRequest(body: Record<string, unknown>): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  (req as any).method = 'POST';
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function createJsonResponse(): ServerResponse & { body?: string; statusCode?: number } {
  const res = {
    writableEnded: false,
    writeHead: vi.fn((statusCode: number) => {
      res.statusCode = statusCode;
      return res;
    }),
    end: vi.fn((body?: string) => {
      res.body = body;
      res.writableEnded = true;
      return res;
    }),
  } as unknown as ServerResponse & { body?: string; statusCode?: number; writableEnded: boolean };
  return res;
}

function createMockBridge(overrides?: Partial<BridgeManager>): BridgeManager {
  return {
    getAdapter: vi.fn().mockReturnValue({
      channelType: 'feishu',
      formatContent: vi.fn().mockReturnValue({ chatId: 'chat-1', text: '' }),
      send: vi.fn().mockResolvedValue({ success: true }),
    }),
    getAdapters: vi.fn().mockReturnValue([]),
    getLastChatId: vi.fn().mockReturnValue(null),
    getBinding: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as BridgeManager;
}

function route(overrides: Partial<DeliveryRoute> = {}): DeliveryRoute {
  return {
    channelType: 'feishu',
    chatId: 'chat-1',
    scopeId: 'chat-1',
    ...overrides,
  };
}

describe('sendFileToChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error when file does not exist', async () => {
    mockStat.mockRejectedValue(new Error('ENOENT'));

    const bridge = createMockBridge();
    const result = await sendFileToChat('/missing.png', undefined, route(), '/work', bridge);

    expect(result.success).toBe(false);
    expect(result.error).toContain('File not found');
  });

  it('returns error when path is a directory', async () => {
    mockStat.mockResolvedValue({ isFile: () => false, size: 100 } as any);

    const bridge = createMockBridge();
    const result = await sendFileToChat('/somedir', undefined, route(), '/work', bridge);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Not a file');
  });

  it('returns error when file is too large', async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 25 * 1024 * 1024 } as any);

    const bridge = createMockBridge();
    const result = await sendFileToChat('/big.zip', undefined, route(), '/work', bridge);

    expect(result.success).toBe(false);
    expect(result.error).toContain('too large');
  });

  it('returns error when file is empty', async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 0 } as any);

    const bridge = createMockBridge();
    const result = await sendFileToChat('/empty.txt', undefined, route(), '/work', bridge);

    expect(result.success).toBe(false);
    expect(result.error).toContain('empty');
  });

  it('returns error when channel adapter not available', async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 100 } as any);
    mockReadFile.mockResolvedValue(Buffer.from('hello'));

    const bridge = createMockBridge({ getAdapter: vi.fn().mockReturnValue(null) as any });
    const result = await sendFileToChat('/test.txt', undefined, route(), '/work', bridge);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Channel 'feishu' not available");
  });

  it('sends image file successfully', async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 1024 } as any);
    mockReadFile.mockResolvedValue(Buffer.from('PNG data'));

    const mockSend = vi.fn().mockResolvedValue({ success: true });
    const mockFormatContent = vi.fn().mockReturnValue({ chatId: 'chat-1', text: '' });
    const bridge = createMockBridge({
      getAdapter: vi.fn().mockReturnValue({
        channelType: 'feishu',
        formatContent: mockFormatContent,
        send: mockSend,
      }) as any,
    });

    const result = await sendFileToChat(
      '/work/output.png',
      'Here is the chart',
      route(),
      '/work',
      bridge,
    );

    expect(result.success).toBe(true);
    expect(result.filename).toBe('output.png');
    expect(mockFormatContent).toHaveBeenCalledWith('chat-1', 'Here is the chart');
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      media: expect.objectContaining({
        type: 'image',
        filename: 'output.png',
        mimeType: 'image/png',
      }),
    }));
  });

  it('sends non-image file with correct type', async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 2048 } as any);
    mockReadFile.mockResolvedValue(Buffer.from('PDF data'));

    const mockSend = vi.fn().mockResolvedValue({ success: true });
    const bridge = createMockBridge({
      getAdapter: vi.fn().mockReturnValue({
        channelType: 'feishu',
        formatContent: vi.fn().mockReturnValue({ chatId: 'chat-1', text: '' }),
        send: mockSend,
      }) as any,
    });

    const result = await sendFileToChat('report.pdf', undefined, route(), '/work', bridge);

    expect(result.success).toBe(true);
    expect(result.filename).toBe('report.pdf');
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      media: expect.objectContaining({
        type: 'file',
        filename: 'report.pdf',
        mimeType: 'application/pdf',
      }),
    }));
  });

  it('preserves topic reply context when sending a file', async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 2048 } as any);
    mockReadFile.mockResolvedValue(Buffer.from('text data'));

    const mockSend = vi.fn().mockResolvedValue({ success: true });
    const bridge = createMockBridge({
      getAdapter: vi.fn().mockReturnValue({
        channelType: 'feishu',
        formatContent: vi.fn().mockReturnValue({ chatId: 'chat-1', text: '' }),
        send: mockSend,
      }) as any,
    });

    const result = await sendFileToChat(
      'notes.txt',
      undefined,
      route({ replyToMessageId: 'msg-topic', replyInThread: true }),
      '/work',
      bridge,
    );

    expect(result.success).toBe(true);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      replyToMessageId: 'msg-topic',
      replyInThread: true,
      media: expect.objectContaining({
        type: 'file',
        filename: 'notes.txt',
      }),
    }));
  });

  it('resolves relative paths against cwd', async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 100 } as any);
    mockReadFile.mockResolvedValue(Buffer.from('data'));

    const mockSend = vi.fn().mockResolvedValue({ success: true });
    const bridge = createMockBridge({
      getAdapter: vi.fn().mockReturnValue({
        channelType: 'feishu',
        formatContent: vi.fn().mockReturnValue({ chatId: 'chat-1', text: '' }),
        send: mockSend,
      }) as any,
    });

    await sendFileToChat('output/chart.png', undefined, route(), '/my/project', bridge);

    // stat should be called with resolved path
    expect(mockStat).toHaveBeenCalledWith('/my/project/output/chart.png');
  });

  it('handles send failure gracefully', async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 100 } as any);
    mockReadFile.mockResolvedValue(Buffer.from('data'));

    const bridge = createMockBridge({
      getAdapter: vi.fn().mockReturnValue({
        channelType: 'feishu',
        formatContent: vi.fn().mockReturnValue({ chatId: 'chat-1', text: '' }),
        send: vi.fn().mockRejectedValue(new Error('Network timeout')),
      }) as any,
    });

    const result = await sendFileToChat('/test.png', undefined, route(), '/work', bridge);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Network timeout');
  });

  it('uses empty caption when none provided', async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 100 } as any);
    mockReadFile.mockResolvedValue(Buffer.from('data'));

    const mockFormatContent = vi.fn().mockReturnValue({ chatId: 'chat-1', text: '' });
    const bridge = createMockBridge({
      getAdapter: vi.fn().mockReturnValue({
        channelType: 'feishu',
        formatContent: mockFormatContent,
        send: vi.fn().mockResolvedValue({ success: true }),
      }) as any,
    });

    await sendFileToChat('/test.txt', undefined, route(), '/work', bridge);

    expect(mockFormatContent).toHaveBeenCalledWith('chat-1', '');
  });

  it('uses octet-stream for unknown extensions', async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 100 } as any);
    mockReadFile.mockResolvedValue(Buffer.from('binary'));

    const mockSend = vi.fn().mockResolvedValue({ success: true });
    const bridge = createMockBridge({
      getAdapter: vi.fn().mockReturnValue({
        channelType: 'feishu',
        formatContent: vi.fn().mockReturnValue({ chatId: 'chat-1', text: '' }),
        send: mockSend,
      }) as any,
    });

    await sendFileToChat('/data.xyz', undefined, route(), '/work', bridge);

    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      media: expect.objectContaining({
        mimeType: 'application/octet-stream',
        type: 'file',
      }),
    }));
  });
});

describe('handleFileSendRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes files by per-turn routeToken instead of the main chat fallback', async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 100 } as any);
    mockReadFile.mockResolvedValue(Buffer.from('file contents'));

    const mockSend = vi.fn().mockResolvedValue({ success: true });
    const bridge = createMockBridge({
      getAdapter: vi.fn().mockReturnValue({
        channelType: 'feishu',
        formatContent: vi.fn().mockReturnValue({ chatId: 'chat-1', text: '' }),
        send: mockSend,
      }) as any,
      resolveFileDeliveryToken: vi.fn().mockReturnValue({
        channelType: 'feishu',
        chatId: 'chat-1',
        scopeId: 'chat-1#thread:thread-1',
        replyToMessageId: 'msg-topic',
        replyInThread: true,
        cwd: '/topic-work',
        sessionKey: 'feishu:chat-1#thread:thread-1:session-1',
      }) as any,
      getBinding: vi.fn().mockResolvedValue({ cwd: '/wrong-main-workdir' }) as any,
    });
    const req = createJsonRequest({ file_path: 'out.txt', routeToken: 'route-token' });
    const res = createJsonResponse();

    await handleFileSendRequest(req, res, { bridge, defaultWorkdir: '/default' });

    expect(bridge.resolveFileDeliveryToken).toHaveBeenCalledWith('route-token');
    expect(bridge.getBinding).toHaveBeenCalledWith('feishu', 'chat-1#thread:thread-1');
    expect(mockStat).toHaveBeenCalledWith('/topic-work/out.txt');
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'chat-1',
      replyToMessageId: 'msg-topic',
      replyInThread: true,
      media: expect.objectContaining({ filename: 'out.txt' }),
    }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body || '{}')).toMatchObject({ success: true, filename: 'out.txt' });
  });

  it('rejects ambiguous file sends instead of falling back to the last active chat', async () => {
    const mockSend = vi.fn().mockResolvedValue({ success: true });
    const bridge = createMockBridge({
      getAdapter: vi.fn().mockReturnValue({
        channelType: 'feishu',
        formatContent: vi.fn().mockReturnValue({ chatId: 'main-chat', text: '' }),
        send: mockSend,
      }) as any,
      getAdapters: vi.fn().mockReturnValue([{ channelType: 'feishu' }]) as any,
      getLastChatId: vi.fn().mockReturnValue('main-chat') as any,
    });
    const req = createJsonRequest({ file_path: 'out.txt' });
    const res = createJsonResponse();

    await handleFileSendRequest(req, res, { bridge, defaultWorkdir: '/default' });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body || '{}')).toMatchObject({
      success: false,
      error: expect.stringContaining('Missing file delivery target'),
    });
    expect(mockStat).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(bridge.getLastChatId).not.toHaveBeenCalled();
  });
});
