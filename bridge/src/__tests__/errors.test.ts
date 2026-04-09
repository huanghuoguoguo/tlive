// bridge/src/__tests__/errors.test.ts
import { describe, it, expect } from 'vitest';
import {
  BridgeError, RateLimitError, FormatError,
  NetworkError, AuthError, PlatformError,
  classifyError,
} from '../channels/errors.js';

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

describe('classifyError', () => {
  it('classifies Telegram 429 as RateLimitError', () => {
    const err = { response: { statusCode: 429 }, message: 'Too Many Requests' };
    expect(classifyError('telegram', err)).toBeInstanceOf(RateLimitError);
  });

  it('classifies Telegram 400 as FormatError', () => {
    const err = { response: { statusCode: 400 }, message: "can't parse entities" };
    expect(classifyError('telegram', err)).toBeInstanceOf(FormatError);
  });

  it('classifies ETIMEOUT as NetworkError', () => {
    const err = { code: 'ETIMEOUT' };
    expect(classifyError('telegram', err)).toBeInstanceOf(NetworkError);
  });

  it('classifies Feishu rate limit error', () => {
    const err = { code: 99991400, message: 'Rate limited' };
    expect(classifyError('feishu', err)).toBeInstanceOf(RateLimitError);
  });

  it('classifies QQ Bot 429 as RateLimitError', () => {
    const err = { response: { statusCode: 429 }, message: 'Too Many Requests' };
    expect(classifyError('qqbot', err)).toBeInstanceOf(RateLimitError);
  });

  it('wraps unknown errors as PlatformError', () => {
    const err = new Error('unknown');
    expect(classifyError('telegram', err)).toBeInstanceOf(PlatformError);
  });
});