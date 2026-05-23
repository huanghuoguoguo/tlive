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

import type {
  AgentProvider,
  QueryControls,
  LiveSession,
  MessagePriority,
} from '../../../shared/providers/base.js';
import type { AgentProviderKind } from '../../../shared/providers/kinds.js';
import { InteractionState, type SdkQuestionState } from '../state/interaction-state.js';
import {
  SessionManager,
  type ManagedSession,
  type ManagedSessionCreateRequest,
  type ManagedSessionSnapshot,
  type SessionCleanupReason,
  type SessionLifecycleHooks,
} from './session-manager.js';
import { QueueManager, type QueueStats } from './queue-manager.js';
import { splitChatKey } from '../../../shared/core/key.js';
import type { DeliveryRoute, FileDeliveryRoute } from '../../channels/delivery-route.js';
import { TurnControlRegistry, type TurnControlCleanupOptions } from './turn-control-registry.js';
import { FileDeliveryRegistry } from './file-delivery-registry.js';

// Re-export for backward compatibility
export type { SessionCleanupReason } from './session-manager.js';
export type { QueueStats } from './queue-manager.js';

/** Result of sendWithContext operation */
export interface SendWithContextResult {
  sent: boolean;
  mode: 'steer' | 'queue' | 'none';
  sessionKey?: string;
  /** Why sending failed when sent=false */
  failureReason?: 'no_session' | 'reply_target_missing' | 'send_failed' | 'busy_unsupported';
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
  provider?: AgentProviderKind;
  clientId?: string;
  source: 'reply' | 'current';
}

/** Handles shared SDK session state for live turns and follow-up steering.
 *
 * Provider-agnostic — works with both persistent LiveSession and fallback streamChat.
 */
export class SDKEngine {
  private sessions: SessionManager;
  private queues: QueueManager;
  private turnControls: TurnControlRegistry;
  private fileDelivery: FileDeliveryRegistry;

  // SDK AskUserQuestion state — shared with routing / callbacks via InteractionState.
  private interactions = new InteractionState();

  /** Optional callback after an idle live session is pruned */
  onSessionPruned?: (sessionKey: string) => void;
  /** Optional callback when a new LiveSession is created (for tracking recent projects) */
  onSessionCreated?: (sessionKey: string, workdir: string) => void;

  constructor() {
    this.sessions = new SessionManager();
    this.queues = new QueueManager();
    this.turnControls = new TurnControlRegistry();
    this.fileDelivery = new FileDeliveryRegistry();
    // Forward the pruning callback
    this.sessions.onSessionPruned = (sessionKey: string) => {
      this.onSessionPruned?.(sessionKey);
    };
    // Forward the session creation callback
    this.sessions.onSessionCreated = (sessionKey: string, workdir: string) => {
      this.onSessionCreated?.(sessionKey, workdir);
    };
  }

