// bridge/src/__tests__/channels/errors.test.ts
import { describe, it, expect } from 'vitest';
import {
  BridgeError, RateLimitError, PlatformError,
} from '../../server/channels/errors.js';

describe('BridgeError hierarchy', () => {
  it('RateLimitError has retryAfterMs', () => {
    const err = new RateLimitError('slow down', 5000);
    expect(err).toBeInstanceOf(BridgeError);
    expect(err.retryAfterMs).toBe(5000);
    expect(err.retryable).toBe(true);
  });

  it('PlatformError retries server errors but not client errors', () => {
    expect(new PlatformError('server error', 500)).toMatchObject({
      statusCode: 500,
      retryable: true,
    });
    expect(new PlatformError('bad request', 400)).toMatchObject({
      statusCode: 400,
      retryable: false,
    });
  });
});
