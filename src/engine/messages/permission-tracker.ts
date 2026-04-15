/**
 * Permission tracking — queue and timeout management.
 * Extracted from MessageRenderer for cleaner architecture.
 */

import type { Button } from '../../ui/types.js';

/** Timeout for permission wait without user response */
const PERMISSION_TIMEOUT_MS = 60_000;

interface PermissionEntry {
  toolName: string;
  input: string;
  permId: string;
  buttons: Button[];
}

export interface PermissionTrackerCallbacks {
  /** Called when permission waits >60s without response */
  onTimeout: (toolName: string, input: string, buttons: Button[]) => void;
  /** Called when permission is first requested — add reaction */
  onReaction: () => void;
  /** Called when all permissions resolved — remove reaction */
  onReactionClear: () => void;
}

export class PermissionTracker {
  private queue: PermissionEntry[] = [];
  private requests = 0;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private callbacks: PermissionTrackerCallbacks) {}

  /** Current queue length */
  getQueueLength(): number {
    return this.queue.length;
  }

  /** Total permission requests processed */
  getRequestCount(): number {
    return this.requests;
  }

  /** First pending permission entry */
  getHead(): PermissionEntry | undefined {
    return this.queue[0];
  }

  /** Get entire queue for rendering */
  getQueue(): PermissionEntry[] {
    return this.queue;
  }

  /** Add permission request to queue */
  push(toolName: string, input: string, permId: string, buttons: Button[]): void {
    this.requests++;
    this.queue.push({ toolName, input, permId, buttons });
    if (this.queue.length === 1) {
      this.startTimeout();
      this.callbacks.onReaction();
    }
  }

  /** Remove resolved permission from queue */
  resolve(permId?: string): void {
    if (permId) {
      const idx = this.queue.findIndex(p => p.permId === permId);
      if (idx !== -1) this.queue.splice(idx, 1);
    } else {
      this.queue.shift();
    }
    this.clearTimeout();
    if (this.queue.length > 0) {
      this.startTimeout();
    } else {
      this.callbacks.onReactionClear();
    }
  }

  /** Clear all timers */
  dispose(): void {
    this.clearTimeout();
  }

  private startTimeout(): void {
    this.clearTimeout();
    const head = this.queue[0];
    if (head) {
      this.timeoutTimer = setTimeout(() => {
        this.callbacks.onTimeout(head.toolName, head.input, head.buttons);
      }, PERMISSION_TIMEOUT_MS);
    }
  }

  private clearTimeout(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }
}