import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  scanClaudeSessions,
  scanCodexSessions,
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

type MockClaudeFile = {
  content: string;
  mtimeMs: number;
};

function installClaudeProjects(projects: Record<string, Record<string, MockClaudeFile>>): void {
  const root = '/home/testuser/.claude/projects';
  const openPaths = new Map<number, string>();
  let nextFd = 10;

  mockReaddir.mockImplementation(((path: fs.PathLike, opts?: { withFileTypes?: boolean }) => {
    const pathStr = String(path);
    if (pathStr === root) {
      return opts?.withFileTypes
        ? Object.keys(projects).map((name) => ({ name, isDirectory: () => true }) as fs.Dirent)
        : Object.keys(projects);
    }
    for (const [projectDir, files] of Object.entries(projects)) {
      if (pathStr === `${root}/${projectDir}`) {
        return Object.keys(files);
      }
    }
    throw new Error(`Unexpected readdir path: ${pathStr}`);
  }) as unknown as typeof fs.readdirSync);

  mockStat.mockImplementation(((path: fs.PathLike) => {
    const pathStr = String(path);
    const file = findClaudeFile(projects, pathStr);
    if (!file) throw new Error(`Unexpected stat path: ${pathStr}`);
    return {
      mtimeMs: file.mtimeMs,
      size: Buffer.byteLength(file.content),
    } as fs.Stats;
  }) as unknown as typeof fs.statSync);

  vi.mocked(fs.openSync).mockImplementation(((path: fs.PathLike) => {
    const fd = nextFd++;
    openPaths.set(fd, String(path));
    return fd;
  }) as unknown as typeof fs.openSync);

  mockRead.mockImplementation(((fd: number, buffer: ArrayBufferView, offset = 0, length = 0, position = 0) => {
    const content = findClaudeFile(projects, openPaths.get(fd) ?? '')?.content ?? '';
    const chunk = Buffer.from(content).subarray(position, position + length);
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as Uint8Array);
    chunk.copy(buf, offset);
    return chunk.length;
  }) as unknown as typeof fs.readSync);
}

function findClaudeFile(
  projects: Record<string, Record<string, MockClaudeFile>>,
  filePath: string,
): MockClaudeFile | undefined {
  const root = '/home/testuser/.claude/projects';
  for (const [projectDir, files] of Object.entries(projects)) {
    for (const [fileName, file] of Object.entries(files)) {
      if (filePath === `${root}/${projectDir}/${fileName}`) return file;
    }
  }
  return undefined;
}

function claudeLine(content: string, cwd = '/home/user/project'): string {
  return JSON.stringify({ type: 'user', message: { content }, cwd });
}

