/**
 * SessionManager — handles session lifecycle, registry, and bubble tracking.
 *
 * Extracted from SDKEngine for single responsibility:
 * - Session registry: manage LiveSessions per logical chat session
 * - Bubble tracking: map progress bubble messageId to session
 * - Session pruning: idle timeout detection and cleanup
 */

import type { LiveSession } from '../../providers/base.js';
import type { ClaudeSDKProvider } from '../../providers/claude-sdk.js';
import type { ClaudeSettingSource } from '../../config.js';
import type { EffortLevel } from '../../utils/types.js';
import { SESSION_STALE_THRESHOLD_MS } from '../../engine/constants.js';
import { chatKey as buildChatKey } from '../../core/key.js';

/** Reason for closing a session — used for logging and diagnostics */
export type SessionCleanupReason = 'new' | 'switch' | 'cd' | 'settings' | 'expire' | 'close';

/** Managed session — wraps a LiveSession with per-chat metadata */
export interface ManagedSession {
  channelType: string;
  chatId: string;
  bindingSessionId: string;
  workdir: string;
  sdkSessionId?: string;
  lastActiveAt: number;
  session?: LiveSession;
}

/** Snapshot for diagnostics and /home display */
export interface ManagedSessionSnapshot {
  sessionKey: string;
  workdir: string;
  isAlive: boolean;
  isTurnActive: boolean;
  lastActiveAt: number;
  bindingSessionId: string;
  sdkSessionId?: string;
  isCurrent: boolean;
  queueDepth: number;
}

/**
 * SessionManager handles the lifecycle and registry of LiveSessions.
 */
export class SessionManager {
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

  /** Idle timeout for LiveSessions (30 minutes) */
  private static SESSION_IDLE_MS = 30 * 60 * 1000;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  /** Optional callback after an idle live session is pruned */
  onSessionPruned?: (sessionKey: string) => void;

  // ── Key Building ──

  /** Build chat key: channelType:chatId */
  chatKey(channelType: string, chatId: string): string {
    return buildChatKey(channelType, chatId);
  }

  /** Build session key: channelType:chatId:bindingSessionId */
  sessionKey(channelType: string, chatId: string, bindingSessionId: string): string {
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

  // ── Pruning ──

  /** Start periodic cleanup of idle LiveSessions */
  startSessionPruning(): void {
    this.pruneTimer = setInterval(() => this.pruneIdleSessions(), 60_000);
  }

  /** Stop periodic cleanup */
  stopSessionPruning(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  /** Close only the in-memory LiveSession for idle sessions, but keep logical routing metadata. */
  private pruneIdleSessions(): void {
    const now = Date.now();
    for (const [key, managed] of this.registry) {
      if (!managed.session?.isAlive) {
        managed.session = undefined;
        continue;
      }
      if (!managed.session.isTurnActive && (now - managed.lastActiveAt) > SessionManager.SESSION_IDLE_MS) {
        console.log(`[tlive:engine] Pruning idle LiveSession: ${key} (idle ${Math.round((now - managed.lastActiveAt) / 60000)}m)`);
        this.closeLiveSession(key, 'close', { preserveContext: true, preserveBubbles: true });
        this.onSessionPruned?.(key);
      }
    }
  }

  // ── Bubble Tracking ──

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

  /** Internal: link bubble messageId to session, maintaining reverse index and cap */
  linkBubble(messageId: string, sessionKey: string): void {
    if (this.bubbleToSession.size >= SessionManager.MAX_BUBBLE_MAPPINGS) {
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

  /** Get total number of bubble mappings */
  getTotalBubbleMappings(): number {
    return this.bubbleToSession.size;
  }

  // ── Session Registry ──

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

  getActiveSessionKey(channelType: string, chatId: string): string | undefined {
    return this.activeSessionByChat.get(this.chatKey(channelType, chatId));
  }

  setActiveSessionKey(channelType: string, chatId: string, sessionKey: string): void {
    this.activeSessionByChat.set(this.chatKey(channelType, chatId), sessionKey);
  }

  /** Close a session runtime but keep logical context available for future resume. */
  resetSessionRuntime(sessionKey: string, reason: SessionCleanupReason): boolean {
    return this.closeLiveSession(sessionKey, reason, { preserveContext: true, preserveBubbles: true });
  }

  /** Close a session (explicit cleanup). Delegates to cleanupSession. */
  closeSession(
    channelType: string,
    chatId: string,
    workdir?: string,
    cleanupQueue?: (sessionKey: string) => void,
    cleanupControls?: (sessionKey: string) => void,
  ): void {
    this.cleanupSession(channelType, chatId, 'close', workdir, cleanupQueue, cleanupControls);
  }

  closeLiveSession(
    sessionKey: string,
    reason: SessionCleanupReason,
    opts: { preserveContext: boolean; preserveBubbles: boolean },
    cleanupQueue?: (sessionKey: string) => void,
    cleanupControls?: (sessionKey: string) => void,
  ): boolean {
    const managed = this.registry.get(sessionKey);
    if (!managed) return false;

    if (managed.session?.isAlive) {
      managed.session.close();
    }
    managed.session = undefined;
    cleanupQueue?.(sessionKey);
    cleanupControls?.(sessionKey);

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
  cleanupSession(
    channelType: string,
    chatId: string,
    reason: SessionCleanupReason,
    workdir?: string,
    cleanupQueue?: (sessionKey: string) => void,
    cleanupControls?: (sessionKey: string) => void,
  ): boolean {
    let closed = false;
    for (const [key] of this.filterSessions(channelType, chatId, workdir)) {
      closed = this.closeLiveSession(key, reason, { preserveContext: false, preserveBubbles: false }, cleanupQueue, cleanupControls) || closed;
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
    llm: ClaudeSDKProvider,
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
    llm: ClaudeSDKProvider,
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
    llm: ClaudeSDKProvider,
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
    onTurnComplete?: (sessionKey: string) => void,
    getQueueDepth?: (sessionKey: string) => number,
    decrementQueueDepth?: (sessionKey: string) => void,
    cleanupQueue?: (sessionKey: string) => void,
    cleanupControls?: (sessionKey: string) => void,
  ): LiveSession | undefined;
  getOrCreateSession(
    llm: ClaudeSDKProvider,
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
    _onTurnComplete?: (sessionKey: string) => void,
    getQueueDepth?: (sessionKey: string) => number,
    decrementQueueDepth?: (sessionKey: string) => void,
    cleanupQueue?: (sessionKey: string) => void,
    cleanupControls?: (sessionKey: string) => void,
  ): LiveSession | undefined {
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
      cleanupQueue?.(key);
      cleanupControls?.(key);
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
        if (getQueueDepth && decrementQueueDepth && getQueueDepth(key) > 0) {
          decrementQueueDepth(key);
        }
      },
    });
    this.activeSessionByChat.set(this.chatKey(channelType, chatId), key);
    return session;
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
  getSessionsForChat(channelType: string, chatId: string, getQueueDepth: (sessionKey: string) => number): ManagedSessionSnapshot[] {
    const currentKey = this.activeSessionByChat.get(this.chatKey(channelType, chatId));
    const results: ManagedSessionSnapshot[] = [];
    for (const [key, managed] of this.registry) {
      if (managed.channelType === channelType && managed.chatId === chatId) {
        results.push({
          ...this._snapshotSession(key, managed),
          bindingSessionId: managed.bindingSessionId,
          sdkSessionId: managed.sdkSessionId,
          isCurrent: key === currentKey,
          queueDepth: getQueueDepth(key),
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