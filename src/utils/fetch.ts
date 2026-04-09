/** Authorized fetch helper with timeout and Bearer token */
export interface AuthFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  timeout?: number;
}

export async function authFetch<T>(
  baseUrl: string,
  path: string,
  token: string,
  options?: AuthFetchOptions
): Promise<T> {
  const timeout = options?.timeout ?? 5000;
  const method = options?.method ?? 'GET';

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
    signal: AbortSignal.timeout(timeout),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  return res.json() as T;
}

/** POST with JSON body */
export async function authPost<T>(
  baseUrl: string,
  path: string,
  token: string,
  body: unknown,
  timeout?: number
): Promise<T> {
  return authFetch<T>(baseUrl, path, token, { method: 'POST', body, timeout });
}

/** GET with auth */
export async function authGet<T>(
  baseUrl: string,
  path: string,
  token: string,
  timeout?: number
): Promise<T> {
  return authFetch<T>(baseUrl, path, token, { timeout });
}