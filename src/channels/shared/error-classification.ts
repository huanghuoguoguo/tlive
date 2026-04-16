import { RateLimitError, FormatError, AuthError, PlatformError, NetworkError, type BridgeError } from '../errors.js';

/**
 * Classify an HTTP status code into the appropriate BridgeError type.
 * Returns null if the status doesn't map to a known error category.
 */
export function classifyHttpStatus(status: number, message: string, retryAfterMs = 0): BridgeError | null {
  if (status === 429) return new RateLimitError(message, retryAfterMs);
  if (status === 401 || status === 403) return new AuthError(message);
  if (status === 400) return new FormatError(message);
  if (status >= 500) return new PlatformError(message, status);
  return null;
}

/**
 * Check if an error object represents a common network error.
 * Returns a NetworkError if matched, null otherwise.
 */
export function checkNetworkError(err: Record<string, unknown>): NetworkError | null {
  const code = err?.code as string;
  if (code === 'ETIMEOUT' || code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
    return new NetworkError((err?.message as string) ?? String(err));
  }
  return null;
}

/**
 * Extract retry-after value from error response.
 * Handles both direct `retry_after` field and nested `parameters.retry_after`.
 * Returns value in milliseconds.
 */
export function extractRetryAfter(err: Record<string, unknown>): number {
  // Telegram: parameters.retry_after (in seconds)
  const paramsRetry = (err?.parameters as Record<string, unknown>)?.retry_after;
  if (typeof paramsRetry === 'number') return paramsRetry * 1000;

  // Nested in response body
  const bodyParams = (err?.response as Record<string, unknown>)?.body as Record<string, unknown>;
  const bodyRetry = (bodyParams?.parameters as Record<string, unknown>)?.retry_after;
  if (typeof bodyRetry === 'number') return bodyRetry * 1000;

  // QQ Bot: no retry_after, default 60s
  return 60000;
}