import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamController } from '../engine/stream-controller.js';
import type { UsageStats } from '../engine/cost-tracker.js';

describe('StreamController', () => {
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

  function createController(verboseLevel: 0 | 1 | 2 = 1, platformLimit = 4096) {
    return new StreamController({ verboseLevel, platformLimit, throttleMs: 300, flushCallback: flushCallback as any });
  }

  it('accumulates text and flushes after throttle', async () => {
    const ctrl = createController();
    ctrl.onTextDelta('Hello ');
    ctrl.onTextDelta('world');
    expect(flushCallback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    await vi.runAllTimersAsync();
    expect(flushCallback).toHaveBeenCalledWith('Hello world', false);
    ctrl.dispose();
  });

  it('first flush returns messageId, subsequent flushes are edits', async () => {
    const ctrl = createController();
    ctrl.onTextDelta('first');
    vi.advanceTimersByTime(300);
    await vi.runAllTimersAsync();
    expect(flushCallback).toHaveBeenCalledWith('first', false);
    expect(ctrl.messageId).toBe('msg-1');

    ctrl.onTextDelta(' second');
    vi.advanceTimersByTime(300);
    await vi.runAllTimersAsync();
    expect(flushCallback).toHaveBeenCalledWith('first second', true);
    ctrl.dispose();
  });

  it('uses fallback emoji for unknown tools', async () => {
    const ctrl = createController(1);
    ctrl.onToolStart('UnknownTool');
    ctrl.onTextDelta('text');
    vi.advanceTimersByTime(300);
    await vi.runAllTimersAsync();
    const content = flushCallback.mock.calls[0][0];
    expect(content).toContain('🔧 UnknownTool');
    ctrl.dispose();
  });

  it('level 1: shows tool headers without input summary', async () => {
    const ctrl = createController(1);
    ctrl.onToolStart('Grep', { pattern: 'foo', path: 'src/' });
    ctrl.onToolStart('Edit', { file_path: '/tmp/bar.ts' });
    ctrl.onTextDelta('Fixed it.');
    vi.advanceTimersByTime(300);
    await vi.runAllTimersAsync();
    const content = flushCallback.mock.calls[0][0];
    expect(content).toContain('🔍 Grep');
    expect(content).toContain('✏️ Edit');
    expect(content).not.toContain('foo');
    expect(content).not.toContain('bar.ts');
    expect(content).toContain('Fixed it.');
    ctrl.dispose();
  });

  it('level 2: shows tool headers with input summary', async () => {
    const ctrl = createController(2);
    ctrl.onToolStart('Grep', { pattern: 'foo', path: 'src/' });
    ctrl.onToolStart('Bash', { command: 'npm test' });
    ctrl.onTextDelta('Done.');
    vi.advanceTimersByTime(300);
    await vi.runAllTimersAsync();
    const content = flushCallback.mock.calls[0][0];
    expect(content).toContain('🔍 Grep "foo" in src/');
    expect(content).toContain('🖥️ Bash npm test');
    ctrl.dispose();
  });

  it('level 0: does not flush text deltas', async () => {
    const ctrl = createController(0);
    ctrl.onTextDelta('some text');
    vi.advanceTimersByTime(300);
    await vi.runAllTimersAsync();
    expect(flushCallback).not.toHaveBeenCalled();
    ctrl.dispose();
  });

  it('onComplete flushes final message with cost line at all levels', async () => {
    const ctrl = createController(0);
    ctrl.onToolStart('Grep', { pattern: 'test' });  // should be suppressed at level 0
    ctrl.onTextDelta('some text');                    // should be suppressed at level 0
    const stats: UsageStats = { inputTokens: 1000, outputTokens: 500, costUsd: 0.05, durationMs: 10000 };
    ctrl.onComplete(stats);
    await vi.runAllTimersAsync();
    const content = flushCallback.mock.calls[0][0];
    expect(content).toContain('📊');
    expect(content).not.toContain('Grep');
    expect(content).not.toContain('some text');
    expect(content).not.toContain('──────');
    ctrl.dispose();
  });

  it('truncates content exceeding platform limit during streaming', async () => {
    const ctrl = createController(1, 500);
    ctrl.onTextDelta('x'.repeat(1000));
    vi.advanceTimersByTime(300);
    await vi.runAllTimersAsync();
    const content = flushCallback.mock.calls[0][0] as string;
    expect(content.length).toBeLessThanOrEqual(500);
    expect(content.startsWith('...\n')).toBe(true);
    expect(content).toContain('x'.repeat(10));
    ctrl.dispose();
  });

  it('level 2 falls back to level 1 format when tool input is empty', async () => {
    const ctrl = createController(2);
    ctrl.onToolStart('Read', {});
    ctrl.onTextDelta('text');
    vi.advanceTimersByTime(300);
    await vi.runAllTimersAsync();
    const content = flushCallback.mock.calls[0][0];
    expect(content).toContain('📖 Read');
    ctrl.dispose();
  });

  it('onError flushes error message', async () => {
    const ctrl = createController(1);
    ctrl.onError('something went wrong');
    await vi.runAllTimersAsync();
    const content = flushCallback.mock.calls[0][0];
    expect(content).toContain('❌ Error: something went wrong');
    ctrl.dispose();
  });

  it('dispose clears pending timers', () => {
    const ctrl = createController();
    ctrl.onTextDelta('hello');
    ctrl.dispose();
    vi.advanceTimersByTime(1000);
    expect(flushCallback).not.toHaveBeenCalled();
  });
});
