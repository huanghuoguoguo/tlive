import type { BaseChannelAdapter } from '../../../channels/base.js';

/**
 * Handles hook deduplication, callback resolution, and card updates.
 *
 * Handles:
 * - resolvedHookIds: Deduplicate hook permission resolutions
 * - hookPermissionTexts: Store original permission card text for card updates
 * - hookMessages: Track hook messages for reply routing
 */
export class HookResolver {
  /** Deduplicate hook permission resolutions (with timestamp for TTL cleanup) */
  private resolvedHookIds = new Map<string, number>();
  /** Store original permission card text for card updates after approval (with timestamp) */
  private hookPermissionTexts = new Map<string, { text: string; ts: number }>();
  /** Track hook messages for reply routing (permission-adjacent) */
  private hookMessages = new Map<string, { sessionId: string; timestamp: number }>();

  // --- Hook message tracking ---

  /** Track a hook message for reply routing */
  trackHookMessage(messageId: string, sessionId: string): void {
    this.hookMessages.set(messageId, { sessionId: sessionId || '', timestamp: Date.now() });
  }

  /** Check if a message is a tracked hook message */
  isHookMessage(messageId: string): boolean {
    return this.hookMessages.has(messageId);
  }

  /** Get a hook message entry */
  getHookMessage(messageId: string): { sessionId: string; timestamp: number } | undefined {
    return this.hookMessages.get(messageId);
  }

  // --- Hook permission text storage ---

  /** Store original permission card text for later card update */
  storeHookPermissionText(hookId: string, text: string): void {
    this.hookPermissionTexts.set(hookId, { text, ts: Date.now() });
  }

  /** Get stored hook permission text */
  getHookPermissionText(hookId: string): { text: string; ts: number } | undefined {
    return this.hookPermissionTexts.get(hookId);
  }

  /** Delete stored hook permission text */
  deleteHookPermissionText(hookId: string): void {
    this.hookPermissionTexts.delete(hookId);
  }

  // --- Deduplication ---

  /** Check if a hook ID is already resolved */
  isResolved(hookId: string): boolean {
    return this.resolvedHookIds.has(hookId);
  }

  /** Mark a hook ID as resolved */
  markResolved(hookId: string): void {
    this.resolvedHookIds.set(hookId, Date.now());
  }

  // --- Hook callback resolution (button-based) ---

  /** Handle hook button callback. Returns result for adapter to edit the card. */
  async resolveHookCallback(
    hookId: string,
    decision: string,
    sessionId: string,
    messageId: string,
    adapter: BaseChannelAdapter,
    chatId: string,
    questionResolver?: { hasQuestionData: (id: string) => boolean; deleteQuestionData: (id: string) => void },
  ): Promise<boolean> {
    // Deduplicate: skip if already resolved
    if (this.resolvedHookIds.has(hookId)) return true;
    this.resolvedHookIds.set(hookId, Date.now());

    const resolution = decision === 'deny' ? 'denied' : 'approved';
    const labels: Record<string, string> = {
      allow: '✅ Allowed',
      allow_always: '📌 Always Allowed',
      deny: '❌ Denied',
    };
    const label = labels[decision] || '✅ Allowed';

    // AskUserQuestion cards use hookQuestionData, not hookPermissionTexts
    if (questionResolver?.hasQuestionData(hookId)) {
      questionResolver.deleteQuestionData(hookId);
      await adapter.editCardResolution(chatId, messageId, {
        resolution,
        label: decision === 'deny' ? '❌ Skipped' : label,
      });
    } else {
      const originalText = this.hookPermissionTexts.get(hookId)?.text || '';
      this.hookPermissionTexts.delete(hookId);
      await adapter.editCardResolution(chatId, messageId, {
        resolution,
        label,
        originalText,
      });
    }
    // Track confirmation message for reply routing
    if (sessionId) {
      this.trackHookMessage(messageId, sessionId);
    }
    return true;
  }

  /** Resolve a hook permission (simplified - Go Core removed) */
  async resolveHookPermission(
    permissionId: string,
    _decision: string,
    channelType: string,
    sdkTracker?: {
      getPermissionMessages: () => Map<string, { permissionId: string; sessionId: string; timestamp: number }>;
      getLatestPermission: () => Map<string, { permissionId: string; sessionId: string; messageId: string }>;
      deletePermissionMessage: (id: string) => void;
      deleteLatestPermission: (channelType: string) => void;
    },
  ): Promise<void> {
    // Deduplicate: skip if already resolved (race between button and text)
    if (this.resolvedHookIds.has(permissionId)) return;
    this.resolvedHookIds.set(permissionId, Date.now());

    // Clean up tracking maps via SdkPermTracker
    if (sdkTracker) {
      for (const [id, e] of sdkTracker.getPermissionMessages()) {
        if (e.permissionId === permissionId) sdkTracker.deletePermissionMessage(id);
      }
      const latest = sdkTracker.getLatestPermission().get(channelType);
      if (latest?.permissionId === permissionId) sdkTracker.deleteLatestPermission(channelType);
    }
  }

  // --- Pruning ---

  /** Clean up stale entries older than 1 hour */
  pruneStaleEntries(): void {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [id, ts] of this.resolvedHookIds) {
      if (ts < cutoff) this.resolvedHookIds.delete(id);
    }
    for (const [id, entry] of this.hookPermissionTexts) {
      if (entry.ts < cutoff) this.hookPermissionTexts.delete(id);
    }
    // Also clean up hookMessages (24h cutoff)
    const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, entry] of this.hookMessages) {
      if (entry.timestamp < cutoff24h) this.hookMessages.delete(id);
    }
  }
}