function claudeArrayLine(text: string, cwd = '/home/user/project'): string {
  return JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text }] }, cwd });
}

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
      installClaudeProjects({
        '-home-user-project': {
          'session-uuid-123.jsonl': {
            content: claudeLine('test prompt 123'),
            mtimeMs: 1000,
          },
          'session-uuid-456.jsonl': {
            content: claudeLine('test prompt 456', '/home/user/project/subdir'),
            mtimeMs: 2000,
          },
          'notes.txt': {
            content: 'not a session',
            mtimeMs: 3000,
          },
        },
      });

      const sessions = scanClaudeSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions.map((session) => session.sdkSessionId)).toEqual([
        'session-uuid-456',
        'session-uuid-123',
      ]);
      expect(sessions[0]).toMatchObject({
        provider: 'claude',
        providerDisplayName: 'Claude',
        projectDir: '-home-user-project',
        filePath: '/home/testuser/.claude/projects/-home-user-project/session-uuid-456.jsonl',
        cwd: '/home/user/project/subdir',
        mtime: 2000,
        preview: 'test prompt 456',
      });
    });

    it('skips agent-* sessions (subagent sessions)', () => {
      installClaudeProjects({
        'test-project': {
          'agent-subagent-1.jsonl': { content: claudeLine('hidden agent prompt'), mtimeMs: 2000 },
          'main-session.jsonl': { content: claudeLine('main prompt'), mtimeMs: 1000 },
        },
      });

      const sessions = scanClaudeSessions();

      expect(sessions.map((session) => session.sdkSessionId)).toEqual(['main-session']);
    });

    it('extracts preview text from Claude Code content blocks', () => {
      installClaudeProjects({
        project: {
          'array-content.jsonl': {
            content: claudeArrayLine('prompt from text block'),
            mtimeMs: 1000,
          },
        },
      });

      const sessions = scanClaudeSessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        sdkSessionId: 'array-content',
        preview: 'prompt from text block',
      });
      expect(readSessionTranscriptPreview(sessions[0], 1)).toEqual([
        { role: 'user', text: 'prompt from text block', timestamp: undefined },
      ]);
    });

    it('keeps Claude sessions without user preview using a metadata fallback', () => {
      installClaudeProjects({
        project: {
          'title-only.jsonl': {
            content: JSON.stringify({
              type: 'ai-title',
              aiTitle: 'Fallback Claude title',
              cwd: '/home/user/project',
            }),
            mtimeMs: 1000,
          },
        },
      });

      const sessions = scanClaudeSessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        sdkSessionId: 'title-only',
        preview: 'Fallback Claude title',
      });
    });

    it('sorts sessions by mtime descending (most recent first)', () => {
      installClaudeProjects({
        project: {
          'old.jsonl': { content: claudeLine('old prompt'), mtimeMs: 1000 },
          'new.jsonl': { content: claudeLine('new prompt'), mtimeMs: 5000 },
        },
      });

      const sessions = scanClaudeSessions();

      expect(sessions.map((session) => session.sdkSessionId)).toEqual(['new', 'old']);
    });

    it('respects limit parameter', () => {
      installClaudeProjects({
        project: {
          's1.jsonl': { content: claudeLine('prompt 1'), mtimeMs: 1 },
          's2.jsonl': { content: claudeLine('prompt 2'), mtimeMs: 2 },
          's3.jsonl': { content: claudeLine('prompt 3'), mtimeMs: 3 },
          's4.jsonl': { content: claudeLine('prompt 4'), mtimeMs: 4 },
          's5.jsonl': { content: claudeLine('prompt 5'), mtimeMs: 5 },
        },
      });

      const sessions = scanClaudeSessions(2);
      expect(sessions.map((session) => session.sdkSessionId)).toEqual(['s5', 's4']);
    });

    it('filters by cwd when filterByCwd provided', () => {
      installClaudeProjects({
        project: {
          'match-root.jsonl': {
            content: claudeLine('root prompt', '/home/user/specific-project'),
            mtimeMs: 1000,
          },
          'match-child.jsonl': {
            content: claudeLine('child prompt', '/home/user/specific-project/pkg'),
            mtimeMs: 2000,
          },
          'sibling.jsonl': {
            content: claudeLine('sibling prompt', '/home/user/specific-project-other'),
            mtimeMs: 3000,
          },
        },
      });

      const sessions = scanClaudeSessions(10, '/home/user/specific-project');

      expect(sessions.map((session) => session.sdkSessionId)).toEqual([
        'match-child',
        'match-root',
      ]);
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
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      mockReaddir.mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);

      scanClaudeSessions();
      const firstCallCount = mockReaddir.mock.calls.length;

      vi.setSystemTime(7_000);

      scanClaudeSessions();

      expect(mockReaddir.mock.calls.length).toBeGreaterThan(firstCallCount);
      vi.useRealTimers();
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

  describe('scanCodexSessions', () => {
    it('scans Codex sessions across SDK, CLI, and editor originators', () => {
      const sdkId = '019e4b16-a370-7ee0-b14a-ee20923bef5b';
      const cliId = '019e4b16-a370-7ee0-b14a-ee20923bef5c';
      const sdkFile = `rollout-2026-05-21T23-10-35-${sdkId}.jsonl`;
      const cliFile = `rollout-2026-05-21T23-10-35-${cliId}.jsonl`;
      const sdkPath = `/home/testuser/.codex/sessions/2026/05/21/${sdkFile}`;
      const cliPath = `/home/testuser/.codex/sessions/2026/05/21/${cliFile}`;
      const contents = new Map<string, string>([
        [
          sdkPath,
          [
            JSON.stringify({
              type: 'session_meta',
              payload: { id: sdkId, cwd: '/repo/codex', originator: 'codex_sdk_ts' },
            }),
            JSON.stringify({
              type: 'response_item',
              payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'codex prompt text' }],
              },
            }),
            JSON.stringify({
              type: 'response_item',
              payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'codex response' }],
              },
            }),
          ].join('\n'),
        ],
        [
          cliPath,
          [
            JSON.stringify({
              type: 'session_meta',
              payload: { id: cliId, cwd: '/repo/cli', originator: 'codex_tui' },
            }),
            JSON.stringify({
              type: 'event_msg',
              payload: { type: 'user_message', message: 'cli prompt text' },
            }),
          ].join('\n'),
        ],
      ]);
      const openPaths = new Map<number, string>();
      let nextFd = 10;

      mockReaddir.mockImplementation(((path: fs.PathLike) => {
        const pathStr = String(path);
        if (pathStr.endsWith('/.codex/sessions')) {
          return [{ name: '2026', isDirectory: () => true } as fs.Dirent];
        }
        if (pathStr.endsWith('/.codex/sessions/2026')) {
          return [{ name: '05', isDirectory: () => true } as fs.Dirent];
        }
        if (pathStr.endsWith('/.codex/sessions/2026/05')) {
          return [{ name: '21', isDirectory: () => true } as fs.Dirent];
        }
        if (pathStr.endsWith('/.codex/sessions/2026/05/21')) {
          return [
            { name: sdkFile, isDirectory: () => false } as fs.Dirent,
            { name: cliFile, isDirectory: () => false } as fs.Dirent,
          ];
        }
        throw new Error('ENOENT');
      }) as unknown as typeof fs.readdirSync);

      mockStat.mockImplementation(((path: fs.PathLike) => {
        const content = contents.get(String(path)) ?? '';
        return { mtimeMs: String(path) === sdkPath ? 2000 : 1000, size: Buffer.byteLength(content) } as fs.Stats;
      }) as unknown as typeof fs.statSync);

      vi.mocked(fs.openSync).mockImplementation(((path: fs.PathLike) => {
        const fd = nextFd++;
        openPaths.set(fd, String(path));
        return fd;
      }) as unknown as typeof fs.openSync);
      mockRead.mockImplementation(((fd: number, buffer: ArrayBufferView, offset: number, length: number, position: number) => {
        const content = contents.get(openPaths.get(fd) ?? '') ?? '';
        const chunk = Buffer.from(content).subarray(position, position + length);
        const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as Uint8Array);
        chunk.copy(buf, offset);
        return chunk.length;
      }) as unknown as typeof fs.readSync);

      const sessions = scanCodexSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions[0]).toMatchObject({
        provider: 'codex',
        sdkSessionId: sdkId,
        cwd: '/repo/codex',
        preview: 'codex prompt text',
      });
      expect(sessions[1]).toMatchObject({
        provider: 'codex',
        sdkSessionId: cliId,
        cwd: '/repo/cli',
        preview: 'cli prompt text',
      });
      expect(readSessionTranscriptPreview(sessions[0], 2)).toEqual([
        { role: 'user', text: 'codex prompt text', timestamp: undefined },
        { role: 'assistant', text: 'codex response', timestamp: undefined },
      ]);
    });

    it('keeps Codex sessions without user preview using a session fallback', () => {
      const id = '019e4b16-a370-7ee0-b14a-ee20923bef5d';
      const file = `rollout-2026-05-21T23-10-35-${id}.jsonl`;
      const filePath = `/home/testuser/.codex/sessions/2026/05/21/${file}`;
      const content = JSON.stringify({
        type: 'session_meta',
        payload: { id, cwd: '/repo/codex', originator: 'codex_tui' },
      });
      const openPaths = new Map<number, string>();
      let nextFd = 10;

      mockReaddir.mockImplementation(((path: fs.PathLike) => {
        const pathStr = String(path);
        if (pathStr.endsWith('/.codex/sessions')) {
          return [{ name: '2026', isDirectory: () => true } as fs.Dirent];
        }
        if (pathStr.endsWith('/.codex/sessions/2026')) {
          return [{ name: '05', isDirectory: () => true } as fs.Dirent];
        }
        if (pathStr.endsWith('/.codex/sessions/2026/05')) {
          return [{ name: '21', isDirectory: () => true } as fs.Dirent];
        }
        if (pathStr.endsWith('/.codex/sessions/2026/05/21')) {
          return [{ name: file, isDirectory: () => false } as fs.Dirent];
        }
        throw new Error('ENOENT');
      }) as unknown as typeof fs.readdirSync);

      mockStat.mockReturnValue({ mtimeMs: 1000, size: Buffer.byteLength(content) } as fs.Stats);
      vi.mocked(fs.openSync).mockImplementation(((path: fs.PathLike) => {
        const fd = nextFd++;
        openPaths.set(fd, String(path));
        return fd;
      }) as unknown as typeof fs.openSync);
      mockRead.mockImplementation(
        ((fd: number, buffer: ArrayBufferView, offset: number, length: number, position: number) => {
          const chunk = Buffer.from(openPaths.get(fd) === filePath ? content : '').subarray(
            position,
            position + length,
          );
          const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as Uint8Array);
          chunk.copy(buf, offset);
          return chunk.length;
        }) as unknown as typeof fs.readSync,
      );

      const sessions = scanCodexSessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        sdkSessionId: id,
        cwd: '/repo/codex',
        preview: 'Codex session 019e4b16',
      });
    });
  });

  describe('readSessionTranscriptPreview', () => {
    it('returns empty array on file read error', () => {
      mockStat.mockImplementation((() => {
        throw new Error('ENOENT');
      }) as unknown as typeof fs.statSync);

      const session: ScannedSession = {
        provider: 'claude',
        providerDisplayName: 'Claude',
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
        provider: 'claude',
        providerDisplayName: 'Claude',
        sdkSessionId: 'test',
        projectDir: 'test',
        filePath: '/test.jsonl',
        cwd: '/tmp',
        mtime: Date.now(),
        size: 1000,
        preview: 'test',
      };

      const transcript = readSessionTranscriptPreview(session);

      expect(transcript).toEqual([
        { role: 'user', text: 'user message', timestamp: '2026-01-01' },
        { role: 'assistant', text: 'assistant response', timestamp: undefined },
      ]);
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
        provider: 'claude',
        providerDisplayName: 'Claude',
        sdkSessionId: 'test',
        projectDir: 'test',
        filePath: '/test',
        cwd: '/tmp',
        mtime: Date.now(),
        size: 2000,
        preview: 'test',
      };

      const transcript = readSessionTranscriptPreview(session, 2);
      expect(transcript.map((message) => message.text)).toEqual(['msg8', 'msg9']);
    });
  });
});
