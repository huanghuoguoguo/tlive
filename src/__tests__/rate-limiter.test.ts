import { describe, it, expect } from 'vitest';
import { ChatRateLimiter } from '../delivery/rate-limiter.js';

describe('ChatRateLimiter', () => {
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

  it('resets after window expires', async () => {
    const limiter = new ChatRateLimiter(1, 50); // 50ms window
    expect(limiter.tryConsume('chat1')).toBe(true);
    expect(limiter.tryConsume('chat1')).toBe(false);
    await new Promise(r => setTimeout(r, 60));
    expect(limiter.tryConsume('chat1')).toBe(true);
  });
});
