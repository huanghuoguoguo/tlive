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

/**
 * Default error classification for base adapter.
 * Subclasses override this for platform-specific error handling.
 */
export function classifyDefaultError(err: unknown): BridgeError {
  const e = err as Record<string, unknown>;
  const message = (e?.message as string) ?? String(err);

  if (e?.code === 'ETIMEOUT' || e?.code === 'ECONNREFUSED' || e?.code === 'ENOTFOUND') {
    return new NetworkError(message);
  }

  return new PlatformError(message, (e?.response as { statusCode?: number })?.statusCode ?? (e?.status as number));
}
