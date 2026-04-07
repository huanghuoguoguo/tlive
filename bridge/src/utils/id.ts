/** Generate a unique session ID */
export function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Generate a unique permission ID */
export function generatePermissionId(): string {
  return `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Generate a unique hook ID */
export function generateHookId(): string {
  return `hook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Generate a unique ID with custom prefix (general utility) */
export function generateId(prefix: string, randomLen = 6): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 2 + randomLen)}`;
}