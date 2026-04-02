export interface PermissionResult {
  behavior: 'allow' | 'allow_always' | 'deny';
  message?: string;
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
        console.log(`[gateway] TIMEOUT: ${toolUseId} (was pending: ${this.pending.has(toolUseId)})`);
        this.pending.delete(toolUseId);
        options?.onTimeout?.(toolUseId);
        resolve({ behavior: 'deny', message: 'Permission request timed out' });
      }, timeoutMs);
      this.pending.set(toolUseId, { resolve, timer });
      console.log(`[gateway] CREATED: ${toolUseId} (total pending: ${this.pending.size})`);
    });
  }

  resolve(permissionRequestId: string, decision: 'allow' | 'allow_always' | 'deny', message?: string): boolean {
    const entry = this.pending.get(permissionRequestId);
    console.log(`[gateway] RESOLVE: ${permissionRequestId} → ${decision} (found: ${!!entry}, total pending: ${this.pending.size})`);
    if (!entry) return false;
    clearTimeout(entry.timer);
    const result: PermissionResult = decision === 'deny'
      ? { behavior: 'deny', message: message || 'Denied by user' }
      : { behavior: decision };
    entry.resolve(result);
    this.pending.delete(permissionRequestId);
    return true;
  }

  denyAll(): void {
    console.log(`[gateway] DENY_ALL: ${this.pending.size} entries`);
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ behavior: 'deny', message: 'Bridge shutting down' });
    }
    this.pending.clear();
  }

  isPending(id: string): boolean {
    return this.pending.has(id);
  }

  pendingCount(): number {
    return this.pending.size;
  }
}
