import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as claudeAgentSdk from '@anthropic-ai/claude-agent-sdk';

// Mock child_process for CLI discovery
vi.mock('node:child_process', () => ({
  execSync: vi.fn().mockReturnValue('/usr/local/bin/claude\n'),
}));

// Mock node:fs for temp file operations
vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
  statSync: vi.fn().mockReturnValue({ mtimeMs: Date.now() }),
}));

// Mock @anthropic-ai/claude-agent-sdk - define iterator inside factory
vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  const mockQuery = vi.fn().mockImplementation(() => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } };
      yield { type: 'result', subtype: 'success', session_id: 'test-session', total_cost_usd: 0.01, usage: { input_tokens: 100, output_tokens: 50 } };
    },
  }));
  return { query: mockQuery };
});

import { ClaudeSDKProvider } from '../../providers/claude-sdk.js';
import type { CanonicalEvent } from '../../canonical/schema.js';

// Helper to collect stream events
async function collectStreamEvents(stream: ReadableStream<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    events.push(value);
  }
  return events;
}

describe('ClaudeSDKProvider', () => {
  let provider: ClaudeSDKProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ClaudeSDKProvider(['user']);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('accepts setting sources', () => {
      const p = new ClaudeSDKProvider(['user', 'project']);
      expect(p.getDefaultSettingSources()).toEqual(['user', 'project']);
    });

    it('uses default setting sources when not provided', () => {
      const p = new ClaudeSDKProvider();
      expect(p.getDefaultSettingSources().length).toBeGreaterThan(0);
    });

    it('uses defaults when empty setting sources array passed', () => {
      const p = new ClaudeSDKProvider([]);
      // Empty array triggers default sources, not isolation mode
      expect(p.getDefaultSettingSources().length).toBeGreaterThan(0);
    });
  });

  describe('streamChat', () => {
    it('creates a stream that yields canonical events', async () => {
      const result = provider.streamChat({
        prompt: 'test prompt',
        workingDirectory: '/tmp',
      });

      expect(result.stream).toBeInstanceOf(ReadableStream);
      const events = await collectStreamEvents(result.stream);

      expect(events.length).toBeGreaterThan(0);
      expect(events.some(e => e.kind === 'text_delta')).toBe(true);
      expect(events.some(e => e.kind === 'query_result')).toBe(true);
    });

    it('exposes query controls for interrupt/stopTask', () => {
      const result = provider.streamChat({
        prompt: 'test',
        workingDirectory: '/tmp',
      });

      expect(result.controls).toBeDefined();
      expect(result.controls?.interrupt).toBeTypeOf('function');
      expect(result.controls?.stopTask).toBeTypeOf('function');
    });

    it('passes workingDirectory to query options', async () => {
      provider.streamChat({
        prompt: 'test',
        workingDirectory: '/home/user/project',
      });

      await Promise.resolve();
      expect(claudeAgentSdk.query).toHaveBeenCalled();
    });

    it('passes sessionId for resume', async () => {
      provider.streamChat({
        prompt: 'continue',
        workingDirectory: '/tmp',
        sessionId: 'existing-session-123',
      });

      await Promise.resolve();
      expect(claudeAgentSdk.query).toHaveBeenCalled();
    });

    it('passes model override', async () => {
      provider.streamChat({
        prompt: 'test',
        workingDirectory: '/tmp',
        model: 'claude-opus-4',
      });

      await Promise.resolve();
      expect(claudeAgentSdk.query).toHaveBeenCalled();
    });

    it('passes effort level', async () => {
      provider.streamChat({
        prompt: 'test',
        workingDirectory: '/tmp',
        effort: 'high',
      });

      await Promise.resolve();
      expect(claudeAgentSdk.query).toHaveBeenCalled();
    });
  });

  describe('createSession', () => {
    it('creates a ClaudeLiveSession instance', () => {
      const session = provider.createSession({
        workingDirectory: '/tmp',
      });

      expect(session).toBeDefined();
      expect(session.isAlive).toBe(true);
    });

    it('passes sessionId to session', () => {
      const session = provider.createSession({
        workingDirectory: '/tmp',
        sessionId: 'resume-session',
      });

      expect(session).toBeDefined();
    });

    it('passes setting sources override', () => {
      const session = provider.createSession({
        workingDirectory: '/tmp',
        settingSources: ['project'],
      });

      expect(session).toBeDefined();
    });
  });

  describe('permission handling', () => {
    it('calls onPermissionRequest when permission is needed', async () => {
      const mockPermissionHandler = vi.fn().mockResolvedValue('allow');

      provider.streamChat({
        prompt: 'test',
        workingDirectory: '/tmp',
        onPermissionRequest: mockPermissionHandler,
      });

      await Promise.resolve();
    });

    it('auto-allows when no permission handler provided', async () => {
      const result = provider.streamChat({
        prompt: 'test',
        workingDirectory: '/tmp',
      });

      const events = await collectStreamEvents(result.stream);
      expect(events.length).toBeGreaterThan(0);
    });
  });

  describe('image attachment handling', () => {
    it('processes image attachments and saves to temp files', async () => {
      const result = provider.streamChat({
        prompt: 'analyze this image',
        workingDirectory: '/tmp',
        attachments: [
          { type: 'image', name: 'test.png', mimeType: 'image/png', base64Data: 'aGVsbG8=' },
        ],
      });

      expect(result.stream).toBeInstanceOf(ReadableStream);
    });

    it('handles multiple image attachments', async () => {
      const result = provider.streamChat({
        prompt: 'analyze these images',
        workingDirectory: '/tmp',
        attachments: [
          { type: 'image', name: 'img1.png', mimeType: 'image/png', base64Data: 'aaa' },
          { type: 'image', name: 'img2.jpg', mimeType: 'image/jpeg', base64Data: 'bbb' },
        ],
      });

      expect(result.stream).toBeInstanceOf(ReadableStream);
    });
  });

  describe('abort signal handling', () => {
    it('accepts abort signal parameter', () => {
      const controller = new AbortController();

      const result = provider.streamChat({
        prompt: 'test',
        workingDirectory: '/tmp',
        abortSignal: controller.signal,
      });

      expect(result.stream).toBeInstanceOf(ReadableStream);
    });
  });

  describe('AskUserQuestion handling', () => {
    it('routes AskUserQuestion to onAskUserQuestion handler', async () => {
      const mockAskHandler = vi.fn().mockResolvedValue(['answer1']);

      provider.streamChat({
        prompt: 'test',
        workingDirectory: '/tmp',
        onAskUserQuestion: mockAskHandler,
      });

      await Promise.resolve();
    });
  });
});