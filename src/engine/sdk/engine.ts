/**
 * SDKEngine — manages LiveSessions plus steer/queue state for SDK conversations.
 *
 * Core responsibilities:
 * - Session registry: manage LiveSessions per chat+workdir
 * - Steer/Queue: inject messages into active turns or queue for later using SDK native priority
 * - Bubble tracking: map progress bubble messageId to session for multi-session steering
 * - Queue depth tracking: limit queued messages and provide user feedback
 */

import type { QueryControls, LiveSession, LLMProvider, MessagePriority } from '../../providers/base.js';
import type { ClaudeSettingSource } from '../../config.js';
import type { EffortLevel } from '../../utils/types.js';
import { InteractionState, type SdkQuestionState } from '../state/interaction-state.js';
import { SESSION_STALE_THRESHOLD_MS } from '../../utils/constants.js';

/** Reason for closing a session — used for logging and diagnostics */
export type SessionCleanupReason = 'new' | 'switch' | 'cd' | 'settings' | 'expire' | 'close';

/** Managed session — wraps a LiveSession with per-chat metadata */
interface ManagedSession {
  session: LiveSession;
  workdir: string;
  lastActiveAt: number;
}

/** Queued message preview for user feedback */
interface QueuedMessagePreview {
  preview: string;
  timestamp: number;
}

/** Result of sendWithContext operation */
export interface SendWithContextResult {
  sent: boolean;
  mode: 'steer' | 'queue' | 'none';
  sessionKey?: string;
  /** Why sending failed when sent=false */
  failureReason?: 'no_session' | 'reply_target_missing' | 'send_failed';
  /** Queue position (1-based) when mode is 'queue', undefined otherwise */
  queuePosition?: number;
  /** Whether the queue was full (only set when sent is false and mode is 'queue') */
  queueFull?: boolean;
  /** Queue depth snapshot when queue-related */
  queueDepth?: number;
  /** Max queue depth snapshot when queue-related */
  maxQueueDepth?: number;
}

/** Queue statistics for a session */
export interface QueueStats {
  sessionKey: string;
  depth: number;
  maxDepth: number;
}

/**
 * Handles shared SDK session state for live turns and follow-up steering.
 *
 * Provider-agnostic — works with both Claude SDK (LiveSession) and fallback streamChat.
 */
export class SDKEngine {
  private activeControls = new Map<string, QueryControls>();

  /** Session registry: sessionKey → ManagedSession */
  private registry = new Map<string, ManagedSession>();
  /** Active session per chat: channelType:chatId → sessionKey (fallback when no replyTo) */
  private activeSessionByChat = new Map<string, string>();
  /** Progress bubble → session: messageId → sessionKey (for multi-session steering) */
  private bubbleToSession = new Map<string, string>();
  /** Reverse index: sessionKey → Set<messageId> (for O(1) cleanup) */
  private sessionToBubbles = new Map<string, Set<string>>();
  /** Max bubble mappings to keep (prevents unbounded growth) */
  private static MAX_BUBBLE_MAPPINGS = 200;

  /** Queue depth per session: sessionKey → depth count */
  private queueDepthBySession = new Map<string, number>();
  /** Queued message previews per session: sessionKey → array of previews */
  private queuePreviewBySession = new Map<string, QueuedMessagePreview[]>();
  /** Maximum queued messages per session (configurable) */
  private maxQueueDepth = 3;

  // SDK AskUserQuestion state — shared with routing / callbacks via InteractionState.
  private interactions = new InteractionState();

  /** Idle timeout for LiveSessions (30 minutes) */
  private static SESSION_IDLE_MS = 30 * 60 * 1000;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  /** Optional callback to clean up permission whitelist when session is pruned */
  onSessionPruned?: (sessionKey: string) => void;

  /** Start periodic cleanup of idle LiveSessions */
  startSessionPruning(): void {
    this.pruneTimer = setInterval(() => this.pruneIdleSessions(), 60_000);
  }

  /** Stop periodic cleanup */
  stopSessionPruning(): void {
    if (this.pruneTimer) { clearInterval(this.pruneTimer); this.pruneTimer = null; }
  }

  /** Close sessions idle longer than SESSION_IDLE_MS */
  private pruneIdleSessions(): void {
    const now = Date.now();
    for (const [key, managed] of this.registry) {
      if (!managed.session.isAlive) {
        this.registry.delete(key);
        this.cleanupBubblesForSession(key);
        this.cleanupQueueForSession(key);
        continue;
      }
      if (!managed.session.isTurnActive && (now - managed.lastActiveAt) > SDKEngine.SESSION_IDLE_MS) {
        console.log(`[tlive:engine] Pruning idle LiveSession: ${key} (idle ${Math.round((now - managed.lastActiveAt) / 60000)}m)`);
        managed.session.close();
        this.registry.delete(key);
        this.cleanupBubblesForSession(key);
        this.cleanupQueueForSession(key);
        this.onSessionPruned?.(key);
      }
    }
  }

