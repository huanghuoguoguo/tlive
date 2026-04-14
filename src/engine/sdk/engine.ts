/**
 * SDKEngine — manages LiveSessions plus steer/queue state for SDK conversations.
 *
 * Core responsibilities:
 * - Session registry: manage LiveSessions per logical chat session
 * - Steer/Queue: inject messages into active turns or queue for later using SDK native priority
 * - Bubble tracking: map progress bubble messageId to session for multi-session steering
 * - Queue depth tracking: limit queued messages and provide user feedback
 */

import type { QueryControls, LiveSession, LLMProvider, MessagePriority } from '../../providers/base.js';
import type { ClaudeSettingSource } from '../../config.js';
import type { EffortLevel } from '../../utils/types.js';
import type { ManagedSessionSnapshot } from '../../formatting/message-types.js';
import { InteractionState, type SdkQuestionState } from '../state/interaction-state.js';
import { SESSION_STALE_THRESHOLD_MS } from '../../utils/constants.js';
import { chatKey as buildChatKey } from '../../utils/key.js';

/** Reason for closing a session — used for logging and diagnostics */
export type SessionCleanupReason = 'new' | 'switch' | 'cd' | 'settings' | 'expire' | 'close';

/** Managed session — wraps a LiveSession with per-chat metadata */
interface ManagedSession {
  channelType: string;
  chatId: string;
  bindingSessionId: string;
  workdir: string;
  sdkSessionId?: string;
  lastActiveAt: number;
  session?: LiveSession;
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

export interface ResolvedSessionTarget {
  sessionKey: string;
  bindingSessionId: string;
  workdir: string;
  sdkSessionId?: string;
  source: 'reply' | 'current';
}

/**
 * Handles shared SDK session state for live turns and follow-up steering.
 *
 * Provider-agnostic — works with both Claude SDK (LiveSession) and fallback streamChat.
 */
export class SDKEngine {
  private activeControlsBySession = new Map<string, QueryControls>();
  private activeControlsByChat = new Map<string, QueryControls>();
  private controlChatBySession = new Map<string, string>();

  /** Session registry: sessionKey → ManagedSession */
  private registry = new Map<string, ManagedSession>();
  /** Current default session per chat: channelType:chatId → sessionKey */
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
  /** Optional callback after an idle live session is pruned */
  onSessionPruned?: (sessionKey: string) => void;

  /** Start periodic cleanup of idle LiveSessions */
  startSessionPruning(): void {
    this.pruneTimer = setInterval(() => this.pruneIdleSessions(), 60_000);
  }

  /** Stop periodic cleanup */
  stopSessionPruning(): void {
    if (this.pruneTimer) { clearInterval(this.pruneTimer); this.pruneTimer = null; }
  }

  /** Close only the in-memory LiveSession for idle sessions, but keep logical routing metadata. */
  private pruneIdleSessions(): void {
    const now = Date.now();
    for (const [key, managed] of this.registry) {
      if (!managed.session?.isAlive) {
        managed.session = undefined;
        continue;
      }
      if (!managed.session.isTurnActive && (now - managed.lastActiveAt) > SDKEngine.SESSION_IDLE_MS) {
        console.log(`[tlive:engine] Pruning idle LiveSession: ${key} (idle ${Math.round((now - managed.lastActiveAt) / 60000)}m)`);
        this.closeLiveSession(key, 'close', { preserveContext: true, preserveBubbles: true });
        this.onSessionPruned?.(key);
      }
    }
  }

  /** Clean up bubble → session mappings when a logical session is removed */
  private cleanupBubblesForSession(sessionKey: string): void {
    const bubbles = this.sessionToBubbles.get(sessionKey);
    if (bubbles) {
      for (const bubbleId of bubbles) {
        this.bubbleToSession.delete(bubbleId);
      }
      this.sessionToBubbles.delete(sessionKey);
    }
  }

  /** Clean up queue depth when a live session is closed */
  private cleanupQueueForSession(sessionKey: string): void {
    this.queueDepthBySession.delete(sessionKey);
    this.queuePreviewBySession.delete(sessionKey);
  }

