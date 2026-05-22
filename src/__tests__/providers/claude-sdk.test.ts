import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as claudeAgentSdk from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'node:fs';

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
    interrupt: vi.fn().mockResolvedValue(undefined),
    stopTask: vi.fn().mockResolvedValue(undefined),
    async *[Symbol.asyncIterator]() {
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } };
      yield { type: 'result', subtype: 'success', session_id: 'test-session', total_cost_usd: 0.01, usage: { input_tokens: 100, output_tokens: 50 } };
    },
  }));
  return { query: mockQuery };
});

import { ClaudeSDKProvider } from '../../providers/claude-sdk.js';
import type { CanonicalEvent } from '../../canonical/schema.js';
import { DEFAULT_AGENT_SETTING_SOURCES } from '../../config.js';

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

function lastQueryCall(): { prompt: unknown; options: Record<string, any> } {
  return vi.mocked(claudeAgentSdk.query).mock.calls.at(-1)?.[0] as {
    prompt: unknown;
    options: Record<string, any>;
  };
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
    it('marks Claude as an interactive runtime', () => {
      expect(provider.capabilities.runtimeMode).toBe('interactive');
      expect(provider.capabilities.nativeSteer).toBe(true);
      expect(provider.capabilities.nativeQueue).toBe(true);
    });

    it('accepts setting sources', () => {
      const p = new ClaudeSDKProvider(['user', 'project']);
      expect(p.getDefaultSettingSources()).toEqual(['user', 'project']);
    });

    it('uses default setting sources when not provided', () => {
      const p = new ClaudeSDKProvider();
      expect(p.getDefaultSettingSources()).toEqual(DEFAULT_AGENT_SETTING_SOURCES);
      const defaults = p.getDefaultSettingSources();
      defaults.push('local');
      expect(p.getDefaultSettingSources()).toEqual(DEFAULT_AGENT_SETTING_SOURCES);
    });

    it('uses defaults when empty setting sources array passed', () => {
      const p = new ClaudeSDKProvider([]);
      expect(p.getDefaultSettingSources()).toEqual(DEFAULT_AGENT_SETTING_SOURCES);
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

      expect(events.map(e => e.kind)).toEqual(['text_delta', 'query_result']);
      expect(events[0]).toMatchObject({ kind: 'text_delta', text: 'Hello' });
      expect(events[1]).toMatchObject({
        kind: 'query_result',
        sessionId: 'test-session',
      });
    });

    it('exposes query controls for interrupt/stopTask', async () => {
      const result = provider.streamChat({
        prompt: 'test',
        workingDirectory: '/tmp',
      });
      const queryLike = vi.mocked(claudeAgentSdk.query).mock.results.at(-1)?.value as any;

      expect(result.controls).toMatchObject({
        interrupt: expect.any(Function),
        stopTask: expect.any(Function),
      });
      await result.controls!.interrupt();
      await result.controls!.stopTask('task-1');
      expect(queryLike.interrupt).toHaveBeenCalled();
      expect(queryLike.stopTask).toHaveBeenCalledWith('task-1');
    });

    it('passes runtime options to Claude query', () => {
      provider.streamChat({
        prompt: 'continue',
        workingDirectory: '/home/user/project',
        sessionId: 'existing-session-123',
        model: 'claude-opus-4',
        effort: 'high',
        settingSources: ['project'],
      });

      const call = lastQueryCall();
      expect(call.prompt).toBe('continue');
      expect(call.options).toMatchObject({
        cwd: '/home/user/project',
        resume: 'existing-session-123',
        model: 'claude-opus-4',
        effort: 'high',
        settingSources: ['project'],
        pathToClaudeCodeExecutable: '/usr/local/bin/claude',
      });
    });
  });

  describe('createSession', () => {
    it('creates an alive ClaudeLiveSession and passes options to the persistent query', () => {
      const session = provider.createSession({
        workingDirectory: '/tmp',
        sessionId: 'resume-session',
        settingSources: ['project'],
      });

      expect(session.isAlive).toBe(true);
      expect(lastQueryCall().options).toMatchObject({
        cwd: '/tmp',
        resume: 'resume-session',
        settingSources: ['project'],
        toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
      });
    });

    it('exposes runtime info from current Claude session options', () => {
      const session = provider.createSession({
        workingDirectory: '/tmp',
        model: 'claude-opus-4',
        effort: 'high',
      });

      expect(session.runtimeInfo).toMatchObject({
        provider: 'claude',
        displayName: 'Claude Code',
        model: 'claude-opus-4',
        reasoningEffort: 'high',
      });
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

      const result = await lastQueryCall().options.canUseTool(
        'Bash',
        { command: 'rm -rf x' },
        { toolUseID: 'tool-1', decisionReason: 'Needs Bash' },
      );

      expect(mockPermissionHandler).toHaveBeenCalledWith(
        'Bash',
        { command: 'rm -rf x' },
        'Needs Bash',
        undefined,
      );
      expect(result).toMatchObject({
        behavior: 'allow',
        updatedInput: { command: 'rm -rf x' },
        toolUseID: 'tool-1',
      });
    });

    it('auto-allows when no permission handler provided', async () => {
      provider.streamChat({
        prompt: 'test',
        workingDirectory: '/tmp',
      });

      await expect(
        lastQueryCall().options.canUseTool('Bash', { command: 'pwd' }, { toolUseID: 'tool-1' }),
      ).resolves.toMatchObject({
        behavior: 'allow',
        updatedInput: { command: 'pwd' },
      });
    });
  });

  describe('image attachment handling', () => {
    it('writes image attachments and sends Claude a prompt containing their temp paths', () => {
      provider.streamChat({
        prompt: 'analyze these images',
        workingDirectory: '/tmp',
        attachments: [
          { type: 'image', name: 'img1.png', mimeType: 'image/png', base64Data: 'aW1nMQ==' },
          { type: 'image', name: 'img2.jpg', mimeType: 'image/jpeg', base64Data: 'aW1nMg==' },
        ],
      });

      expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
      expect(String(vi.mocked(fs.writeFileSync).mock.calls[0][0])).toContain('.png');
      expect(String(vi.mocked(fs.writeFileSync).mock.calls[1][0])).toContain('.jpg');
      expect(lastQueryCall().prompt).toContain('[User sent 2 image(s)');
      expect(lastQueryCall().prompt).toContain('analyze these images');
    });
  });

  describe('abort signal handling', () => {
    it('accepts abort signal parameter', () => {
      const controller = new AbortController();

      provider.streamChat({
        prompt: 'test',
        workingDirectory: '/tmp',
        abortSignal: controller.signal,
      });

      const abortController = lastQueryCall().options.abortController as AbortController;
      expect(abortController.signal.aborted).toBe(false);
      controller.abort('stop');
      expect(abortController.signal.aborted).toBe(true);
      expect(abortController.signal.reason).toBe('stop');
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

      const questions = [
        { question: 'Pick one', header: 'Choice', options: [], multiSelect: false },
      ];
      const result = await lastQueryCall().options.canUseTool(
        'AskUserQuestion',
        { questions },
        { toolUseID: 'ask-1' },
      );

      expect(mockAskHandler).toHaveBeenCalledWith(questions, undefined);
      expect(result).toMatchObject({
        behavior: 'allow',
        updatedInput: { questions, answers: ['answer1'] },
      });
    });

    it('routes deferred tools to onDeferredTool in streamChat fallback', async () => {
      const mockDeferredHandler = vi.fn().mockResolvedValue({
        behavior: 'allow',
        updatedInput: { accepted: true },
      });

      provider.streamChat({
        prompt: 'test',
        workingDirectory: '/tmp',
        onDeferredTool: mockDeferredHandler,
      });

      const queryCall = vi.mocked(claudeAgentSdk.query).mock.calls.at(-1)?.[0] as any;
      const result = await queryCall.options.canUseTool(
        'EnterPlanMode',
        { plan: 'review' },
        { toolUseID: 'tool-1' },
      );

      expect(mockDeferredHandler).toHaveBeenCalledWith(
        'EnterPlanMode',
        { plan: 'review' },
        undefined,
      );
      expect(result).toMatchObject({
        behavior: 'allow',
        updatedInput: { accepted: true },
        toolUseID: 'tool-1',
      });
    });
  });
});
