/**
 * QueueManager — handles message queue depth and preview tracking.
 *
 * Extracted from SDKEngine for single responsibility:
 * - Queue depth tracking per session
 * - Message preview tracking for user feedback
 * - Queue capacity limits
 */

/** Queued message preview for user feedback */
interface QueuedMessagePreview {
  preview: string;
  timestamp: number;
}

/** Queue statistics for a session */
export interface QueueStats {
  sessionKey: string;
  depth: number;
  maxDepth: number;
}

/**
 * QueueManager handles queue depth and preview tracking for sessions.
 */
export class QueueManager {
  /** Queue depth per session: sessionKey → depth count */
  private queueDepthBySession = new Map<string, number>();
  /** Queued message previews per session: sessionKey → array of previews */
  private queuePreviewBySession = new Map<string, QueuedMessagePreview[]>();
  /** Maximum queued messages per session (configurable) */
  private maxQueueDepth = 3;

  // ── Configuration ──

  /** Get the max queue depth (configurable) */
  getMaxQueueDepth(): number {
    return this.maxQueueDepth;
  }

  /** Set the max queue depth (configurable) */
  setMaxQueueDepth(depth: number): void {
    if (depth < 1 || depth > 10) {
      console.warn(`[tlive:engine] Invalid max queue depth: ${depth}, keeping current value ${this.maxQueueDepth}`);
      return;
    }
    this.maxQueueDepth = depth;
    console.log(`[tlive:engine] Max queue depth set to ${depth}`);
  }

  // ── Queue Operations ──

  /** Get current queue depth for a session */
  getQueueDepth(sessionKey: string): number {
    return this.queueDepthBySession.get(sessionKey) ?? 0;
  }

  /** Check if queue is full for a session */
  isQueueFull(sessionKey: string): boolean {
    return this.getQueueDepth(sessionKey) >= this.maxQueueDepth;
  }

  /** Get queued message previews for a session */
  getQueuedMessages(sessionKey: string): QueuedMessagePreview[] {
    return this.queuePreviewBySession.get(sessionKey) ?? [];
  }

  /** Clear all queued messages for a session (does not affect SDK internal queue) */
  clearQueue(sessionKey: string): number {
    const depth = this.getQueueDepth(sessionKey);
    if (depth > 0) {
      this.queueDepthBySession.delete(sessionKey);
      this.queuePreviewBySession.delete(sessionKey);
      console.log(`[tlive:engine] Queue cleared for ${sessionKey} (was ${depth} messages)`);
    }
    return depth;
  }

  /** Get queue statistics for all sessions */
  getAllQueueStats(): QueueStats[] {
    const stats: QueueStats[] = [];
    for (const [sessionKey, depth] of this.queueDepthBySession) {
      if (depth > 0) {
        stats.push({ sessionKey, depth, maxDepth: this.maxQueueDepth });
      }
    }
    return stats;
  }

  /** Get total queued messages across all sessions */
  getTotalQueuedMessages(): number {
    let total = 0;
    for (const depth of this.queueDepthBySession.values()) {
      total += depth;
    }
    return total;
  }

  /** Increment queue depth after successful queue operation */
  incrementQueueDepth(sessionKey: string, preview: string): number {
    const current = this.getQueueDepth(sessionKey);
    const newDepth = current + 1;
    this.queueDepthBySession.set(sessionKey, newDepth);

    const truncatedPreview = preview.length > 100 ? preview.slice(0, 100) + '...' : preview;
    const previews = this.queuePreviewBySession.get(sessionKey) ?? [];
    previews.push({ preview: truncatedPreview, timestamp: Date.now() });
    this.queuePreviewBySession.set(sessionKey, previews);

    console.log(`[tlive:engine] Queue depth for ${sessionKey}: ${newDepth}`);
    return newDepth;
  }

  /**
   * Decrement queue depth when a queued message is consumed.
   * Called when a new turn starts or when we detect queue consumption.
   */
  decrementQueueDepth(sessionKey: string): void {
    const current = this.getQueueDepth(sessionKey);
    if (current > 0) {
      const newDepth = current - 1;
      if (newDepth === 0) {
        this.queueDepthBySession.delete(sessionKey);
        this.queuePreviewBySession.delete(sessionKey);
      } else {
        this.queueDepthBySession.set(sessionKey, newDepth);
        const previews = this.queuePreviewBySession.get(sessionKey);
        if (previews && previews.length > 0) {
          previews.shift();
        }
      }
      console.log(`[tlive:engine] Queue depth for ${sessionKey}: ${newDepth}`);
    }
  }

  /**
   * Get queue info for a session: { depth, max }.
   * Returns undefined if session doesn't exist or has no queue.
   */
  getQueueInfo(sessionKey: string): { depth: number; max: number } | undefined {
    const depth = this.getQueueDepth(sessionKey);
    if (depth === 0) return undefined;
    return { depth, max: this.maxQueueDepth };
  }

  /** Clean up queue depth when a live session is closed */
  cleanupQueueForSession(sessionKey: string): void {
    this.queueDepthBySession.delete(sessionKey);
    this.queuePreviewBySession.delete(sessionKey);
  }
}