  private cleanupControlsForSession(sessionKey: string): void {
    this.activeControlsBySession.delete(sessionKey);
    const chatKey = this.controlChatBySession.get(sessionKey);
    if (!chatKey) return;
    this.controlChatBySession.delete(sessionKey);

    // Try to find fallback from the current default session
    const defaultSessionKey = this.activeSessionByChat.get(chatKey);
    if (defaultSessionKey) {
      const defaultCtrl = this.activeControlsBySession.get(defaultSessionKey);
      if (defaultCtrl) {
        this.activeControlsByChat.set(chatKey, defaultCtrl);
        return;
      }
    }

    this.activeControlsByChat.delete(chatKey);
  }

  // ── Session Registry ──

  /** Build chat key: channelType:chatId */
  private chatKey(channelType: string, chatId: string): string {
    return buildChatKey(channelType, chatId);
  }

  /** Build session key: channelType:chatId:bindingSessionId */
  private sessionKey(channelType: string, chatId: string, bindingSessionId: string): string {
    return `${channelType}:${chatId}:${bindingSessionId}`;
  }

  /** Filter sessions matching a chat and optionally workdir. */
  private *filterSessions(channelType: string, chatId: string, workdir?: string): Generator<[string, ManagedSession]> {
    const prefix = `${channelType}:${chatId}:`;
    for (const [key, managed] of this.registry) {
      if (!key.startsWith(prefix)) continue;
      if (workdir && managed.workdir !== workdir) continue;
      yield [key, managed];
    }
  }

  getSessionKeyForBinding(channelType: string, chatId: string, bindingSessionId: string): string {
    return this.sessionKey(channelType, chatId, bindingSessionId);
  }

  registerSessionContext(
    channelType: string,
    chatId: string,
    bindingSessionId: string,
    workdir: string,
    sdkSessionId?: string,
    opts?: { setAsCurrent?: boolean },
  ): string {
    const key = this.sessionKey(channelType, chatId, bindingSessionId);
    const existing = this.registry.get(key);
    const now = Date.now();

    if (existing) {
      existing.workdir = workdir;
      existing.sdkSessionId = sdkSessionId ?? existing.sdkSessionId;
      existing.lastActiveAt = now;
    } else {
      this.registry.set(key, {
        channelType,
        chatId,
        bindingSessionId,
        workdir,
        sdkSessionId,
        lastActiveAt: now,
      });
    }

    if (opts?.setAsCurrent !== false) {
      this.activeSessionByChat.set(this.chatKey(channelType, chatId), key);
    }
    return key;
  }

  hasSessionContext(channelType: string, chatId: string, bindingSessionId: string): boolean {
    return this.registry.has(this.sessionKey(channelType, chatId, bindingSessionId));
  }

  getSessionContext(sessionKey: string): ManagedSession | undefined {
    return this.registry.get(sessionKey);
  }

  updateSessionSdkSessionId(sessionKey: string, sdkSessionId?: string): void {
    const managed = this.registry.get(sessionKey);
    if (managed) {
      managed.sdkSessionId = sdkSessionId;
      managed.lastActiveAt = Date.now();
    }
  }

  resolveSessionTarget(
    channelType: string,
    chatId: string,
    binding: { sessionId: string; cwd?: string; sdkSessionId?: string },
    defaultWorkdir: string,
    replyToMessageId?: string,
  ): { target?: ResolvedSessionTarget; failureReason?: SendWithContextResult['failureReason'] } {
    if (replyToMessageId) {
      const sessionKey = this.getSessionForBubble(replyToMessageId);
      if (!sessionKey) {
        return { failureReason: 'reply_target_missing' };
      }
      const managed = this.registry.get(sessionKey);
      if (!managed) {
        this.bubbleToSession.delete(replyToMessageId);
        return { failureReason: 'reply_target_missing' };
      }
      return {
        target: {
          sessionKey,
          bindingSessionId: managed.bindingSessionId,
          workdir: managed.workdir,
          sdkSessionId: managed.sdkSessionId,
          source: 'reply',
        },
      };
    }

    const workdir = binding.cwd || defaultWorkdir;
    const sessionKey = this.registerSessionContext(
      channelType,
      chatId,
      binding.sessionId,
      workdir,
      binding.sdkSessionId,
      { setAsCurrent: true },
    );
    return {
      target: {
        sessionKey,
        bindingSessionId: binding.sessionId,
        workdir,
        sdkSessionId: binding.sdkSessionId,
        source: 'current',
      },
    };
  }

