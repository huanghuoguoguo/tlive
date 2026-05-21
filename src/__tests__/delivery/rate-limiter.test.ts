import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatRateLimiter } from '../../delivery/rate-limiter.js';

describe('ChatRateLimiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows messages under limit', () => {
    const limiter = new ChatRateLimiter(5, 60000); // 5/min
    for (let i = 0; i < 5; i++) {
      expect(limiter.tryConsume('chat1')).toBe(true);
    }
  });

  it('blocks messages over limit', () => {
    const limiter = new ChatRateLimiter(2, 60000);
    expect(limiter.tryConsume('chat1')).toBe(true);
    expect(limiter.tryConsume('chat1')).toBe(true);
    expect(limiter.tryConsume('chat1')).toBe(false);
  });

  it('tracks per chat independently', () => {
    const limiter = new ChatRateLimiter(1, 60000);
    expect(limiter.tryConsume('chat1')).toBe(true);
    expect(limiter.tryConsume('chat2')).toBe(true);
    expect(limiter.tryConsume('chat1')).toBe(false);
  });

  it('resets after window expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const limiter = new ChatRateLimiter(1, 50); // 50ms window
    expect(limiter.tryConsume('chat1')).toBe(true);
    expect(limiter.tryConsume('chat1')).toBe(false);
    vi.advanceTimersByTime(50);
    expect(limiter.tryConsume('chat1')).toBe(true);
  });
});
