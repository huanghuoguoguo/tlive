import type { ChannelType } from './types.js';

export class BridgeError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = this.constructor.name;
    this.retryable = retryable;
  }
}

export class RateLimitError extends BridgeError {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs = 0) {
    super(message, true);
    this.retryAfterMs = retryAfterMs;
  }
}

export class FormatError extends BridgeError {
  constructor(message: string) { super(message, false); }
}

export class NetworkError extends BridgeError {
  constructor(message: string) { super(message, true); }
}

export class AuthError extends BridgeError {
  constructor(message: string) { super(message, false); }
}

export class PlatformError extends BridgeError {
  readonly statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message, statusCode ? statusCode >= 500 : true);
    this.statusCode = statusCode;
  }
}

export function classifyError(channel: ChannelType | string, err: unknown): BridgeError {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- classifyError inspects arbitrary error shapes from multiple SDKs
  const e = err as Record<string, any>;
  const message = e?.message ?? String(err);

  if (e?.code === 'ETIMEOUT' || e?.code === 'ECONNREFUSED' || e?.code === 'ENOTFOUND') {
    return new NetworkError(message);
  }

  if (channel === 'telegram') {
    const status = e?.response?.statusCode;
    if (status === 429) return new RateLimitError(message, e?.response?.body?.parameters?.retry_after * 1000);
    if (status === 400) return new FormatError(message);
    if (status === 401 || status === 403) return new AuthError(message);
    if (status >= 500) return new PlatformError(message, status);
  }

  if (channel === 'discord') {
    if (e?.code === 50035) return new FormatError(message);
    if (e?.code === 50001 || e?.code === 50013) return new AuthError(message);
    if (e?.retry_after) return new RateLimitError(message, e.retry_after * 1000);
  }

  if (channel === 'feishu') {
    const code = e?.code;
    if (code === 99991400) return new RateLimitError(message);
    if (code === 99991401 || code === 99991403) return new AuthError(message);
  }

  return new PlatformError(message, e?.response?.statusCode ?? e?.status);
}
