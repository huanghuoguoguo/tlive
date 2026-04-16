import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildSubprocessEnv,
  preparePromptWithImages,
  SAFE_PERMISSIONS,
} from '../../providers/claude-shared.js';
import type { FileAttachment } from '../../providers/base.js';
import * as fs from 'node:fs';

// Mock node:fs for file operations
vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(true),
}));

// Mock utils/path
vi.mock('../../utils/path.js', () => ({
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
    });
  });

  describe('SAFE_PERMISSIONS', () => {
    it('includes read-only tools', () => {
      expect(SAFE_PERMISSIONS).toContain('Read(*)');
      expect(SAFE_PERMISSIONS).toContain('Glob(*)');
      expect(SAFE_PERMISSIONS).toContain('Grep(*)');
    });

    it('includes write tools', () => {
      expect(SAFE_PERMISSIONS).toContain('Write(*)');
      expect(SAFE_PERMISSIONS).toContain('Edit(*)');
    });

    it('includes web tools', () => {
      expect(SAFE_PERMISSIONS).toContain('WebSearch');
      expect(SAFE_PERMISSIONS).toContain('WebFetch(domain:*)');
    });

    it('includes task/agent tools', () => {
      expect(SAFE_PERMISSIONS).toContain('Task(*)');
      expect(SAFE_PERMISSIONS).toContain('ExitPlanMode');
      expect(SAFE_PERMISSIONS).toContain('ToolSearch');
    });

    it('includes safe bash patterns', () => {
      expect(SAFE_PERMISSIONS).toContain('Bash(safe *)');
    });

    it('is an array of strings', () => {
      expect(Array.isArray(SAFE_PERMISSIONS)).toBe(true);
      for (const perm of SAFE_PERMISSIONS) {
        expect(typeof perm).toBe('string');
      }
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

      // Should not throw
      const result = preparePromptWithImages('test', attachments);
      expect(result).toBeDefined();
    });
  });
});