  /** Close a session runtime but keep logical context available for future resume. */
  resetSessionRuntime(sessionKey: string, reason: SessionCleanupReason): boolean {
    return this.closeLiveSession(sessionKey, reason, { preserveContext: true, preserveBubbles: true });
  }

  /** Close a session (explicit cleanup). Delegates to cleanupSession. */
  closeSession(channelType: string, chatId: string, workdir?: string): void {
    this.cleanupSession(channelType, chatId, 'close', workdir);
  }

  private closeLiveSession(
    sessionKey: string,
    reason: SessionCleanupReason,
    opts: { preserveContext: boolean; preserveBubbles: boolean },
  ): boolean {
    const managed = this.registry.get(sessionKey);
    if (!managed) return false;

    if (managed.session?.isAlive) {
      managed.session.close();
    }
    managed.session = undefined;
    this.cleanupQueueForSession(sessionKey);
    this.cleanupControlsForSession(sessionKey);

    if (!opts.preserveContext) {
      this.registry.delete(sessionKey);
      if (!opts.preserveBubbles) {
        this.cleanupBubblesForSession(sessionKey);
      }
      const chatKey = this.chatKey(managed.channelType, managed.chatId);
      if (this.activeSessionByChat.get(chatKey) === sessionKey) {
        this.activeSessionByChat.delete(chatKey);
      }
    }

    console.log(`[tlive:engine] Session cleanup (${reason}): ${sessionKey}`);
    return true;
  }

  /**
   * Unified session cleanup with reason logging.
   * When workdir is provided, closes all logical sessions for that chat/workdir.
   * When omitted, closes all logical sessions for the chat.
   * Cleanup removes reply-routing state; use resetSessionRuntime() to preserve resume metadata.
   */
  cleanupSession(channelType: string, chatId: string, reason: SessionCleanupReason, workdir?: string): boolean {
    let closed = false;
    for (const [key] of this.filterSessions(channelType, chatId, workdir)) {
      closed = this.closeLiveSession(key, reason, { preserveContext: false, preserveBubbles: false }) || closed;
    }
    return closed;
  }

