/**
 * SDKEngine — manages LiveSessions plus steer/queue state for SDK conversations.
 *
 * Core responsibilities:
 * - Orchestrate SessionManager for session lifecycle
 * - Orchestrate QueueManager for queue tracking
 * - Steer/Queue: inject messages into active turns or queue for later using SDK native priority
 * - Controls management for cancellation
 *
 * This module delegates session management to SessionManager and queue tracking to QueueManager.
 */

import type { QueryControls, LiveSession, MessagePriority } from '../../providers/base.js';
import type { ClaudeSDKProvider } from '../../providers/claude-sdk.js';
import type { ClaudeSettingSource } from '../../config.js';
import type { EffortLevel } from '../../utils/types.js';
import type { ManagedSessionSnapshot } from '../../formatting/message-types.js';
import { InteractionState, type SdkQuestionState } from '../state/interaction-state.js';
import { SessionManager, type ManagedSession, type SessionCleanupReason } from './session-manager.js';
import { QueueManager, type QueueStats } from './queue-manager.js';

// Re-export for backward compatibility
export type { SessionCleanupReason } from './session-manager.js';
export type { QueueStats } from './queue-manager.js';

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

export interface ResolvedSessionTarget {
  sessionKey: string;
  bindingSessionId: string;
  workdir: string;
  sdkSessionId?: string;
  source: 'reply' | 'current';
}

/** Handles shared SDK session state for live turns and follow-up steering.
 *
 * Provider-agnostic — works with both Claude SDK (LiveSession) and fallback streamChat.
 */
export class SDKEngine {
  private sessions: SessionManager;
  private queues: QueueManager;

  private activeControlsBySession = new Map<string, QueryControls>();
  private activeControlsByChat = new Map<string, QueryControls>();
  private controlChatBySession = new Map<string, string>();

  // SDK AskUserQuestion state — shared with routing / callbacks via InteractionState.
  private interactions = new InteractionState();

  /** Optional callback after an idle live session is pruned */
  onSessionPruned?: (sessionKey: string) => void;
  /** Optional callback when a new LiveSession is created (for tracking recent projects) */
  onSessionCreated?: (sessionKey: string, workdir: string) => void;

  constructor() {
    this.sessions = new SessionManager();
    this.queues = new QueueManager();
    // Forward the pruning callback
    this.sessions.onSessionPruned = (sessionKey: string) => {
      this.onSessionPruned?.(sessionKey);
    };
    // Forward the session creation callback
    this.sessions.onSessionCreated = (sessionKey: string, workdir: string) => {
      this.onSessionCreated?.(sessionKey, workdir);
    };
  }

  // ── Session Pruning (delegated) ──

  /** Start periodic cleanup of idle LiveSessions */
  startSessionPruning(): void {
    this.sessions.startSessionPruning();
  }

  /** Stop periodic cleanup */
  stopSessionPruning(): void {
    this.sessions.stopSessionPruning();
  }

  // ── Session Registry (delegated) ──

  getSessionKeyForBinding(channelType: string, chatId: string, bindingSessionId: string): string {
    return this.sessions.getSessionKeyForBinding(channelType, chatId, bindingSessionId);
  }

  registerSessionContext(
    channelType: string,
    chatId: string,
    bindingSessionId: string,
    workdir: string,
    sdkSessionId?: string,
    opts?: { setAsCurrent?: boolean },
  ): string {
    return this.sessions.registerSessionContext(channelType, chatId, bindingSessionId, workdir, sdkSessionId, opts);
  }

  hasSessionContext(channelType: string, chatId: string, bindingSessionId: string): boolean {
    return this.sessions.hasSessionContext(channelType, chatId, bindingSessionId);
  }

  getSessionContext(sessionKey: string): ManagedSession | undefined {
    return this.sessions.getSessionContext(sessionKey);
  }

  updateSessionSdkSessionId(sessionKey: string, sdkSessionId?: string): void {
    this.sessions.updateSessionSdkSessionId(sessionKey, sdkSessionId);
  }