  /** Clean up bubble → session mappings when session is closed */
  private cleanupBubblesForSession(sessionKey: string): void {
    const bubbles = this.sessionToBubbles.get(sessionKey);
    if (bubbles) {
      for (const bubbleId of bubbles) {
        this.bubbleToSession.delete(bubbleId);
      }
      this.sessionToBubbles.delete(sessionKey);
    }
  }

  /** Clean up queue depth when session is closed */
  private cleanupQueueForSession(sessionKey: string): void {
    this.queueDepthBySession.delete(sessionKey);
    this.queuePreviewBySession.delete(sessionKey);
  }

  // ── Session Registry ──

  /** Build session key: channelType:chatId:workdir */
  private sessionKey(channelType: string, chatId: string, workdir: string): string {
    return `${channelType}:${chatId}:${workdir}`;
  }

  /** Close a session (on /new, session expiry, workdir change). Delegates to cleanupSession. */
  closeSession(channelType: string, chatId: string, workdir?: string): void {
    this.cleanupSession(channelType, chatId, 'close', workdir);
  }

  /**
   * Unified session cleanup with reason logging.
   * Called on /new, session switch, directory change, settings change.
   * Returns true if a session was actually closed.
   */
  cleanupSession(channelType: string, chatId: string, reason: SessionCleanupReason, workdir?: string): boolean {
    const chatKey = `${channelType}:${chatId}`;
    let closed = false;

    if (workdir) {
      // Close specific session
      const key = this.sessionKey(channelType, chatId, workdir);
      const managed = this.registry.get(key);
      if (managed) {
        managed.session.close();
        this.registry.delete(key);
        this.cleanupBubblesForSession(key);
        this.cleanupQueueForSession(key);
        if (this.activeSessionByChat.get(chatKey) === key) {
          this.activeSessionByChat.delete(chatKey);
        }
        console.log(`[tlive:engine] Session cleanup (${reason}): ${key}`);
        closed = true;
      }
    } else {
      // Close ALL sessions for this chat
      const prefix = `${channelType}:${chatId}:`;
      for (const [key, managed] of this.registry) {
        if (key.startsWith(prefix)) {
          managed.session.close();
          this.registry.delete(key);
          this.cleanupBubblesForSession(key);
          this.cleanupQueueForSession(key);
          console.log(`[tlive:engine] Session cleanup (${reason}): ${key}`);
          closed = true;
        }
      }
      if (closed) {
        this.activeSessionByChat.delete(chatKey);
      }
    }

    return closed;
  }

  /**
   * Check if a session exists and is alive for the given chat/workdir.
   */
  hasActiveSession(channelType: string, chatId: string, workdir?: string): boolean {
    if (workdir) {
      const key = this.sessionKey(channelType, chatId, workdir);
      const managed = this.registry.get(key);
      return managed?.session.isAlive ?? false;
    }
    // Check if any session exists for this chat
    const chatKey = `${channelType}:${chatId}`;
    const sessionKey = this.activeSessionByChat.get(chatKey);
    if (!sessionKey) return false;
    const managed = this.registry.get(sessionKey);
    return managed?.session.isAlive ?? false;
  }

  /**
   * Get existing LiveSession or create a new one.
   * Returns the session, or undefined if provider doesn't support LiveSession.
   */
  getOrCreateSession(
    llm: LLMProvider,
    channelType: string,
    chatId: string,
    workdir: string,
    options?: { sessionId?: string; effort?: EffortLevel; model?: string; settingSources?: ClaudeSettingSource[]; appendSystemPrompt?: string },
  ): LiveSession | undefined {
    if (!llm.createSession) return undefined;

    const key = this.sessionKey(channelType, chatId, workdir);
    const chatKey = `${channelType}:${chatId}`;

    // Check existing session
    const existing = this.registry.get(key);
    if (existing?.session.isAlive) {
      existing.lastActiveAt = Date.now();
      this.activeSessionByChat.set(chatKey, key);
      return existing.session;
    }

    // Clean up dead session if any
    if (existing) {
      this.registry.delete(key);
    }

    // Create new session
    console.log(`[tlive:engine] Creating LiveSession for ${key}`);
    const session = llm.createSession({
      workingDirectory: workdir,
      sessionId: options?.sessionId,
      effort: options?.effort,
      model: options?.model,
      settingSources: options?.settingSources,
      appendSystemPrompt: options?.appendSystemPrompt,
    });

    this.registry.set(key, { session, workdir, lastActiveAt: Date.now() });
    session.setLifecycleCallbacks?.({
      onTurnComplete: () => {
        const managed = this.registry.get(key);
        if (managed) {
          managed.lastActiveAt = Date.now();
        }
        if (this.getQueueDepth(key) > 0) {
          this.decrementQueueDepth(key);
        }
      },
    });
    this.activeSessionByChat.set(chatKey, key);
    return session;
  }

