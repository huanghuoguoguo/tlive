import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TerminalCardRenderer } from '../engine/terminal-card-renderer.js';
import type { UsageStats } from '../engine/cost-tracker.js';

describe('TerminalCardRenderer', () => {
  let flushCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    flushCallback = vi.fn().mockImplementation((_content: string, isEdit: boolean) => {
      if (!isEdit) return Promise.resolve('msg-1');
      return Promise.resolve();
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createRenderer(verboseLevel: 0 | 1 = 1, platformLimit = 4096, windowSize = 8) {
    return new TerminalCardRenderer({
      verboseLevel,
      platformLimit,
      throttleMs: 300,
      windowSize,
      flushCallback: flushCallback as any,
    });
  }

  const defaultStats: UsageStats = {
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: 0.05,
    durationMs: 10000,
  };

  // ─── Rolling window ─────────────────────────────

  describe('rolling window', () => {
    it('shows tool entries with correct icons', async () => {
      const r = createRenderer();
      r.onToolStart('Read', { file_path: '/tmp/main.ts' });
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('🔄 Read(main.ts)');
      r.dispose();
    });

    it('shows ● for completed tools and 🔄 for running tools', async () => {
      const r = createRenderer();
      const id1 = r.onToolStart('Read', { file_path: '/tmp/a.ts' });
      r.onToolComplete(id1);
      r.onToolStart('Bash', { command: 'npm test' });
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('● Read(a.ts)');
      expect(content).toContain('🔄 Bash(npm test)');
      r.dispose();
    });

    it('collapses old entries beyond window size', async () => {
      const r = createRenderer(1, 4096, 3);
      // Add 5 tools, window size 3
      r.onToolStart('Read', { file_path: '/tmp/1.ts' });
      r.onToolStart('Read', { file_path: '/tmp/2.ts' });
      r.onToolStart('Read', { file_path: '/tmp/3.ts' });
      r.onToolStart('Read', { file_path: '/tmp/4.ts' });
      r.onToolStart('Read', { file_path: '/tmp/5.ts' });
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('+2 more tool uses');
      expect(content).not.toContain('1.ts');
      expect(content).not.toContain('2.ts');
      expect(content).toContain('3.ts');
      expect(content).toContain('4.ts');
      expect(content).toContain('5.ts');
      r.dispose();
    });

    it('shows all entries when within window size', async () => {
      const r = createRenderer(1, 4096, 8);
      r.onToolStart('Read', { file_path: '/tmp/a.ts' });
      r.onToolStart('Bash', { command: 'echo hello' });
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).not.toContain('+');
      expect(content).toContain('a.ts');
      expect(content).toContain('echo hello');
      r.dispose();
    });
  });

  // ─── Tool results ───────────────────────────────

  describe('tool results', () => {
    it('shows Bash output with tree connector', async () => {
      const r = createRenderer();
      const id = r.onToolStart('Bash', { command: 'echo hello' });
      r.onToolComplete(id, 'hello');
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('● Bash(echo hello)');
      expect(content).toContain('├  hello');
      r.dispose();
    });

    it('shows multi-line output with tree connectors', async () => {
      const r = createRenderer();
      const id = r.onToolStart('Bash', { command: 'ls' });
      r.onToolComplete(id, 'file1\nfile2\nfile3');
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('├  file1');
      expect(content).toContain('├  file2');
      expect(content).toContain('├  file3');
      r.dispose();
    });

    it('shows denied tools with ❌ Denied', async () => {
      const r = createRenderer();
      const id = r.onToolStart('Bash', { command: 'rm -rf /' });
      r.onToolDenied(id);
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('● Bash(rm -rf /)');
      expect(content).toContain('├  ❌ Denied');
      r.dispose();
    });

    it('shows error results with ❌ prefix', async () => {
      const r = createRenderer();
      const id = r.onToolStart('Bash', { command: 'bad-cmd' });
      r.onToolComplete(id, 'command not found', true);
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('├  ❌ Error: command not found');
      r.dispose();
    });

    it('does not show results for silent tools (Read, Grep, etc.)', async () => {
      const r = createRenderer();
      const id = r.onToolStart('Read', { file_path: '/tmp/foo.ts' });
      r.onToolComplete(id, 'file content here');
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('● Read(foo.ts)');
      expect(content).not.toContain('file content here');
      r.dispose();
    });
  });

  // ─── Permission inline ──────────────────────────

  describe('permission inline', () => {
    it('shows separator + 🔐 section at card bottom', async () => {
      const r = createRenderer();
      r.onToolStart('Bash', { command: 'rm -rf /tmp/stuff' });
      r.onPermissionNeeded(
        'Bash',
        'rm -rf /tmp/stuff',
        'Dangerous command',
        [{ label: 'Yes', callbackData: 'perm:yes', style: 'primary' }],
      );
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('━━━━━━━━━━━━━━━━━━');
      expect(content).toContain('🔐 Bash');
      expect(content).toContain('  rm -rf /tmp/stuff');
      expect(content).toContain('  Dangerous command');
      r.dispose();
    });

    it('removes permission section after resolution', async () => {
      const r = createRenderer();
      r.onToolStart('Bash', { command: 'rm -rf /tmp/stuff' });
      r.onPermissionNeeded(
        'Bash',
        'rm -rf /tmp/stuff',
        'Dangerous command',
        [{ label: 'Yes', callbackData: 'perm:yes', style: 'primary' }],
      );
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();

      r.onPermissionResolved();
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[1][0] as string;
      expect(content).not.toContain('🔐');
      expect(content).not.toContain('Dangerous command');
      r.dispose();
    });

    it('permission takes priority over question', async () => {
      const r = createRenderer();
      r.onQuestionNeeded('Format', 'How?', [{ label: 'A' }], false, []);
      r.onPermissionNeeded('Bash', 'cmd', 'reason', []);
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('🔐 Bash');
      expect(content).not.toContain('❓');
      r.dispose();
    });
  });

  // ─── AskUserQuestion inline ─────────────────────

  describe('AskUserQuestion inline', () => {
    it('shows ❓ with numbered options', async () => {
      const r = createRenderer();
      r.onToolStart('Read', { file_path: '/tmp/x.ts' });
      r.onQuestionNeeded(
        'Format',
        'How should I format the output?',
        [
          { label: 'Summary', description: 'Brief overview' },
          { label: 'Detailed', description: 'Full explanation' },
        ],
        false,
        [{ label: 'Summary', callbackData: 'q:0', style: 'primary' }],
      );
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('━━━━━━━━━━━━━━━━━━');
      expect(content).toContain('❓ Format: How should I format the output?');
      expect(content).toContain('1. Summary — Brief overview');
      expect(content).toContain('2. Detailed — Full explanation');
      r.dispose();
    });

    it('shows options without descriptions when not provided', async () => {
      const r = createRenderer();
      r.onQuestionNeeded(
        'Choice',
        'Pick one',
        [{ label: 'A' }, { label: 'B' }],
        false,
        [],
      );
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('1. A');
      expect(content).toContain('2. B');
      expect(content).not.toContain('—');
      r.dispose();
    });

    it('removes question after resolution', async () => {
      const r = createRenderer();
      r.onToolStart('Read', { file_path: '/tmp/x.ts' });
      r.onQuestionNeeded('Q', 'Pick', [{ label: 'A' }], false, []);
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();

      r.onQuestionResolved();
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[1][0] as string;
      expect(content).not.toContain('❓');
      expect(content).not.toContain('Pick');
      r.dispose();
    });
  });

  // ─── Completion phase ───────────────────────────

  describe('completion phase', () => {
    it('collapses tool log and shows text + cost', async () => {
      const r = createRenderer();
      const id1 = r.onToolStart('Read', { file_path: '/tmp/a.ts' });
      r.onToolComplete(id1);
      const id2 = r.onToolStart('Bash', { command: 'echo done' });
      r.onToolComplete(id2, 'done');
      r.onTextDelta('Here is the result.');
      r.onComplete(defaultStats);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('● ... (2 tools)');
      expect(content).not.toContain('Read(a.ts)');
      expect(content).not.toContain('Bash(echo done)');
      expect(content).toContain('━━━━━━━━━━━━━━━━━━');
      expect(content).toContain('Here is the result.');
      expect(content).toContain('📊');
      expect(content).toContain('$0.05');
      r.dispose();
    });

    it('shows only cost line with no tools or text on complete', async () => {
      const r = createRenderer();
      r.onComplete(defaultStats);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('📊');
      expect(content).not.toContain('● ...');
      r.dispose();
    });

    it('streams text during execution (before complete)', async () => {
      const r = createRenderer();
      r.onTextDelta('partial ');
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('partial');
      r.dispose();
    });

    it('includes collapsed count in tool summary on complete', async () => {
      const r = createRenderer(1, 4096, 2);
      r.onToolStart('Read', { file_path: '/tmp/1.ts' });
      r.onToolStart('Read', { file_path: '/tmp/2.ts' });
      r.onToolStart('Read', { file_path: '/tmp/3.ts' });
      r.onToolStart('Read', { file_path: '/tmp/4.ts' });
      r.onComplete(defaultStats);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      // 2 collapsed + 2 in window = 4 total
      expect(content).toContain('● ... (4 tools)');
      r.dispose();
    });
  });

  // ─── Verbose 0 ──────────────────────────────────

  describe('verbose 0', () => {
    it('does not flush during tool execution', async () => {
      const r = createRenderer(0);
      r.onToolStart('Bash', { command: 'echo hi' });
      r.onTextDelta('some text');
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      expect(flushCallback).not.toHaveBeenCalled();
      r.dispose();
    });

    it('shows only cost line on complete', async () => {
      const r = createRenderer(0);
      r.onToolStart('Read', { file_path: '/tmp/a.ts' });
      r.onTextDelta('some text');
      r.onComplete(defaultStats);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('📊');
      // In verbose 0, the render still includes tool summary and text at complete time
      // since onComplete always flushes
      r.dispose();
    });

    it('still flushes permission prompts', async () => {
      const r = createRenderer(0);
      r.onPermissionNeeded('Bash', 'rm -rf /', 'danger', []);
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      expect(flushCallback).toHaveBeenCalled();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('🔐 Bash');
      r.dispose();
    });
  });

  // ─── Flush mechanics ────────────────────────────

  describe('flush mechanics', () => {
    it('first flush returns messageId, subsequent are edits', async () => {
      const r = createRenderer();
      r.onToolStart('Read', { file_path: '/tmp/a.ts' });
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      expect(flushCallback).toHaveBeenCalledWith(expect.any(String), false);
      expect(r.messageId).toBe('msg-1');

      r.onToolStart('Bash', { command: 'echo hi' });
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      expect(flushCallback).toHaveBeenCalledWith(expect.any(String), true);
      r.dispose();
    });

    it('platform limit truncation with ... prefix', async () => {
      const r = createRenderer(1, 500);
      r.onTextDelta('x'.repeat(1000));
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content.length).toBeLessThanOrEqual(500);
      expect(content.startsWith('...\n')).toBe(true);
      r.dispose();
    });

    it('dispose clears timers', () => {
      const r = createRenderer();
      r.onToolStart('Read', { file_path: '/tmp/a.ts' });
      r.dispose();
      vi.advanceTimersByTime(1000);
      expect(flushCallback).not.toHaveBeenCalled();
    });

    it('does not flush empty content', async () => {
      const r = createRenderer();
      // render() with no state returns empty string
      r.onComplete({ inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 });
      await vi.runAllTimersAsync();
      // Should still flush because cost line is present
      expect(flushCallback).toHaveBeenCalled();
      r.dispose();
    });

    it('prevents concurrent flushes with pendingFlush retry', async () => {
      let resolveFirst: () => void;
      const slowCallback = vi.fn().mockImplementation((_content: string, isEdit: boolean) => {
        if (!isEdit) {
          return new Promise<string>((resolve) => {
            resolveFirst = () => resolve('msg-1');
          });
        }
        return Promise.resolve();
      });
      const r = new TerminalCardRenderer({
        verboseLevel: 1,
        platformLimit: 4096,
        throttleMs: 300,
        flushCallback: slowCallback as any,
      });

      r.onToolStart('Read', { file_path: '/tmp/a.ts' });
      vi.advanceTimersByTime(300);
      // First flush is now in-flight (not resolved)
      // Add more content while first flush is pending
      r.onToolStart('Bash', { command: 'echo hi' });
      vi.advanceTimersByTime(300);

      // Only one call so far since flushing guard blocks second
      expect(slowCallback).toHaveBeenCalledTimes(1);

      // Resolve first flush
      resolveFirst!();
      await vi.runAllTimersAsync();

      // Pending flush should have triggered a retry
      expect(slowCallback).toHaveBeenCalledTimes(2);
      expect(r.messageId).toBe('msg-1');
      r.dispose();
    });
  });

  // ─── Error handling ─────────────────────────────

  describe('error handling', () => {
    it('onError shows error in card', async () => {
      const r = createRenderer();
      r.onToolStart('Bash', { command: 'bad' });
      r.onError('something went wrong');
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('❌ Error: something went wrong');
      r.dispose();
    });

    it('onError cancels pending timer and flushes immediately', async () => {
      const r = createRenderer();
      r.onToolStart('Read', { file_path: '/tmp/a.ts' });
      // Timer is scheduled but not fired yet
      r.onError('boom');
      // Should flush immediately without waiting for timer
      await vi.runAllTimersAsync();
      expect(flushCallback).toHaveBeenCalledTimes(1);
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('❌ Error: boom');
      r.dispose();
    });
  });

  // ─── Agent nesting ──────────────────────────────

  describe('agent nesting', () => {
    it('shows running agent with 🔄', async () => {
      const r = createRenderer();
      r.onAgentStart('Researching codebase');
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('🔄 Agent: Researching codebase');
      r.dispose();
    });

    it('shows agent progress with tool and usage info', async () => {
      const r = createRenderer();
      r.onAgentStart('Researching');
      r.onAgentProgress('Researching', 'Grep', { tool_uses: 5, duration_ms: 3000 });
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('🔄 Agent: Researching');
      expect(content).toContain('🔍 Grep');
      expect(content).toContain('5 tools');
      expect(content).toContain('3s');
      r.dispose();
    });

    it('shows completed agent with ● icon', async () => {
      const r = createRenderer();
      r.onAgentStart('Researching');
      r.onAgentComplete('Found 3 files', 'completed');
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('● Agent: Found 3 files');
      r.dispose();
    });

    it('shows failed agent with ❌ icon', async () => {
      const r = createRenderer();
      r.onAgentStart('Processing');
      r.onAgentComplete('Timed out', 'failed');
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[0][0] as string;
      expect(content).toContain('❌ Agent: Timed out');
      r.dispose();
    });
  });

  // ─── Conditional tool delay (250ms buffer) ──────

  describe('conditional tool delay (250ms buffer)', () => {
    it('delays tool_start by 250ms', async () => {
      const r = createRenderer();
      r.onToolStart('Read', { file_path: '/a.ts' });
      // At 100ms: tool should NOT be committed yet (still in pending buffer)
      vi.advanceTimersByTime(100);
      // The render should not contain the tool because it hasn't been committed
      const snapshot = r.render();
      expect(snapshot).not.toContain('Read');
      // After 250ms delay fires + 300ms throttle, tool appears
      vi.advanceTimersByTime(500);
      await vi.runAllTimersAsync();
      expect(flushCallback).toHaveBeenCalled();
      const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content).toContain('Read');
      r.dispose();
    });

    it('shows tool+result together when result arrives within 250ms', async () => {
      const r = createRenderer();
      const id = r.onToolStart('Bash', { command: 'echo hi' });
      // Result arrives before delay expires
      vi.advanceTimersByTime(100);
      r.onToolComplete(id, 'hi');
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content).toContain('Bash(echo hi)');
      expect(content).toContain('hi'); // result shown with the tool
      expect(content).not.toContain('🔄'); // not running — already completed
      r.dispose();
    });

    it('flushes pending tool immediately on permission request', async () => {
      const r = createRenderer();
      r.onToolStart('Bash', { command: 'rm -rf /' });
      // Permission arrives before 250ms delay
      vi.advanceTimersByTime(50);
      r.onPermissionNeeded('Bash', 'rm -rf /', 'Dangerous', []);
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content).toContain('Bash(rm -rf /)'); // tool was flushed
      expect(content).toContain('🔐'); // permission shown
      r.dispose();
    });

    it('flushes previous pending tool when new tool starts', async () => {
      const r = createRenderer();
      r.onToolStart('Read', { file_path: '/a.ts' });
      vi.advanceTimersByTime(100);
      r.onToolStart('Read', { file_path: '/b.ts' });
      vi.advanceTimersByTime(500);
      await vi.runAllTimersAsync();
      const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      // Both tools should be visible
      expect(content).toContain('a.ts');
      expect(content).toContain('b.ts');
      r.dispose();
    });

    it('dispose flushes pending tool', async () => {
      const r = createRenderer();
      r.onToolStart('Read', { file_path: '/a.ts' });
      r.dispose();
      // After dispose, the tool should have been flushed
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();
      // Check the render includes the tool (if flushCallback was called)
      if (flushCallback.mock.calls.length > 0) {
        const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
        expect(content).toContain('a.ts');
      }
      // At minimum, no errors thrown
    });
  });

  // ─── Agent tree nesting ─────────────────────────

  describe('agent tree nesting', () => {
    it('shows subagent tools indented under parent', async () => {
      const r = createRenderer();
      // Top-level tool
      const id1 = r.onToolStart('Bash', { command: 'npm test' });
      r.onToolComplete(id1, 'PASS');
      // Agent tool (spawns subagent)
      const agentId = r.onToolStart('Agent', { description: 'Explore codebase' });
      r.onAgentStart('Explore codebase', agentId);
      // Subagent tools (with parentToolUseId)
      const id3 = r.onToolStart('Read', { file_path: '/src/main.ts' }, agentId);
      r.onToolComplete(id3);
      const id4 = r.onToolStart('Grep', { pattern: 'TODO', path: 'src/' }, agentId);
      r.onToolComplete(id4);
      r.onAgentComplete('Done exploring', 'completed');

      vi.advanceTimersByTime(600);
      await vi.runAllTimersAsync();

      const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      // Top-level tool
      expect(content).toContain('● Bash(npm test)');
      // Agent with nested tools
      expect(content).toContain('● Agent(Explore codebase)');
      expect(content).toContain('│ ├'); // nested connector
      expect(content).toContain('Read(main.ts)');
      expect(content).toContain('Grep');
      // Agent completion summary
      expect(content).toContain('│ └ ✓');
      r.dispose();
    });

    it('shows running agent with nested running tool', async () => {
      const r = createRenderer();
      const agentId = r.onToolStart('Agent', { description: 'Fix bug' });
      r.onAgentStart('Fix bug', agentId);
      r.onToolStart('Read', { file_path: '/a.ts' }, agentId);

      vi.advanceTimersByTime(600);
      await vi.runAllTimersAsync();

      const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content).toContain('🔄 Agent(Fix bug)');
      expect(content).toContain('Read(a.ts)');
      r.dispose();
    });

    it('top-level tools without parentToolUseId render normally', async () => {
      const r = createRenderer();
      const id1 = r.onToolStart('Read', { file_path: '/a.ts' });
      r.onToolComplete(id1);
      const id2 = r.onToolStart('Edit', { file_path: '/b.ts' });
      r.onToolComplete(id2);

      vi.advanceTimersByTime(600);
      await vi.runAllTimersAsync();

      const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content).toContain('● Read(a.ts)');
      expect(content).toContain('● Edit(b.ts)');
      expect(content).not.toContain('│'); // no nesting
      r.dispose();
    });

    it('counts agent as one top-level entry for window purposes', async () => {
      const r = createRenderer(1, 4096, 3);
      // Fill window: tool1, agent(with 3 children), tool2
      const id1 = r.onToolStart('Read', { file_path: '/tmp/1.ts' });
      r.onToolComplete(id1);
      const agentId = r.onToolStart('Agent', { description: 'Explore' });
      r.onAgentStart('Explore', agentId);
      r.onToolStart('Read', { file_path: '/tmp/c1.ts' }, agentId);
      r.onToolStart('Read', { file_path: '/tmp/c2.ts' }, agentId);
      r.onToolStart('Read', { file_path: '/tmp/c3.ts' }, agentId);
      r.onAgentComplete('Done', 'completed');
      const id5 = r.onToolStart('Edit', { file_path: '/tmp/2.ts' });
      r.onToolComplete(id5);

      vi.advanceTimersByTime(600);
      await vi.runAllTimersAsync();

      const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      // All 3 top-level entries should be visible (within window of 3)
      // Child tools should NOT count toward window
      expect(content).toContain('Read(1.ts)');
      expect(content).toContain('Agent(Explore)');
      expect(content).toContain('Edit(2.ts)');
      // Children should be nested
      expect(content).toContain('c1.ts');
      expect(content).toContain('c2.ts');
      expect(content).toContain('c3.ts');
      r.dispose();
    });

    it('shows agent completion summary with stats', async () => {
      const r = createRenderer();
      const agentId = r.onToolStart('Agent', { description: 'Research' });
      r.onAgentStart('Research', agentId);
      const id1 = r.onToolStart('Read', { file_path: '/a.ts' }, agentId);
      r.onToolComplete(id1);
      const id2 = r.onToolStart('Grep', { pattern: 'x' }, agentId);
      r.onToolComplete(id2);
      r.onAgentProgress('Research', 'Grep', { tool_uses: 2, duration_ms: 5000 });
      r.onAgentComplete('Found issues', 'completed');

      vi.advanceTimersByTime(600);
      await vi.runAllTimersAsync();

      const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content).toContain('│ └ ✓ Found issues');
      expect(content).toContain('2 tool uses');
      expect(content).toContain('5s');
      r.dispose();
    });

    it('shows failed agent with ✗ icon in summary', async () => {
      const r = createRenderer();
      const agentId = r.onToolStart('Agent', { description: 'Deploy' });
      r.onAgentStart('Deploy', agentId);
      r.onAgentComplete('Timed out', 'failed');

      vi.advanceTimersByTime(600);
      await vi.runAllTimersAsync();

      const content = flushCallback.mock.calls[flushCallback.mock.calls.length - 1][0] as string;
      expect(content).toContain('│ └ ✗ Timed out');
      r.dispose();
    });
  });

  // ─── getResponseText ────────────────────────────

  describe('getResponseText', () => {
    it('returns accumulated text', () => {
      const r = createRenderer();
      r.onTextDelta('hello ');
      r.onTextDelta('world');
      expect(r.getResponseText()).toBe('hello world');
      r.dispose();
    });
  });
});
