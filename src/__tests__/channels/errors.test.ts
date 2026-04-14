// bridge/src/__tests__/channels/errors.test.ts
import { describe, it, expect } from 'vitest';
import {
  BridgeError, RateLimitError, FormatError,
  NetworkError, AuthError, PlatformError,
} from '../../channels/errors.js';

describe('BridgeError hierarchy', () => {
  it('RateLimitError has retryAfterMs', () => {
    const err = new RateLimitError('slow down', 5000);
    expect(err).toBeInstanceOf(BridgeError);
    expect(err.retryAfterMs).toBe(5000);
    expect(err.retryable).toBe(true);
  });

  it('FormatError is not retryable', () => {
    const err = new FormatError('bad html');
    expect(err).toBeInstanceOf(BridgeError);
    expect(err.retryable).toBe(false);
  });

  it('NetworkError is retryable', () => {
    const err = new NetworkError('ETIMEOUT');
    expect(err.retryable).toBe(true);
  });

  it('AuthError is not retryable', () => {
    const err = new AuthError('invalid token');
    expect(err.retryable).toBe(false);
  });

  it('PlatformError carries status code', () => {
    const err = new PlatformError('server error', 500);
    expect(err.statusCode).toBe(500);
    expect(err.retryable).toBe(true);
  });

  it('PlatformError with 4xx is not retryable', () => {
    const err = new PlatformError('bad request', 400);
    expect(err.retryable).toBe(false);
  });
});