  // ── Queue Depth Management ──

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
  private incrementQueueDepth(sessionKey: string, preview: string): number {
    const current = this.getQueueDepth(sessionKey);
    const newDepth = current + 1;
    this.queueDepthBySession.set(sessionKey, newDepth);

    // Track message preview (truncate to 100 chars)
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
        // Remove the oldest preview
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
    const managed = this.registry.get(sessionKey);
    if (!managed?.session.isAlive) return undefined;
    const depth = this.getQueueDepth(sessionKey);
    if (depth === 0) return undefined;
    return { depth, max: this.maxQueueDepth };
  }

  // ── Session Stale Detection ──

  /**
   * Check if a session is stale (inactive for too long).
   * Uses SESSION_STALE_THRESHOLD_MS (default 2 hours).
   */
  isSessionStale(sessionKey: string): boolean {
    const managed = this.registry.get(sessionKey);
    if (!managed?.session.isAlive) return false; // Dead session is not "stale", it's closed
    const idleTime = Date.now() - managed.lastActiveAt;
    return idleTime > SESSION_STALE_THRESHOLD_MS;
  }

  /**
   * Check if a chat's active session is stale.
   * Convenience method for use in command-router.
   */
  isChatSessionStale(channelType: string, chatId: string): boolean {
    const chatKey = `${channelType}:${chatId}`;
    const sessionKey = this.activeSessionByChat.get(chatKey);
    if (!sessionKey) return false;
    return this.isSessionStale(sessionKey);
  }

  /**
   * Get the last active timestamp for a session.
   * Returns undefined if session doesn't exist.
   */
  getSessionLastActiveAt(sessionKey: string): number | undefined {
    const managed = this.registry.get(sessionKey);
    return managed?.lastActiveAt;
  }

  /**
   * Get the active session key for a chat.
   */
  getActiveSessionKey(channelType: string, chatId: string): string | undefined {
    return this.activeSessionByChat.get(`${channelType}:${chatId}`);
  }

  // ── Steer / Queue ──

  /** Internal: link bubble messageId to session, maintaining reverse index and cap */
  private linkBubble(messageId: string, sessionKey: string): void {
    // Evict oldest entries if at cap
    if (this.bubbleToSession.size >= SDKEngine.MAX_BUBBLE_MAPPINGS) {
      const oldest = this.bubbleToSession.keys().next().value;
      if (oldest) {
        const oldSession = this.bubbleToSession.get(oldest);
        this.bubbleToSession.delete(oldest);
        if (oldSession) this.sessionToBubbles.get(oldSession)?.delete(oldest);
      }
    }
    this.bubbleToSession.set(messageId, sessionKey);
    let bubbles = this.sessionToBubbles.get(sessionKey);
    if (!bubbles) {
      bubbles = new Set();
      this.sessionToBubbles.set(sessionKey, bubbles);
    }
    bubbles.add(messageId);
  }

  /**
   * Get session key for a bubble (replyToMessageId).
   * Returns undefined if bubble not tracked or session no longer alive.
   */
  getSessionForBubble(messageId: string): string | undefined {
    const sessionKey = this.bubbleToSession.get(messageId);
    if (!sessionKey) return undefined;
    const managed = this.registry.get(sessionKey);
    if (!managed?.session.isAlive) {
      // Clean up stale mapping
      this.bubbleToSession.delete(messageId);
      this.sessionToBubbles.get(sessionKey)?.delete(messageId);
      return undefined;
    }
    return sessionKey;
  }

  private resolveTargetSessionWithReason(
    channelType: string,
    chatId: string,
    replyToMessageId?: string,
  ): { sessionKey?: string; failureReason?: SendWithContextResult['failureReason'] } {
    if (replyToMessageId) {
      const bubbleSession = this.getSessionForBubble(replyToMessageId);
      if (bubbleSession) {
        return { sessionKey: bubbleSession };
      }
      // Explicit reply target should not silently fall back to another session.
      return { failureReason: 'reply_target_missing' };
    }
    const active = this.activeSessionByChat.get(`${channelType}:${chatId}`);
    if (!active) {
      return { failureReason: 'no_session' };
    }
    return { sessionKey: active };
  }

  /** Check if a specific session can be steered (alive + turn active) */
  canSteerSession(sessionKey: string): boolean {
    const managed = this.registry.get(sessionKey);
    return (managed?.session.isAlive && managed?.session.isTurnActive) ?? false;
  }

