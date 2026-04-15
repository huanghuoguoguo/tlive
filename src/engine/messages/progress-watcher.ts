/**
 * Progress watcher — detects stalled progress and notifies.
 * Extracted from MessageRenderer for cleaner architecture.
 */

/** Timeout before marking progress as stalled */
const PROGRESS_TIMEOUT_MS = 30_000;
/** Throttle for progress reset calls */
const PROGRESS_RESET_THROTTLE_MS = 5000;

export interface ProgressWatcherCallbacks {
  /** Called when no progress for >30s during execution */
  onStalled: () => void;
  /** Called when progress resumes after stall */
  onResumed: () => void;
}

export class ProgressWatcher {
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private stalled = false;
  private lastReset = 0;

  constructor(private callbacks: ProgressWatcherCallbacks) {}

  /** Whether progress is currently stalled */
  isStalled(): boolean {
    return this.stalled;
  }

  /** Start progress timeout timer */
  start(): void {
    this.clear();
    this.timeoutTimer = setTimeout(() => {
      if (!this.stalled) {
        this.stalled = true;
        this.callbacks.onStalled();
      }
    }, PROGRESS_TIMEOUT_MS);
  }

  /** Clear progress timeout timer */
  clear(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  /** Resume progress if stalled (throttled) */
  resume(): void {
    if (this.stalled) {
      this.stalled = false;
      this.callbacks.onResumed();
    }
    // Throttle reset to avoid timer churn
    const now = Date.now();
    if (now - this.lastReset >= PROGRESS_RESET_THROTTLE_MS) {
      this.lastReset = now;
      this.start();
    }
  }

  /** Clear timers and state */
  dispose(): void {
    this.clear();
    this.stalled = false;
  }
}