  /**
   * Check if a live session exists and is alive for the given chat/workdir.
   */
  hasActiveSession(channelType: string, chatId: string, workdir?: string): boolean {
    for (const [, managed] of this.filterSessions(channelType, chatId, workdir)) {
      if (managed.session?.isAlive) return true;
    }
    return false;
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
    options?: {
      sessionId?: string;
      effort?: EffortLevel;
      model?: string;
      settingSources?: ClaudeSettingSource[];
      appendSystemPrompt?: string;
      setAsCurrent?: boolean;
    },
  ): LiveSession | undefined;
  getOrCreateSession(
    llm: LLMProvider,
    channelType: string,
    chatId: string,
    bindingSessionId: string,
    workdir: string,
    options?: {
      sessionId?: string;
      effort?: EffortLevel;
      model?: string;
      settingSources?: ClaudeSettingSource[];
      appendSystemPrompt?: string;
      setAsCurrent?: boolean;
    },
  ): LiveSession | undefined;
  getOrCreateSession(
    llm: LLMProvider,
    channelType: string,
    chatId: string,
    bindingSessionIdOrWorkdir: string,
    workdirOrOptions?: string | {
      sessionId?: string;
      effort?: EffortLevel;
      model?: string;
      settingSources?: ClaudeSettingSource[];
      appendSystemPrompt?: string;
      setAsCurrent?: boolean;
    },
    maybeOptions?: {
      sessionId?: string;
      effort?: EffortLevel;
      model?: string;
      settingSources?: ClaudeSettingSource[];
      appendSystemPrompt?: string;
      setAsCurrent?: boolean;
    },
  ): LiveSession | undefined {
    if (!llm.createSession) return undefined;

    const actualBindingSessionId = typeof workdirOrOptions === 'string'
      ? bindingSessionIdOrWorkdir
      : bindingSessionIdOrWorkdir;
    const actualWorkdir = typeof workdirOrOptions === 'string'
      ? workdirOrOptions
      : bindingSessionIdOrWorkdir;
    const actualOptions = (typeof workdirOrOptions === 'string' ? maybeOptions : workdirOrOptions) ?? {};

    const existingKey = this.sessionKey(channelType, chatId, actualBindingSessionId);
    const previousManaged = this.registry.get(existingKey);
    const previousSdkSessionId = previousManaged?.sdkSessionId;
    const previousWorkdir = previousManaged?.workdir;
    const key = this.registerSessionContext(
      channelType,
      chatId,
      actualBindingSessionId,
      actualWorkdir,
      actualOptions.sessionId,
      { setAsCurrent: actualOptions.setAsCurrent !== false },
    );
    const managed = this.registry.get(key);
    if (!managed) return undefined;

    const existing = managed.session;
    const sessionIdChanged = actualOptions.sessionId !== undefined
      && previousSdkSessionId !== undefined
      && actualOptions.sessionId !== previousSdkSessionId;
    const workdirChanged = previousWorkdir !== undefined && previousWorkdir !== actualWorkdir;

    if (existing?.isAlive && !sessionIdChanged && !workdirChanged) {
      managed.lastActiveAt = Date.now();
      return existing;
    }

    if (existing?.isAlive && (sessionIdChanged || workdirChanged)) {
      existing.close();
      managed.session = undefined;
      this.cleanupQueueForSession(key);
      this.cleanupControlsForSession(key);
    }

    console.log(`[tlive:engine] Creating LiveSession for ${key}`);
    const session = llm.createSession({
      workingDirectory: actualWorkdir,
      sessionId: actualOptions.sessionId,
      effort: actualOptions.effort,
      model: actualOptions.model,
      settingSources: actualOptions.settingSources,
      appendSystemPrompt: actualOptions.appendSystemPrompt,
    });

    managed.session = session;
    managed.workdir = actualWorkdir;
    managed.sdkSessionId = actualOptions.sessionId ?? managed.sdkSessionId;
    managed.lastActiveAt = Date.now();
    session.setLifecycleCallbacks?.({
      onTurnComplete: () => {
        const current = this.registry.get(key);
        if (current) {
          current.lastActiveAt = Date.now();
        }
        if (this.getQueueDepth(key) > 0) {
          this.decrementQueueDepth(key);
        }
      },
    });
    this.activeSessionByChat.set(this.chatKey(channelType, chatId), key);
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
    const managed = this.registry.get(sessionKey);
    if (!managed) return undefined;
    const depth = this.getQueueDepth(sessionKey);
    if (depth === 0) return undefined;
    return { depth, max: this.maxQueueDepth };
  }

  // ── Session Stale Detection ──

  /**
   * Check if a live session is stale (inactive for too long).
   * Uses SESSION_STALE_THRESHOLD_MS (default 2 hours).
   */
  isSessionStale(sessionKey: string): boolean {
    const managed = this.registry.get(sessionKey);
    if (!managed?.session?.isAlive) return false;
    const idleTime = Date.now() - managed.lastActiveAt;
    return idleTime > SESSION_STALE_THRESHOLD_MS;
  }