  /** Send message to a specific session with SDK native priority */
  async sendToSession(sessionKey: string, text: string, priority: MessagePriority): Promise<boolean> {
    const managed = this.registry.get(sessionKey);
    if (!managed?.session.isAlive) return false;
    try {
      await managed.session.sendWithPriority(text, priority);
      managed.lastActiveAt = Date.now();
      return true;
    } catch (err) {
      console.error(`[tlive:engine] sendToSession error:`, err);
      return false;
    }
  }

  /**
   * Steer or queue based on reply context.
   * - If replyToMessageId → steer/queue to that bubble's session
   * - Otherwise → steer/queue to active session
   * - Tracks queue depth and rejects when queue is full
   * - Tracks message previews for queue status display
   */
  async sendWithContext(
    channelType: string,
    chatId: string,
    text: string,
    replyToMessageId?: string,
  ): Promise<SendWithContextResult> {
    const { sessionKey, failureReason } = this.resolveTargetSessionWithReason(
      channelType,
      chatId,
      replyToMessageId,
    );
    if (!sessionKey) {
      return { sent: false, mode: 'none', failureReason: failureReason ?? 'no_session' };
    }

    // Steer if turn active
    if (this.canSteerSession(sessionKey)) {
      const sent = await this.sendToSession(sessionKey, text, 'now');
      return {
        sent,
        mode: sent ? 'steer' : 'none',
        sessionKey,
        failureReason: sent ? undefined : 'send_failed',
      };
    }

    // Check queue depth before queueing
    if (this.isQueueFull(sessionKey)) {
      console.log(`[tlive:engine] Queue full for ${sessionKey}, rejecting message`);
      return {
        sent: false,
        mode: 'queue',
        sessionKey,
        queueFull: true,
        queueDepth: this.getQueueDepth(sessionKey),
        maxQueueDepth: this.maxQueueDepth,
      };
    }

    // Queue the message
    const sent = await this.sendToSession(sessionKey, text, 'later');
    if (sent) {
      const queuePosition = this.incrementQueueDepth(sessionKey, text);
      return {
        sent: true,
        mode: 'queue',
        sessionKey,
        queuePosition,
        queueDepth: queuePosition,
        maxQueueDepth: this.maxQueueDepth,
      };
    }
    return { sent: false, mode: 'none', sessionKey, failureReason: 'send_failed' };
  }

  // ── Shared State (CallbackRouter, /stop) ──

  /** Expose question state for CallbackRouter */
  getQuestionState(): SdkQuestionState {
    return this.interactions.snapshot();
  }

  /** Expose the formal interaction state for SDK AskUserQuestion flows. */
  getInteractionState(): InteractionState {
    return this.interactions;
  }

  /** Get active controls for a chat (for /stop command) */
  getActiveControls(): Map<string, QueryControls> {
    return this.activeControls;
  }

  /** Get active controls for a specific chat */
  getControlsForChat(chatKey: string): QueryControls | undefined {
    return this.activeControls.get(chatKey);
  }

  /** Set active controls for a chat */
  setControlsForChat(chatKey: string, controls: QueryControls | undefined): void {
    if (controls) {
      this.activeControls.set(chatKey, controls);
    } else {
      this.activeControls.delete(chatKey);
    }
  }

  /** Track progress bubble messageId → sessionKey mapping */
  setActiveMessageId(_chatKey: string, messageId: string | undefined, sessionKey?: string): void {
    if (messageId && sessionKey) {
      this.linkBubble(messageId, sessionKey);
    }
  }

  // ── Diagnostics ──

  /** Get number of active (alive) sessions */
  getActiveSessionCount(): number {
    let count = 0;
    for (const managed of this.registry.values()) {
      if (managed.session.isAlive) count++;
    }
    return count;
  }

  /** Get number of idle sessions (alive but not turn active) */
  getIdleSessionCount(): number {
    let count = 0;
    for (const managed of this.registry.values()) {
      if (managed.session.isAlive && !managed.session.isTurnActive) count++;
    }
    return count;
  }

  /** Get total number of bubble mappings */
  getTotalBubbleMappings(): number {
    return this.bubbleToSession.size;
  }

  /** Get session registry snapshot for diagnostics */
  getSessionRegistrySnapshot(): Array<{ sessionKey: string; workdir: string; isAlive: boolean; isTurnActive: boolean; lastActiveAt: number }> {
    const snapshot = [];
    for (const [key, managed] of this.registry) {
      snapshot.push({
        sessionKey: key,
        workdir: managed.workdir,
        isAlive: managed.session.isAlive,
        isTurnActive: managed.session.isTurnActive,
        lastActiveAt: managed.lastActiveAt,
      });
    }
    return snapshot;
  }

}
