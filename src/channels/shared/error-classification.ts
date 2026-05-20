import { NetworkError } from '../errors.js';

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
