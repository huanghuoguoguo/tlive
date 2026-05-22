import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CostTracker } from '../../engine/cost-tracker.js';

describe('CostTracker', () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = new CostTracker();
  });

  afterEach(() => {
    delete process.env.TL_COST_INPUT_PER_M;
    delete process.env.TL_COST_OUTPUT_PER_M;
  });

  it('tracks duration', () => {
    vi.useFakeTimers();
    tracker.start();
    vi.advanceTimersByTime(5000);
    const stats = tracker.finish({ input_tokens: 100, output_tokens: 50 });
    expect(stats.durationMs).toBe(5000);
    vi.useRealTimers();
  });

  it('uses cost_usd from SDK when available', () => {
    tracker.start();
    const stats = tracker.finish({ input_tokens: 1000, output_tokens: 500, cost_usd: 0.12 });
    expect(stats.costUsd).toBe(0.12);
  });

  it('does not invent a dollar cost when cost_usd and configured rates are absent', () => {
    tracker.start();
    const stats = tracker.finish({ input_tokens: 1000, output_tokens: 500 });
    expect(stats.costUsd).toBe(0);
    expect(stats.costEstimated).toBe(false);
    expect(stats.inputTokens).toBe(1000);
    expect(stats.outputTokens).toBe(500);
  });

  it('can estimate cost when explicit local rates are configured', () => {
    process.env.TL_COST_INPUT_PER_M = '3';
    process.env.TL_COST_OUTPUT_PER_M = '15';
    tracker.start();
    const stats = tracker.finish({ input_tokens: 1000, output_tokens: 500 });
    expect(stats.costUsd).toBeGreaterThan(0);
    expect(stats.costEstimated).toBe(true);
  });

  it('formats stats as human-readable string', () => {
    vi.useFakeTimers();
    tracker.start();
    vi.advanceTimersByTime(154000); // 2m 34s
    const stats = tracker.finish({ input_tokens: 12345, output_tokens: 8100, cost_usd: 0.08 });
    const formatted = CostTracker.format(stats);
    expect(formatted).toBe('输入 12.3k / 输出 8.1k | $0.08 | 2m 34s');
    vi.useRealTimers();
  });

  it('formats sub-1k tokens without k suffix', () => {
    tracker.start();
    const stats = tracker.finish({ input_tokens: 800, output_tokens: 200, cost_usd: 0.01 });
    const formatted = CostTracker.format(stats);
    expect(formatted).toContain('输入 800 / 输出 200');
  });

  it('formats cost with 2 decimal places', () => {
    tracker.start();
    const stats = tracker.finish({ input_tokens: 100, output_tokens: 50, cost_usd: 1.5 });
    const formatted = CostTracker.format(stats);
    expect(formatted).toContain('$1.50');
  });

  it('formats duration under 1 minute as seconds', () => {
    vi.useFakeTimers();
    tracker.start();
    vi.advanceTimersByTime(45000); // 45s
    const stats = tracker.finish({ input_tokens: 100, output_tokens: 50, cost_usd: 0.01 });
    const formatted = CostTracker.format(stats);
    expect(formatted).toContain('45s');
    expect(formatted).not.toContain('m');
    vi.useRealTimers();
  });

  it('formats cached input and reasoning output separately', () => {
    tracker.start();
    const stats = tracker.finish({
      input_tokens: 403800,
      cached_input_tokens: 400000,
      output_tokens: 2700,
      reasoning_output_tokens: 900,
    });
    const formatted = CostTracker.format(stats);
    expect(formatted).toContain('输入 3.8k / 输出 2.7k / 推理 900 / 缓存 400.0k');
    expect(formatted).not.toContain('403.8k');
    expect(formatted).not.toContain('$');
  });
});
