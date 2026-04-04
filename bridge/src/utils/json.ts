/** Safely parse JSON with fallback */
export function safeParseJson<T>(input: string | unknown, fallback: T): T {
  if (typeof input === 'string') {
    try {
      return JSON.parse(input) as T;
    } catch {
      return fallback;
    }
  }
  // Already parsed or unknown type
  if (input && typeof input === 'object') {
    return input as T;
  }
  return fallback;
}

/** Safely parse JSON, returning empty object on failure */
export function safeParseObject<T extends Record<string, unknown>>(input: string | unknown): T {
  return safeParseJson<T>(input, {} as T);
}