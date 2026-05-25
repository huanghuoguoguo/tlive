import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  appendClaudeStderrToError,
  buildSubprocessEnv,
} from '../../client/providers/claude-shared.js';
import { preparePromptWithImages } from '../../client/providers/prompt-media.js';
import type { FileAttachment } from '../../shared/providers/base.js';
import * as fs from 'node:fs';

// Mock node:fs for file operations
vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(true),
}));

// Mock core/path
vi.mock('../../shared/core/path.js', () => ({
  getTliveHome: vi.fn().mockReturnValue('/tmp/tlive-home'),
}));

describe('claude-shared utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('buildSubprocessEnv', () => {
    it('strips CLAUDECODE prefixed env vars', () => {
      const originalEnv = {
        PATH: '/usr/bin',
        CLAUDECODE_TOKEN: 'secret',
        CLAUDECODE_SESSION: 'session-id',
        HOME: '/home/user',
      };

      vi.stubGlobal('process', { env: originalEnv });
      const result = buildSubprocessEnv();

      expect(result.PATH).toBe('/usr/bin');
      expect(result.HOME).toBe('/home/user');
      expect(result.TMPDIR).toBe('/tmp/tlive-home/tmp/claude');
      expect(result.CLAUDECODE_TOKEN).toBeUndefined();
      expect(result.CLAUDECODE_SESSION).toBeUndefined();
    });

    it('preserves non-CLAUDECODE env vars', () => {
      const originalEnv = {
        NODE_ENV: 'test',
        TL_DEFAULT_WORKDIR: '/tmp',
        PATH: '/usr/bin',
      };

      vi.stubGlobal('process', { env: originalEnv });
      const result = buildSubprocessEnv();

      expect(result.NODE_ENV).toBe('test');
      expect(result.TL_DEFAULT_WORKDIR).toBe('/tmp');
      expect(result.PATH).toBe('/usr/bin');
      expect(result.TMPDIR).toBe('/tmp/tlive-home/tmp/claude');
    });

    it('handles undefined env values', () => {
      const originalEnv = {
        DEFINED: 'value',
        UNDEFINED: undefined,
      };

      vi.stubGlobal('process', { env: originalEnv });
      const result = buildSubprocessEnv();

      expect(result.DEFINED).toBe('value');
      expect(result.UNDEFINED).toBeUndefined();
      expect(result.TMPDIR).toBe('/tmp/tlive-home/tmp/claude');
    });

    it('uses explicit Claude temp dir override', () => {
      vi.stubGlobal('process', {
        env: {
          TL_CLAUDE_TMPDIR: '/custom/claude-tmp',
        },
      });

      const result = buildSubprocessEnv();

      expect(result.TMPDIR).toBe('/custom/claude-tmp');
      expect(result.TMP).toBe('/custom/claude-tmp');
      expect(result.TEMP).toBe('/custom/claude-tmp');
      expect(fs.mkdirSync).toHaveBeenCalledWith('/custom/claude-tmp', {
        recursive: true,
        mode: 0o700,
      });
    });
  });

  describe('appendClaudeStderrToError', () => {
    it('appends sanitized stderr details to provider errors', () => {
      const message = appendClaudeStderrToError(
        'Claude Code process exited with code 1',
        '\u001b[31mfatal: upstream failed\u001b[0m\nANTHROPIC_API_KEY=sk-ant-api03-secret',
      );

      expect(message).toContain('Claude Code process exited with code 1');
      expect(message).toContain('Claude Code stderr:');
      expect(message).toContain('fatal: upstream failed');
      expect(message).toContain('ANTHROPIC_API_KEY=[REDACTED]');
      expect(message).not.toContain('sk-ant-api03-secret');
    });

    it('keeps the original error when stderr is empty', () => {
      expect(appendClaudeStderrToError('failed', '\n\n')).toBe('failed');
    });
  });

  describe('preparePromptWithImages', () => {
    it('returns unchanged prompt when no attachments', () => {
      const result = preparePromptWithImages('hello world');

      expect(result.prompt).toBe('hello world');
      expect(result.imagePaths).toHaveLength(0);
    });

    it('returns unchanged prompt for non-image attachments', () => {
      const attachments: FileAttachment[] = [
        { type: 'file', name: 'doc.pdf', mimeType: 'application/pdf', base64Data: 'abc' },
      ];

      const result = preparePromptWithImages('read this', attachments);

      expect(result.prompt).toBe('read this');
      expect(result.imagePaths).toHaveLength(0);
    });

    it('prepends image references for image attachments', () => {
      const attachments: FileAttachment[] = [
        { type: 'image', name: 'photo.png', mimeType: 'image/png', base64Data: 'base64data' },
      ];

      const result = preparePromptWithImages('analyze this image', attachments);

      expect(result.prompt).toContain('[User sent 1 image(s)');
      expect(result.prompt).toContain('analyze this image');
      expect(result.imagePaths).toHaveLength(1);
      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('handles multiple image attachments', () => {
      const attachments: FileAttachment[] = [
        { type: 'image', name: 'img1.png', mimeType: 'image/png', base64Data: 'a' },
        { type: 'image', name: 'img2.jpg', mimeType: 'image/jpeg', base64Data: 'b' },
        { type: 'image', name: 'img3.gif', mimeType: 'image/gif', base64Data: 'c' },
      ];

      const result = preparePromptWithImages('compare these', attachments);

      expect(result.prompt).toContain('[User sent 3 image(s)');
      expect(result.imagePaths).toHaveLength(3);
    });

    it('uses custom tmpImageDir when provided', () => {
      const attachments: FileAttachment[] = [
        { type: 'image', name: 'test.png', mimeType: 'image/png', base64Data: 'x' },
      ];

      preparePromptWithImages('test', attachments, '/custom/tmp');

      expect(fs.mkdirSync).toHaveBeenCalledWith('/custom/tmp', { recursive: true });
    });

    it('uses correct file extensions based on mimeType', () => {
      const pngAttachment: FileAttachment = { type: 'image', name: 'test', mimeType: 'image/png', base64Data: 'p' };
      const jpgAttachment: FileAttachment = { type: 'image', name: 'test', mimeType: 'image/jpeg', base64Data: 'j' };
      const gifAttachment: FileAttachment = { type: 'image', name: 'test', mimeType: 'image/gif', base64Data: 'g' };

      preparePromptWithImages('test', [pngAttachment]);
      const pngCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      expect(pngCall[0]).toContain('.png');

      preparePromptWithImages('test', [jpgAttachment]);
      const jpgCall = vi.mocked(fs.writeFileSync).mock.calls[vi.mocked(fs.writeFileSync).mock.calls.length - 1];
      expect(jpgCall[0]).toContain('.jpg');

      preparePromptWithImages('test', [gifAttachment]);
      const gifCall = vi.mocked(fs.writeFileSync).mock.calls[vi.mocked(fs.writeFileSync).mock.calls.length - 1];
      expect(gifCall[0]).toContain('.gif');
    });

    it('continues on file write errors', () => {
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error('write failed');
      });

      const attachments: FileAttachment[] = [
        { type: 'image', name: 'fail.png', mimeType: 'image/png', base64Data: 'x' },
      ];

      const result = preparePromptWithImages('test', attachments);
      expect(result).toEqual({ prompt: 'test', imagePaths: [] });
    });
  });
});