  resolveSessionTarget(
    channelType: string,
    chatId: string,
    binding: { sessionId: string; cwd?: string; sdkSessionId?: string },
    defaultWorkdir: string,
    replyToMessageId?: string,
  ): { target?: ResolvedSessionTarget; failureReason?: SendWithContextResult['failureReason'] } {
    if (replyToMessageId) {
      const sessionKey = this.sessions.getSessionForBubble(replyToMessageId);
      if (!sessionKey) {
        return { failureReason: 'reply_target_missing' };
      }
      const managed = this.sessions.getSessionContext(sessionKey);
      if (!managed) {
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
    const sessionKey = this.sessions.registerSessionContext(
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
    return this.sessions.resetSessionRuntime(sessionKey, reason);
  }

  /** Close a session (explicit cleanup). */
  closeSession(channelType: string, chatId: string, workdir?: string): void {
    this.sessions.closeSession(
      channelType,
      chatId,
      workdir,
      (sessionKey: string) => this.queues.cleanupQueueForSession(sessionKey),
      (sessionKey: string) => this.cleanupControlsForSession(sessionKey),
    );
  }

  private cleanupControlsForSession(sessionKey: string): void {
    this.activeControlsBySession.delete(sessionKey);
    const chatKey = this.controlChatBySession.get(sessionKey);
    if (!chatKey) return;
    this.controlChatBySession.delete(sessionKey);

    // Try to find fallback from the current default session
    const defaultSessionKey = this.sessions.getActiveSessionKey(
      chatKey.split(':')[0],
      chatKey.split(':')[1],
    );
    if (defaultSessionKey) {
      const defaultCtrl = this.activeControlsBySession.get(defaultSessionKey);
      if (defaultCtrl) {
        this.activeControlsByChat.set(chatKey, defaultCtrl);
        return;
      }
    }

    this.activeControlsByChat.delete(chatKey);
  }

  /**
   * Unified session cleanup with reason logging.
   * Cleanup removes reply-routing state; use resetSessionRuntime() to preserve resume metadata.
   */
  cleanupSession(channelType: string, chatId: string, reason: SessionCleanupReason, workdir?: string): boolean {
    return this.sessions.cleanupSession(
      channelType,
      chatId,
      reason,
      workdir,
      (sessionKey: string) => this.queues.cleanupQueueForSession(sessionKey),
      (sessionKey: string) => this.cleanupControlsForSession(sessionKey),
    );
  }

  /**
   * Check if a live session exists and is alive for the given chat/workdir.
   */
  hasActiveSession(channelType: string, chatId: string, workdir?: string): boolean {
    return this.sessions.hasActiveSession(channelType, chatId, workdir);
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
    const actualBindingSessionId = typeof workdirOrOptions === 'string'
      ? bindingSessionIdOrWorkdir
      : bindingSessionIdOrWorkdir;
    const actualWorkdir = typeof workdirOrOptions === 'string'
      ? workdirOrOptions
      : bindingSessionIdOrWorkdir;
    const actualOptions = (typeof workdirOrOptions === 'string' ? maybeOptions : workdirOrOptions) ?? {};

    return this.sessions.getOrCreateSession(
      llm,
      channelType,
      chatId,
      actualBindingSessionId,
      actualWorkdir,
      actualOptions,
      (_sessionKey: string) => {},
      (sessionKey: string) => this.queues.getQueueDepth(sessionKey),
      (sessionKey: string) => this.queues.decrementQueueDepth(sessionKey),
      (sessionKey: string) => this.queues.cleanupQueueForSession(sessionKey),
      (sessionKey: string) => this.cleanupControlsForSession(sessionKey),
    );
  }

  // ── Queue Depth Management (delegated) ──

  /** Get the max queue depth (configurable) */
  getMaxQueueDepth(): number {
    return this.queues.getMaxQueueDepth();
  }

  /** Set the max queue depth (configurable) */
  setMaxQueueDepth(depth: number): void {
    this.queues.setMaxQueueDepth(depth);
  }

  /** Get current queue depth for a session */
  getQueueDepth(sessionKey: string): number {
    return this.queues.getQueueDepth(sessionKey);
  }

  /** Check if queue is full for a session */
  isQueueFull(sessionKey: string): boolean {
    return this.queues.isQueueFull(sessionKey);
  }

  /** Get queued message previews for a session */
  getQueuedMessages(sessionKey: string): { preview: string; timestamp: number }[] {
    return this.queues.getQueuedMessages(sessionKey);
  }

  /** Clear all queued messages for a session */
  clearQueue(sessionKey: string): number {
    return this.queues.clearQueue(sessionKey);
  }

  /** Get queue statistics for all sessions */
  getAllQueueStats(): QueueStats[] {
    return this.queues.getAllQueueStats();
  }

  /** Get total queued messages across all sessions */
  getTotalQueuedMessages(): number {
    return this.queues.getTotalQueuedMessages();
  }

  /** Decrement queue depth when a queued message is consumed */
  decrementQueueDepth(sessionKey: string): void {
    this.queues.decrementQueueDepth(sessionKey);
  }

  /**
   * Get queue info for a session: { depth, max }.
   * Returns undefined if session doesn't exist or has no queue.
   */
  getQueueInfo(sessionKey: string): { depth: number; max: number } | undefined {
    return this.queues.getQueueInfo(sessionKey);
  }

  // ── Session Stale Detection (delegated) ──

  /** Check if a live session is stale (inactive for too long). */
  isSessionStale(sessionKey: string): boolean {
    return this.sessions.isSessionStale(sessionKey);
  }

  /** Check if a chat's current default session is stale. */
  isChatSessionStale(channelType: string, chatId: string): boolean {
    return this.sessions.isChatSessionStale(channelType, chatId);
  }

  /** Get the last active timestamp for a session. */
  getSessionLastActiveAt(sessionKey: string): number | undefined {
    return this.sessions.getSessionLastActiveAt(sessionKey);
  }

  /** Get the current default session key for a chat. */
  getActiveSessionKey(channelType: string, chatId: string): string | undefined {
    return this.sessions.getActiveSessionKey(channelType, chatId);
  }

  /**
   * Get session key for a bubble (replyToMessageId).
   * Returns undefined if the logical session no longer exists.
   */
  getSessionForBubble(messageId: string): string | undefined {
    return this.sessions.getSessionForBubble(messageId);
  }

  // ── Steer / Queue ──

  /** Check if a specific session can be steered (alive + turn active) */
  canSteerSession(sessionKey: string): boolean {
    const managed = this.sessions.getSessionContext(sessionKey);
    return (managed?.session?.isAlive && managed.session.isTurnActive) ?? false;
  }

  /** Send message to a specific session with SDK native priority */
  async sendToSession(sessionKey: string, text: string, priority: MessagePriority): Promise<boolean> {
    const managed = this.sessions.getSessionContext(sessionKey);
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

  private resolveTargetSessionWithReason(
    channelType: string,
    chatId: string,
    replyToMessageId?: string,
  ): { sessionKey?: string; failureReason?: SendWithContextResult['failureReason'] } {
    if (replyToMessageId) {
      const bubbleSession = this.sessions.getSessionForBubble(replyToMessageId);
      if (bubbleSession) {
        return { sessionKey: bubbleSession };
      }
      return { failureReason: 'reply_target_missing' };
    }
    const active = this.sessions.getActiveSessionKey(channelType, chatId);
    if (!active) {
      return { failureReason: 'no_session' };
    }
    return { sessionKey: active };
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

    if (this.queues.isQueueFull(sessionKey)) {
      console.log(`[tlive:engine] Queue full for ${sessionKey}, rejecting message`);
      return {
        sent: false,
        mode: 'queue',
        sessionKey,
        queueFull: true,
        queueDepth: this.queues.getQueueDepth(sessionKey),
        maxQueueDepth: this.queues.getMaxQueueDepth(),
      };
    }

    const sent = await this.sendToSession(sessionKey, text, 'later');
    if (sent) {
      const queuePosition = this.queues.incrementQueueDepth(sessionKey, text);
      return {
        sent: true,
        mode: 'queue',
        sessionKey,
        queuePosition,
        queueDepth: queuePosition,
        maxQueueDepth: this.queues.getMaxQueueDepth(),
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
    const targetSessionKey = sessionKey ?? this.sessions.getActiveSessionKey(chatKey.split(':')[0], chatKey.split(':')[1]) ?? chatKey;

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
      this.sessions.linkBubble(messageId, sessionKey);
    }
  }

  // ── Diagnostics ──

  /** Get number of active (alive) live sessions */
  getActiveSessionCount(): number {
    return this.sessions.getActiveSessionCount();
  }

  /** Get number of idle sessions (alive but not turn active) */
  getIdleSessionCount(): number {
    return this.sessions.getIdleSessionCount();
  }

  /** Get total number of bubble mappings */
  getTotalBubbleMappings(): number {
    return this.sessions.getTotalBubbleMappings();
  }

  /** Get all managed sessions for a specific chat (for /home display) */
  getSessionsForChat(channelType: string, chatId: string): ManagedSessionSnapshot[] {
    return this.sessions.getSessionsForChat(channelType, chatId, (sk) => this.queues.getQueueDepth(sk));
  }

  /** Get session registry snapshot for diagnostics */
  getSessionRegistrySnapshot(): Array<{ sessionKey: string; workdir: string; isAlive: boolean; isTurnActive: boolean; lastActiveAt: number }> {
    return this.sessions.getSessionRegistrySnapshot();
  }
}