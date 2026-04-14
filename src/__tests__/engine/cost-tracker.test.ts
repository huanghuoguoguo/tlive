import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CostTracker } from '../../utils/cost-tracker.js';

describe('CostTracker', () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = new CostTracker();
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

  it('computes cost from tokens when cost_usd not provided', () => {
    tracker.start();
    const stats = tracker.finish({ input_tokens: 1000, output_tokens: 500 });
    expect(stats.costUsd).toBeGreaterThan(0);
    expect(stats.inputTokens).toBe(1000);
    expect(stats.outputTokens).toBe(500);
  });

  it('formats stats as human-readable string', () => {
    vi.useFakeTimers();
    tracker.start();
    vi.advanceTimersByTime(154000); // 2m 34s
    const stats = tracker.finish({ input_tokens: 12345, output_tokens: 8100, cost_usd: 0.08 });
    const formatted = CostTracker.format(stats);
    expect(formatted).toBe('📊 12.3k/8.1k tok | $0.08 | 2m 34s');
    vi.useRealTimers();
  });

  it('formats sub-1k tokens without k suffix', () => {
    tracker.start();
    const stats = tracker.finish({ input_tokens: 800, output_tokens: 200, cost_usd: 0.01 });
    const formatted = CostTracker.format(stats);
    expect(formatted).toContain('800/200 tok');
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
});
