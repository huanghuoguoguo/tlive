import { describe, expect, it, vi, beforeEach } from 'vitest';
import { sendFileToChat, type FileSendApiOptions } from '../../engine/automation/file-send-api.js';
import type { BridgeManager } from '../../engine/coordinators/bridge-manager.js';

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  stat: vi.fn(),
}));

import { readFile, stat } from 'node:fs/promises';

const mockStat = vi.mocked(stat);
const mockReadFile = vi.mocked(readFile);

function createMockBridge(overrides?: Partial<BridgeManager>): BridgeManager {
  return {
    getAdapter: vi.fn().mockReturnValue({
      channelType: 'telegram',
      formatContent: vi.fn().mockReturnValue({ chatId: 'chat-1', text: '' }),
      send: vi.fn().mockResolvedValue({ success: true }),
    }),
    getAdapters: vi.fn().mockReturnValue([]),
    getLastChatId: vi.fn().mockReturnValue(null),
    getBinding: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as BridgeManager;
}

describe('sendFileToChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error when file does not exist', async () => {
    mockStat.mockRejectedValue(new Error('ENOENT'));

    const bridge = createMockBridge();
    const result = await sendFileToChat('/missing.png', undefined, 'telegram', 'chat-1', '/work', bridge);

    expect(result.success).toBe(false);
    expect(result.error).toContain('File not found');
  });

  it('returns error when path is a directory', async () => {
    mockStat.mockResolvedValue({ isFile: () => false, size: 100 } as any);

    const bridge = createMockBridge();
    const result = await sendFileToChat('/somedir', undefined, 'telegram', 'chat-1', '/work', bridge);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Not a file');
  });

  it('returns error when file is too large', async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 25 * 1024 * 1024 } as any);

    const bridge = createMockBridge();
    const result = await sendFileToChat('/big.zip', undefined, 'telegram', 'chat-1', '/work', bridge);

    expect(result.success).toBe(false);
    expect(result.error).toContain('too large');
  });

  it('returns error when file is empty', async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 0 } as any);

    const bridge = createMockBridge();
    const result = await sendFileToChat('/empty.txt', undefined, 'telegram', 'chat-1', '/work', bridge);

    expect(result.success).toBe(false);
    expect(result.error).toContain('empty');
  });

  it('returns error when channel adapter not available', async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 100 } as any);
    mockReadFile.mockResolvedValue(Buffer.from('hello'));

    const bridge = createMockBridge({ getAdapter: vi.fn().mockReturnValue(null) as any });
    const result = await sendFileToChat('/test.txt', undefined, 'telegram', 'chat-1', '/work', bridge);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Channel 'telegram' not available");
  });

  it('sends image file successfully', async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 1024 } as any);
    mockReadFile.mockResolvedValue(Buffer.from('PNG data'));

    const mockSend = vi.fn().mockResolvedValue({ success: true });
    const mockFormatContent = vi.fn().mockReturnValue({ chatId: 'chat-1', text: '' });
    const bridge = createMockBridge({
      getAdapter: vi.fn().mockReturnValue({
        channelType: 'telegram',
        formatContent: mockFormatContent,
        send: mockSend,
      }) as any,
    });

    const result = await sendFileToChat('/work/output.png', 'Here is the chart', 'telegram', 'chat-1', '/work', bridge);

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
        channelType: 'telegram',
        formatContent: vi.fn().mockReturnValue({ chatId: 'chat-1', text: '' }),
        send: mockSend,
      }) as any,
    });

    const result = await sendFileToChat('report.pdf', undefined, 'telegram', 'chat-1', '/work', bridge);

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

  it('resolves relative paths against cwd', async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 100 } as any);
    mockReadFile.mockResolvedValue(Buffer.from('data'));

    const mockSend = vi.fn().mockResolvedValue({ success: true });
    const bridge = createMockBridge({
      getAdapter: vi.fn().mockReturnValue({
        channelType: 'telegram',
        formatContent: vi.fn().mockReturnValue({ chatId: 'chat-1', text: '' }),
        send: mockSend,
      }) as any,
    });

    await sendFileToChat('output/chart.png', undefined, 'telegram', 'chat-1', '/my/project', bridge);

    // stat should be called with resolved path
    expect(mockStat).toHaveBeenCalledWith('/my/project/output/chart.png');
  });

  it('handles send failure gracefully', async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 100 } as any);
    mockReadFile.mockResolvedValue(Buffer.from('data'));

    const bridge = createMockBridge({
      getAdapter: vi.fn().mockReturnValue({
        channelType: 'telegram',
        formatContent: vi.fn().mockReturnValue({ chatId: 'chat-1', text: '' }),
        send: vi.fn().mockRejectedValue(new Error('Network timeout')),
      }) as any,
    });

    const result = await sendFileToChat('/test.png', undefined, 'telegram', 'chat-1', '/work', bridge);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Network timeout');
  });

  it('uses empty caption when none provided', async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 100 } as any);
    mockReadFile.mockResolvedValue(Buffer.from('data'));

    const mockFormatContent = vi.fn().mockReturnValue({ chatId: 'chat-1', text: '' });
    const bridge = createMockBridge({
      getAdapter: vi.fn().mockReturnValue({
        channelType: 'telegram',
        formatContent: mockFormatContent,
        send: vi.fn().mockResolvedValue({ success: true }),
      }) as any,
    });

    await sendFileToChat('/test.txt', undefined, 'telegram', 'chat-1', '/work', bridge);

    expect(mockFormatContent).toHaveBeenCalledWith('chat-1', '');
  });

  it('uses octet-stream for unknown extensions', async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 100 } as any);
    mockReadFile.mockResolvedValue(Buffer.from('binary'));

    const mockSend = vi.fn().mockResolvedValue({ success: true });
    const bridge = createMockBridge({
      getAdapter: vi.fn().mockReturnValue({
        channelType: 'telegram',
        formatContent: vi.fn().mockReturnValue({ chatId: 'chat-1', text: '' }),
        send: mockSend,
      }) as any,
    });

    await sendFileToChat('/data.xyz', undefined, 'telegram', 'chat-1', '/work', bridge);

    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      media: expect.objectContaining({
        mimeType: 'application/octet-stream',
        type: 'file',
      }),
    }));
  });
});