  /**
   * Check if a chat's current default session is stale.
   * Convenience method for use in command-router.
   */
  isChatSessionStale(channelType: string, chatId: string): boolean {
    const sessionKey = this.activeSessionByChat.get(this.chatKey(channelType, chatId));
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
   * Get the current default session key for a chat.
   */
  getActiveSessionKey(channelType: string, chatId: string): string | undefined {
    return this.activeSessionByChat.get(this.chatKey(channelType, chatId));
  }

  // ── Steer / Queue ──

  /** Internal: link bubble messageId to session, maintaining reverse index and cap */
  private linkBubble(messageId: string, sessionKey: string): void {
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
   * Returns undefined if the logical session no longer exists.
   */
  getSessionForBubble(messageId: string): string | undefined {
    const sessionKey = this.bubbleToSession.get(messageId);
    if (!sessionKey) return undefined;
    if (!this.registry.has(sessionKey)) {
      this.bubbleToSession.delete(messageId);
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
      return { failureReason: 'reply_target_missing' };
    }
    const active = this.activeSessionByChat.get(this.chatKey(channelType, chatId));
    if (!active) {
      return { failureReason: 'no_session' };
    }
    return { sessionKey: active };
  }

  /** Check if a specific session can be steered (alive + turn active) */
  canSteerSession(sessionKey: string): boolean {
    const managed = this.registry.get(sessionKey);
    return (managed?.session?.isAlive && managed.session.isTurnActive) ?? false;
  }

  /** Send message to a specific session with SDK native priority */
  async sendToSession(sessionKey: string, text: string, priority: MessagePriority): Promise<boolean> {
    const managed = this.registry.get(sessionKey);
    if (!managed?.session?.isAlive) return false;
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
   * - Otherwise → steer/queue to current default session
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

    if (this.canSteerSession(sessionKey)) {
      const sent = await this.sendToSession(sessionKey, text, 'now');
      return {
        sent,
        mode: sent ? 'steer' : 'none',
        sessionKey,
        failureReason: sent ? undefined : 'send_failed',
      };
    }

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

  /** Get active controls for a chat (legacy /stop wiring). */
  getActiveControls(): Map<string, QueryControls> {
    return this.activeControlsByChat;
  }

  /** Get active controls for a specific chat */
  getControlsForChat(chatKey: string): QueryControls | undefined {
    return this.activeControlsByChat.get(chatKey);
  }

  /** Track controls per session while preserving chat-level compatibility. */
  setControlsForChat(chatKey: string, controls: QueryControls | undefined, sessionKey?: string): void {
    const targetSessionKey = sessionKey ?? this.activeSessionByChat.get(chatKey) ?? chatKey;

    if (controls) {
      this.activeControlsBySession.set(targetSessionKey, controls);
      this.activeControlsByChat.set(chatKey, controls);
      this.controlChatBySession.set(targetSessionKey, chatKey);
      return;
    }

    this.cleanupControlsForSession(targetSessionKey);
  }

  /** Track progress bubble messageId → sessionKey mapping */
  setActiveMessageId(_chatKey: string, messageId: string | undefined, sessionKey?: string): void {
    if (messageId && sessionKey) {
      this.linkBubble(messageId, sessionKey);
    }
  }

  // ── Diagnostics ──

  /** Get number of active (alive) live sessions */
  getActiveSessionCount(): number {
    let count = 0;
    for (const managed of this.registry.values()) {
      if (managed.session?.isAlive) count++;
    }
    return count;
  }

  /** Get number of idle sessions (alive but not turn active) */
  getIdleSessionCount(): number {
    let count = 0;
    for (const managed of this.registry.values()) {
      if (managed.session?.isAlive && !managed.session.isTurnActive) count++;
    }
    return count;
  }

  /** Get total number of bubble mappings */
  getTotalBubbleMappings(): number {
    return this.bubbleToSession.size;
  }

  /** Extract base snapshot fields from a managed session entry */
  private _snapshotSession(key: string, managed: ManagedSession): { sessionKey: string; workdir: string; isAlive: boolean; isTurnActive: boolean; lastActiveAt: number } {
    return {
      sessionKey: key,
      workdir: managed.workdir,
      isAlive: managed.session?.isAlive ?? false,
      isTurnActive: managed.session?.isTurnActive ?? false,
      lastActiveAt: managed.lastActiveAt,
    };
  }

  /** Get all managed sessions for a specific chat (for /home display) */
  getSessionsForChat(channelType: string, chatId: string): ManagedSessionSnapshot[] {
    const currentKey = this.activeSessionByChat.get(this.chatKey(channelType, chatId));
    const results: ManagedSessionSnapshot[] = [];
    for (const [key, managed] of this.registry) {
      if (managed.channelType === channelType && managed.chatId === chatId) {
        results.push({
          ...this._snapshotSession(key, managed),
          bindingSessionId: managed.bindingSessionId,
          sdkSessionId: managed.sdkSessionId,
          isCurrent: key === currentKey,
          queueDepth: this.queueDepthBySession.get(key) ?? 0,
        });
      }
    }
    // Sort: current first, then by lastActiveAt descending
    results.sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      return b.lastActiveAt - a.lastActiveAt;
    });
    return results;
  }

  /** Get session registry snapshot for diagnostics */
  getSessionRegistrySnapshot(): Array<{ sessionKey: string; workdir: string; isAlive: boolean; isTurnActive: boolean; lastActiveAt: number }> {
    const snapshot = [];
    for (const [key, managed] of this.registry) {
      snapshot.push(this._snapshotSession(key, managed));
    }
    return snapshot;
  }
}
