import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageRenderer } from '../../engine/messages/renderer.js';
import {
  AdaptiveFlushController,
  type AdaptiveFlushOptions,
} from '../../engine/messages/adaptive-flush.js';

describe('MessageRenderer', () => {
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

  function createRenderer(
    platformLimit = 4096,
    throttleMs = 300,
    cwd?: string,
    model?: string,
    verboseLevel: 0 | 1 = 1,
    shouldSplitState?: (state: any) => boolean,
    adaptiveFlush?: boolean | AdaptiveFlushOptions,
  ) {
    return new MessageRenderer({
      shouldSplitState,
      platformLimit,
      throttleMs,
      cwd,
      model,
      verboseLevel,
      adaptiveFlush,
      flushCallback: flushCallback as any,
    });
  }

  async function advance(ms: number) {
    vi.advanceTimersByTime(ms);
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  }

  const defaultButtons = [
    { label: 'Allow', callbackData: 'perm:allow:abc', style: 'primary' as const },
    { label: 'Deny', callbackData: 'perm:deny:abc', style: 'danger' as const },
  ];

  it('honors retry-after backoff outside the normal flush interval cap', () => {
    const controller = new AdaptiveFlushController({ minMs: 800, maxMs: 4000 });
    controller.recordRateLimit(60_000, 1000);

    expect(controller.nextDelay({
      fallbackMs: 300,
      content: 'running',
      phase: 'executing',
      hasMessage: true,
    }, 1000)).toBe(60_000);
  });

  it('renders executing progress with accumulated visible tools and quiet-mode suppression', async () => {
    const r = createRenderer();
    r.onToolStart('Bash');
    r.onToolStart('Read');
    r.onToolStart('Bash');
    await advance(1300);

    const content = flushCallback.mock.calls.at(-1)?.[0] as string;
    expect(content).toContain('⏳');
    expect(content).toContain('🖥️ Bash ×2');
    expect(content).toContain('📖 Read ×1');
    expect(content).toContain('3 tools');
    r.dispose();

    flushCallback.mockClear();
    const quiet = createRenderer(4096, 300, undefined, undefined, 0);
    quiet.onToolStart('Bash');
    quiet.onTextDelta('working');
    await advance(1300);

    expect(flushCallback).not.toHaveBeenCalled();
    quiet.dispose();
  });

  it('uses adaptive timing after the first progress card', async () => {
    const r = createRenderer(4096, 300, undefined, undefined, 1, undefined, {
      baseMs: 800,
      minMs: 800,
      maxMs: 4000,
    });

    r.onTextDelta('hello');
    await advance(0);
    expect(flushCallback).toHaveBeenCalledTimes(1);

    r.onTextDelta(' world');
    await advance(300);
    expect(flushCallback).toHaveBeenCalledTimes(1);

    await advance(500);
    expect(flushCallback).toHaveBeenCalledTimes(2);
    r.dispose();
  });

  it('morphs into permission state, passes controls, and restores executing state', async () => {
    const r = createRenderer();
    const longInput = 'npm test -- '.concat('schema.test.ts '.repeat(20));

    r.onToolStart('Bash');
    r.onToolStart('Read');
    r.onPermissionNeeded('Bash', longInput, 'perm-1', defaultButtons);
    await advance(0);

    let lastCall = flushCallback.mock.calls.at(-1)!;
    expect(lastCall[0]).toContain('🔐');
    expect(lastCall[0]).toContain(longInput);
    expect(lastCall[2]).toEqual(defaultButtons);

    r.onPermissionResolved();
    await advance(1300);

    lastCall = flushCallback.mock.calls.at(-1)!;
    expect(lastCall[0]).toContain('⏳');
    expect(lastCall[0]).toContain('Bash ×1');
    expect(lastCall[0]).toContain('Read ×1');
    expect(lastCall[0]).not.toContain('🔐');
    expect(lastCall[2]).toBeUndefined();
    r.dispose();
  });

  it('emits permission timeout only while the permission is still pending', async () => {
    let timeoutData: { toolName: string; input: string } | null = null;
    const r = new MessageRenderer({
      platformLimit: 4096,
      throttleMs: 300,
      flushCallback: flushCallback as any,
      onPermissionTimeout: (toolName, input) => {
        timeoutData = { toolName, input };
      },
    });

    r.onPermissionNeeded('Bash', 'npm test', '123', defaultButtons);
    await advance(59_000);
    expect(timeoutData).toBeNull();

    await advance(1_000);
    expect(timeoutData).toEqual({ toolName: 'Bash', input: 'npm test' });
    r.dispose();

    timeoutData = null;
    const resolved = new MessageRenderer({
      platformLimit: 4096,
      throttleMs: 300,
      flushCallback: flushCallback as any,
      onPermissionTimeout: (toolName, input) => {
        timeoutData = { toolName, input };
      },
    });
    resolved.onPermissionNeeded('Bash', 'npm test', '456', defaultButtons);
    await advance(30_000);
    resolved.onPermissionResolved();
    await advance(60_000);

    expect(timeoutData).toBeNull();
    resolved.dispose();
  });

  it('formats completion with answer, tool summary, hidden-tool filtering, runtime info, and usage', async () => {
    const r = createRenderer(4096, 300, '/home/user/workspace');
    r.setRuntimeInfo({
      provider: 'codex',
      displayName: 'Codex',
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
    });
    r.setUsageSummary('📊 10/4 tok | 2s');
    r.onToolStart('Bash');
    r.onToolStart('TodoWrite');
    r.onToolStart('Read');
    r.onTextDelta('Here is the result.');

    await r.onComplete();
    await advance(0);

    const content = flushCallback.mock.calls.at(-1)?.[0] as string;
    expect(content).toContain('Here is the result.');
    expect(content).toContain('───────────────');
    expect(content).toContain('🖥️ Bash ×1');
    expect(content).toContain('📖 Read ×1');
    expect(content).toContain('2 total');
    expect(content).not.toContain('TodoWrite');
    expect(content).toContain('[gpt-5.5] │ 思考 xhigh │ /home/user/workspace');
    expect(content).toContain('📊 10/4 tok | 2s');
    r.dispose();
  });

  it('renders error states as either simple failures or stopped runs with partial output', async () => {
    const simple = createRenderer();
    simple.onError('connection refused');
    await advance(0);
    expect(flushCallback.mock.calls.at(-1)?.[0]).toBe('❌ connection refused');
    simple.dispose();

    flushCallback.mockClear();
    const partial = createRenderer();
    partial.onToolStart('Bash');
    partial.onTextDelta('Partial response...');
    partial.onError('stream interrupted');
    await advance(0);

    const content = flushCallback.mock.calls.at(-1)?.[0] as string;
    expect(content).toContain('Partial response...');
    expect(content).toContain('⚠️ Stopped');
    expect(content).toContain('───────────────');
    partial.dispose();
  });

  it('sends the first progress bubble as a new message and later progress as edits', async () => {
    const r = createRenderer();
    r.onToolStart('Bash');
    await advance(300);

    expect(flushCallback).toHaveBeenCalledWith(
      expect.any(String),
      false,
      undefined,
      expect.objectContaining({ phase: 'executing', totalTools: 1 }),
    );
    expect(r.messageId).toBe('msg-1');

    r.onToolStart('Read');
    await advance(300);

    expect(flushCallback.mock.calls.at(-1)?.[1]).toBe(true);
    r.dispose();
  });

  it('coalesces concurrent flushes instead of racing duplicate sends', async () => {
    let resolveFirst: () => void;
    const slowCallback = vi.fn().mockImplementation((_content: string, isEdit: boolean) => {
      if (!isEdit) {
        return new Promise<string>((resolve) => {
          resolveFirst = () => resolve('msg-1');
        });
      }
      return Promise.resolve();
    });
    const r = new MessageRenderer({
      platformLimit: 4096,
      throttleMs: 300,
      flushCallback: slowCallback as any,
    });

    r.onToolStart('Bash');
    await advance(1300);
    expect(slowCallback).toHaveBeenCalledTimes(1);

    r.onToolStart('Read');
    await advance(300);
    expect(slowCallback).toHaveBeenCalledTimes(1);

    resolveFirst!();
    await advance(0);

    expect(slowCallback).toHaveBeenCalledTimes(2);
    expect(r.messageId).toBe('msg-1');
    r.dispose();
  });

  it('truncates executing progress but leaves completed content intact for outer chunking', async () => {
    const executing = createRenderer(200);
    for (let i = 0; i < 20; i++) {
      executing.onToolStart(`LongToolName${i}`);
    }
    await advance(300);

    const executingContent = flushCallback.mock.calls.at(-1)?.[0] as string;
    expect(executingContent.length).toBeLessThanOrEqual(200);
    expect(executingContent.startsWith('...\n')).toBe(true);
    executing.dispose();

    flushCallback.mockClear();
    const done = createRenderer(200);
    done.onToolStart('Bash');
    done.onTextDelta('x'.repeat(500));
    done.onComplete();
    await advance(0);

    const doneContent = flushCallback.mock.calls.at(-1)?.[0] as string;
    expect(doneContent.length).toBeGreaterThan(200);
    expect(doneContent).toContain('x'.repeat(500));
    done.dispose();
  });

  it('splits long-running progress into new bubbles but keeps completion in the current bubble', async () => {
    const messageIds: string[] = [];
    flushCallback.mockImplementation((_content: string, isEdit: boolean) => {
      if (!isEdit) {
        const id = `msg-${messageIds.length + 1}`;
        messageIds.push(id);
        return Promise.resolve(id);
      }
      return Promise.resolve();
    });

    const r = createRenderer(4096, 300);
    r.onToolStart('Bash');
    await advance(300);

    for (let i = 0; i < 11; i++) {
      r.onToolStart('Read');
      await advance(300);
    }

    expect(messageIds).toEqual(['msg-1', 'msg-2']);
    expect(flushCallback.mock.calls.at(-1)?.[0]).toContain('继续执行');

    r.onTextDelta('Final answer');
    r.onComplete();
    await advance(0);

    const content = flushCallback.mock.calls.at(-1)?.[0] as string;
    expect(messageIds).toEqual(['msg-1', 'msg-2']);
    expect(content).toContain('Final answer');
    expect(content).not.toContain('继续执行');
    r.dispose();
  });

  it('can split by content budget rather than only by tool count', async () => {
    const messageIds: string[] = [];
    flushCallback.mockImplementation((_content: string, isEdit: boolean) => {
      if (!isEdit) {
        const id = `msg-${messageIds.length + 1}`;
        messageIds.push(id);
        return Promise.resolve(id);
      }
      return Promise.resolve();
    });
    const largeThought = '正在整理当前上下文并继续执行。'.repeat(500);
    const r = createRenderer(
      30_000,
      300,
      undefined,
      undefined,
      1,
      (state) => state.thinkingText.length >= largeThought.length * 2,
    );

    r.onToolStart('Bash', { command: 'pwd' });
    await advance(300);

    for (let i = 0; i < 20; i++) {
      r.onToolStart('Read', { file_path: `src/file-${i}.ts` });
      await advance(300);
    }
    expect(messageIds).toEqual(['msg-1']);

    for (let i = 0; i < 3; i++) {
      r.onThinkingDelta(largeThought);
      await advance(300);
    }

    expect(messageIds.length).toBeGreaterThan(1);
    r.dispose();
  });

  it('stops timer-driven flushes after disposal or completion', async () => {
    const disposed = createRenderer();
    disposed.onToolStart('Bash');
    disposed.dispose();
    await advance(5000);
    expect(flushCallback).not.toHaveBeenCalled();

    const complete = createRenderer();
    complete.onToolStart('Bash');
    await advance(2000);

    const callsBefore = flushCallback.mock.calls.length;
    complete.onComplete();
    await advance(0);
    const callsAfterComplete = flushCallback.mock.calls.length;
    expect(callsAfterComplete).toBeGreaterThan(callsBefore);

    await advance(5000);
    expect(flushCallback.mock.calls.length).toBe(callsAfterComplete);
    complete.dispose();
  });
});
