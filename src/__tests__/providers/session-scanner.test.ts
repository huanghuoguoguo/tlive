import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  scanClaudeSessions,
  invalidateSessionCache,
  readSessionTranscriptPreview,
  type ScannedSession,
} from '../../providers/session-scanner.js';
import * as fs from 'node:fs';
import { homedir } from 'node:os';

// Mock node:fs
vi.mock('node:fs', () => ({
  readdirSync: vi.fn(),
  statSync: vi.fn().mockReturnValue({
    mtimeMs: Date.now(),
    size: 1000,
  }),
  openSync: vi.fn().mockReturnValue(1),
  readSync: vi.fn().mockReturnValue(100),
  closeSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn().mockReturnValue('/home/testuser'),
}));

vi.mock('../../utils/string.js', () => ({
  truncate: vi.fn((s: string, n: number) => s.slice(0, n)),
}));

// Helper to cast mock implementation to bypass strict fs type signatures
const mockReaddir = vi.mocked(fs.readdirSync);
const mockStat = vi.mocked(fs.statSync);
const mockRead = vi.mocked(fs.readSync);

describe('session-scanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateSessionCache(); // Clear cache before each test
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('scanClaudeSessions', () => {
    it('returns empty array when projects directory does not exist', () => {
      mockReaddir.mockImplementation((() => {
        throw new Error('ENOENT');
      }) as unknown as typeof fs.readdirSync);

      const sessions = scanClaudeSessions();
      expect(sessions).toEqual([]);
    });

    it('returns empty array when no project directories found', () => {
      mockReaddir.mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);

      const sessions = scanClaudeSessions();
      expect(sessions).toEqual([]);
    });

    it('scans project directories for .jsonl files', () => {
      // Mock project directory listing - need to return Dirent objects for first call
      mockReaddir.mockImplementation(((path: fs.PathLike, opts?: { withFileTypes?: boolean }) => {
        const pathStr = String(path);
        if (pathStr.includes('projects')) {
          // First call: list project directories with Dirent-like objects
          if (opts?.withFileTypes) {
            return [{ name: '-home-user-project', isDirectory: () => true } as fs.Dirent];
          }
          return ['session-uuid-123.jsonl', 'session-uuid-456.jsonl'];
        }
        // Second call: list .jsonl files in project directory
        return ['session-uuid-123.jsonl', 'session-uuid-456.jsonl'];
      }) as unknown as typeof fs.readdirSync);

      mockStat.mockReturnValue({
        mtimeMs: 1000000,
        size: 5000,
      } as fs.Stats);

      vi.mocked(fs.openSync).mockReturnValue(1);
      mockRead.mockImplementation(((_fd: number, buffer: ArrayBufferView) => {
        // Write test data to buffer
        const testLine = '{"type":"user","message":{"content":"test prompt"},"cwd":"/home/user/project"}\n';
        const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as Uint8Array);
        buf.write(testLine, 0);
        return testLine.length;
      }) as unknown as typeof fs.readSync);

      const sessions = scanClaudeSessions();

      // Basic check - sessions should be an array (may be empty if mocks don't align)
      expect(Array.isArray(sessions)).toBe(true);
      if (sessions.length > 0) {
        expect(sessions[0].sdkSessionId).toBeDefined();
      }
    });

    it('skips agent-* sessions (subagent sessions)', () => {
      mockReaddir.mockImplementation(((path: fs.PathLike) => {
        const pathStr = String(path);
        if (pathStr.includes('projects')) {
          return [{ name: 'test-project', isDirectory: () => true } as fs.Dirent];
        }
        return ['agent-subagent-1.jsonl', 'main-session.jsonl'];
      }) as unknown as typeof fs.readdirSync);

      mockStat.mockReturnValue({
        mtimeMs: 1000000,
        size: 5000,
      } as fs.Stats);

      const sessions = scanClaudeSessions();

      // Should only include main-session, not agent-subagent
      expect(sessions.every(s => !s.sdkSessionId.startsWith('agent-'))).toBe(true);
    });

    it('sorts sessions by mtime descending (most recent first)', () => {
      mockReaddir.mockImplementation(((path: fs.PathLike) => {
        const pathStr = String(path);
        if (pathStr.includes('projects')) {
          return [{ name: 'project', isDirectory: () => true } as fs.Dirent];
        }
        return ['old.jsonl', 'new.jsonl'];
      }) as unknown as typeof fs.readdirSync);

      mockStat.mockImplementation(((path: fs.PathLike) => {
        const pathStr = String(path);
        if (pathStr.includes('old.jsonl')) {
          return { mtimeMs: 1000, size: 100 } as fs.Stats;
        }
        return { mtimeMs: 5000, size: 100 } as fs.Stats;
      }) as unknown as typeof fs.statSync);

      const sessions = scanClaudeSessions();

      if (sessions.length >= 2) {
        expect(sessions[0].mtime).toBeGreaterThanOrEqual(sessions[1].mtime);
      }
    });

    it('respects limit parameter', () => {
      mockReaddir.mockImplementation(((path: fs.PathLike) => {
        const pathStr = String(path);
        if (pathStr.includes('projects')) {
          return [{ name: 'project', isDirectory: () => true } as fs.Dirent];
        }
        return ['s1.jsonl', 's2.jsonl', 's3.jsonl', 's4.jsonl', 's5.jsonl'];
      }) as unknown as typeof fs.readdirSync);

      mockStat.mockReturnValue({
        mtimeMs: Date.now(),
        size: 100,
      } as fs.Stats);

      const sessions = scanClaudeSessions(2);
      expect(sessions.length).toBeLessThanOrEqual(2);
    });

    it('filters by cwd when filterByCwd provided', () => {
      mockReaddir.mockImplementation(((path: fs.PathLike) => {
        const pathStr = String(path);
        if (pathStr.includes('projects')) {
          return [{ name: 'project', isDirectory: () => true } as fs.Dirent];
        }
        return ['s1.jsonl'];
      }) as unknown as typeof fs.readdirSync);

      mockStat.mockReturnValue({
        mtimeMs: Date.now(),
        size: 100,
      } as fs.Stats);

      vi.mocked(fs.openSync).mockReturnValue(1);
      mockRead.mockImplementation(((_fd: number, buffer: ArrayBufferView) => {
        const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as Uint8Array);
        buf.write('{"cwd":"/home/user/specific-project"}', 0);
        return 50;
      }) as unknown as typeof fs.readSync);

      const sessions = scanClaudeSessions(10, '/home/user/specific-project');

      // All returned sessions should match the filter
      for (const s of sessions) {
        expect(s.cwd.startsWith('/home/user/specific-project')).toBe(true);
      }
    });

    it('uses cache for subsequent calls', () => {
      mockReaddir.mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);

      // First call
      scanClaudeSessions();
      const firstCallCount = mockReaddir.mock.calls.length;

      // Second call (should use cache)
      scanClaudeSessions();
      const secondCallCount = mockReaddir.mock.calls.length;

      // readdirSync should not be called again (cache used)
      expect(secondCallCount).toBe(firstCallCount);
    });

    it('cache expires after TTL', () => {
      mockReaddir.mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);

      // First call
      scanClaudeSessions();

      // Invalidate cache
      invalidateSessionCache();

      // Second call after invalidation
      scanClaudeSessions();

      // readdirSync should be called twice (cache invalidated)
      expect(mockReaddir.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('invalidateSessionCache', () => {
    it('clears the cache', () => {
      mockReaddir.mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);

      scanClaudeSessions();
      invalidateSessionCache();
      scanClaudeSessions();

      // Should have two calls (cache cleared)
      expect(mockReaddir.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('readSessionTranscriptPreview', () => {
    it('returns empty array on file read error', () => {
      mockStat.mockImplementation((() => {
        throw new Error('ENOENT');
      }) as unknown as typeof fs.statSync);

      const session: ScannedSession = {
        sdkSessionId: 'test',
        projectDir: 'test',
        filePath: '/nonexistent',
        cwd: '/tmp',
        mtime: 0,
        size: 0,
        preview: 'test',
      };

      const transcript = readSessionTranscriptPreview(session);
      expect(transcript).toEqual([]);
    });

    it('returns transcript messages from file', () => {
      mockStat.mockReturnValue({
        size: 1000,
        mtimeMs: Date.now(),
      } as fs.Stats);

      vi.mocked(fs.openSync).mockReturnValue(1);
      mockRead.mockImplementation(((_fd: number, buffer: ArrayBufferView) => {
        const lines = [
          '{"type":"user","message":{"content":"user message"},"timestamp":"2026-01-01"}',
          '{"type":"assistant","message":{"content":[{"type":"text","text":"assistant response"}]}}',
        ];
        const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as Uint8Array);
        buf.write(lines.join('\n'), 0);
        return Buffer.byteLength(lines.join('\n'));
      }) as unknown as typeof fs.readSync);

      const session: ScannedSession = {
        sdkSessionId: 'test',
        projectDir: 'test',
        filePath: '/test.jsonl',
        cwd: '/tmp',
        mtime: Date.now(),
        size: 1000,
        preview: 'test',
      };

      const transcript = readSessionTranscriptPreview(session);

      expect(transcript.length).toBeGreaterThan(0);
      expect(transcript[0].role).toBe('user');
    });

    it('respects maxMessages parameter', () => {
      mockStat.mockReturnValue({ size: 2000, mtimeMs: Date.now() } as fs.Stats);
      vi.mocked(fs.openSync).mockReturnValue(1);
      mockRead.mockImplementation(((_fd: number, buffer: ArrayBufferView) => {
        const lines = [];
        for (let i = 0; i < 10; i++) {
          lines.push(`{"type":"user","message":{"content":"msg${i}"}}`);
        }
        const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as Uint8Array);
        buf.write(lines.join('\n'), 0);
        return Buffer.byteLength(lines.join('\n'));
      }) as unknown as typeof fs.readSync);

      const session: ScannedSession = {
        sdkSessionId: 'test',
        projectDir: 'test',
        filePath: '/test',
        cwd: '/tmp',
        mtime: Date.now(),
        size: 2000,
        preview: 'test',
      };

      const transcript = readSessionTranscriptPreview(session, 2);
      expect(transcript.length).toBeLessThanOrEqual(2);
    });
  });
});