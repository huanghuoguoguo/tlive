import { CALLBACK_PREFIXES } from '../core/callbacks.js';

export type PermissionDecision = 'allow' | 'allow_always' | 'deny';
export type PermissionGrantScope = 'same_command' | 'session_all';

export interface PermissionResult {
  behavior: PermissionDecision;
  grantScope?: PermissionGrantScope;
  message?: string;
}

export interface PermissionCallbackDecision {
  permissionId: string;
  decision: PermissionDecision;
  grantScope?: PermissionGrantScope;
}

const PERMISSION_CALLBACKS: Array<{
  prefix: string;
  decision: PermissionDecision;
  grantScope?: PermissionGrantScope;
}> = [
  { prefix: CALLBACK_PREFIXES.PERM_ALLOW_SAME, decision: 'allow', grantScope: 'same_command' },
  { prefix: CALLBACK_PREFIXES.PERM_ALLOW_ALL_SESSION, decision: 'allow', grantScope: 'session_all' },
  { prefix: CALLBACK_PREFIXES.PERM_ALLOW, decision: 'allow' },
  { prefix: CALLBACK_PREFIXES.PERM_DENY, decision: 'deny' },
];

export function parsePermissionCallback(callbackData: string): PermissionCallbackDecision | null {
  for (const candidate of PERMISSION_CALLBACKS) {
    if (!callbackData.startsWith(candidate.prefix)) continue;
    const permissionId = callbackData.slice(candidate.prefix.length);
    if (!permissionId || permissionId.includes(':askq:')) return null;
    return {
      permissionId,
      decision: candidate.decision,
      ...(candidate.grantScope ? { grantScope: candidate.grantScope } : {}),
    };
  }
  return null;
}

export interface WaitForOptions {
  onTimeout?: (toolUseId: string) => void;
  timeoutMs?: number;
}

export class PendingPermissions {
  private pending = new Map<string, {
    resolve: (r: PermissionResult) => void;
    timer: NodeJS.Timeout;
  }>();
  private timeoutMs = 5 * 60 * 1000; // 5 minutes

  waitFor(toolUseId: string, options?: WaitForOptions): Promise<PermissionResult> {
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    return new Promise<PermissionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(toolUseId);
        options?.onTimeout?.(toolUseId);
        resolve({ behavior: 'deny', message: 'Permission request timed out' });
      }, timeoutMs);
      this.pending.set(toolUseId, { resolve, timer });
    });
  }

  resolve(
    permissionRequestId: string,
    decision: PermissionDecision,
    message?: string,
    grantScope?: PermissionGrantScope,
  ): boolean {
    const entry = this.pending.get(permissionRequestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    const result: PermissionResult = decision === 'deny'
      ? { behavior: 'deny', message: message || 'Denied by user' }
      : { behavior: decision, ...(grantScope ? { grantScope } : {}) };
    entry.resolve(result);
    this.pending.delete(permissionRequestId);
    return true;
  }

  resolveCallback(callbackData: string): boolean {
    const parsed = parsePermissionCallback(callbackData);
    if (!parsed) return false;
    return this.resolve(parsed.permissionId, parsed.decision, undefined, parsed.grantScope);
  }

  denyAll(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ behavior: 'deny', message: 'Bridge shutting down' });
    }
    this.pending.clear();
  }

  isPending(id: string): boolean {
    return this.pending.has(id);
  }
}