  private sessionLifecycleHooks(): SessionLifecycleHooks {
    return {
      getQueueDepth: (sessionKey: string) => this.queues.getQueueDepth(sessionKey),
      decrementQueueDepth: (sessionKey: string) => this.queues.decrementQueueDepth(sessionKey),
      cleanupQueue: (sessionKey: string) => this.queues.cleanupQueueForSession(sessionKey),
      cleanupControls: (sessionKey: string) => this.cleanupControlsForSession(sessionKey),
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
    opts?: { setAsCurrent?: boolean; provider?: AgentProviderKind },
  ): string {
    return this.sessions.registerSessionContext(
      channelType,
      chatId,
      bindingSessionId,
      workdir,
      sdkSessionId,
      opts,
    );
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

  moveSessionToChat(sessionKey: string, newChatId: string): string | undefined {
    const newSessionKey = this.sessions.moveSessionToChat(sessionKey, newChatId);
    if (!newSessionKey || newSessionKey === sessionKey) return newSessionKey;

    this.queues.moveSessionKey(sessionKey, newSessionKey);

    const managed = this.sessions.getSessionContext(newSessionKey);
    const newChatKey = managed
      ? this.sessions.chatKey(managed.channelType, managed.chatId)
      : undefined;
    this.turnControls.moveSession(sessionKey, newSessionKey, newChatKey);

    return newSessionKey;
  }

  resolveSessionTarget(
    channelType: string,
    chatId: string,
    binding: {
      sessionId: string;
      cwd?: string;
      sdkSessionId?: string;
      provider?: AgentProviderKind;
      clientId?: string;
    },
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
          provider: managed.provider,
          clientId: managed.clientId,
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
      { setAsCurrent: true, provider: binding.provider, clientId: binding.clientId },
    );
    return {
      target: {
        sessionKey,
        bindingSessionId: binding.sessionId,
        workdir,
        sdkSessionId: binding.sdkSessionId,
          provider: binding.provider,
          clientId: binding.clientId,
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
    this.sessions.closeSession(channelType, chatId, workdir, this.sessionLifecycleHooks());
  }

  private cleanupControlsForSession(sessionKey: string): void {
    this.turnControls.cleanupSessionControls(sessionKey, this.turnControlCleanupOptions());
  }

  /**
   * Unified session cleanup with reason logging.
   * Cleanup removes reply-routing state; use resetSessionRuntime() to preserve resume metadata.
   */
  cleanupSession(
    channelType: string,
    chatId: string,
    reason: SessionCleanupReason,
    workdir?: string,
  ): boolean {
    return this.sessions.cleanupSession(
      channelType,
      chatId,
      reason,
      workdir,
      this.sessionLifecycleHooks(),
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
   * Returns the session, or undefined if the registry cannot create one.
   */
  getOrCreateSession(
    llm: AgentProvider,
    request: Omit<ManagedSessionCreateRequest, 'hooks'>,
  ): LiveSession | undefined {
    return this.sessions.getOrCreateSession(llm, {
      ...request,
      hooks: this.sessionLifecycleHooks(),
    });
  }

  // ── Queue Depth Management (delegated) ──

  /** Get the max queue depth (configurable) */
  getMaxQueueDepth(): number {
    return this.queues.getMaxQueueDepth();
  }

  /** Get queue statistics for all sessions */
  getAllQueueStats(): QueueStats[] {
    return this.queues.getAllQueueStats();
  }

  /** Get total queued messages across all sessions */
  getTotalQueuedMessages(): number {
    return this.queues.getTotalQueuedMessages();
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
    return (
      (managed?.session?.isAlive &&
        managed.session.isTurnActive &&
        this.supportsNativePriority(managed.session, 'now')) ??
      false
    );
  }

  /** Send message to a specific session with SDK native priority */
  async sendToSession(
    sessionKey: string,
    text: string,
    priority: MessagePriority,
  ): Promise<boolean> {
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

    const managed = this.sessions.getSessionContext(sessionKey);
    if (managed?.session?.isTurnActive && !this.supportsNativePriority(managed.session, 'later')) {
      return {
        sent: false,
        mode: 'none',
        sessionKey,
        failureReason: 'busy_unsupported',
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

  private supportsNativePriority(session: LiveSession, priority: MessagePriority): boolean {
    if (priority === 'now') return session.capabilities?.nativeSteer ?? true;
    return session.capabilities?.nativeQueue ?? true;
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
    return this.turnControls.getActiveControls();
  }

  /** Get active controls for a specific chat */
  getControlsForChat(chatKey: string): QueryControls | undefined {
    return this.turnControls.getControlsForChat(chatKey);
  }

  /** Get active controls for a specific logical session. */
  getControlsForSession(sessionKey: string): QueryControls | undefined {
    return this.turnControls.getControlsForSession(sessionKey);
  }

  async interruptSession(sessionKey: string): Promise<boolean> {
    const ctrl = this.turnControls.consumeSessionControls(
      sessionKey,
      this.turnControlCleanupOptions(),
    );
    if (!ctrl) return false;
    await ctrl.interrupt();
    return true;
  }

  async interruptChat(chatKey: string): Promise<boolean> {
    const ctrl = this.turnControls.consumeChatControls(chatKey, this.turnControlCleanupOptions());
    if (!ctrl) return false;
    await ctrl.interrupt();
    return true;
  }

  /** Track controls per session while preserving chat-level compatibility. */
  setControlsForChat(
    chatKey: string,
    controls: QueryControls | undefined,
    sessionKey?: string,
  ): void {
    const { channelType, chatId } = splitChatKey(chatKey);
    const targetSessionKey =
      sessionKey ?? this.sessions.getActiveSessionKey(channelType, chatId) ?? chatKey;

    this.turnControls.setControlsForChat(
      chatKey,
      controls,
      targetSessionKey,
      this.turnControlCleanupOptions(),
    );
  }

  private turnControlCleanupOptions(): TurnControlCleanupOptions {
    return {
      resolveFallbackSessionKey: (chatKey: string) => {
        const { channelType, chatId } = splitChatKey(chatKey);
        return this.sessions.getActiveSessionKey(channelType, chatId);
      },
    };
  }

  registerFileDeliveryRoute(sessionKey: string, route: DeliveryRoute, cwd: string): string {
    return this.fileDelivery.register(sessionKey, route, cwd);
  }

  resolveFileDeliveryToken(token: string): FileDeliveryRoute | undefined {
    return this.fileDelivery.resolve(token);
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
    return this.sessions.getSessionsForChat(channelType, chatId, (sk) =>
      this.queues.getQueueDepth(sk),
    );
  }

  /** Get session registry snapshot for diagnostics */
  getSessionRegistrySnapshot(): Array<{
    sessionKey: string;
    workdir: string;
    isAlive: boolean;
    isTurnActive: boolean;
    lastActiveAt: number;
  }> {
    return this.sessions.getSessionRegistrySnapshot();
  }
}
