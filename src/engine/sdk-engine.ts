/**
 * SDKEngine — manages LiveSessions plus steer/queue state for SDK conversations.
 *
 * Core responsibilities:
 * - Session registry: manage LiveSessions per chat+workdir
 * - Steer/Queue: inject messages into active turns or queue for later using SDK native priority
 * - Bubble tracking: map progress bubble messageId to session for multi-session steering
 */

import type { QueryControls, LiveSession, LLMProvider, MessagePriority } from '../providers/base.js';
import type { SessionStateManager } from './session-state.js';
import type { ChannelRouter } from './router.js';
import type { EffortLevel } from '../utils/types.js';

/** Shared SDK question state — owned by SDKEngine, read/written by CallbackRouter */
export interface SdkQuestionState {
  sdkQuestionData: Map<string, { questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string; preview?: string }>; multiSelect: boolean }>; chatId: string }>;
  sdkQuestionAnswers: Map<string, number>;
  sdkQuestionTextAnswers: Map<string, string>;
}

/** Managed session — wraps a LiveSession with per-chat metadata */
interface ManagedSession {
  session: LiveSession;
  workdir: string;
  lastActiveAt: number;
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

  // SDK AskUserQuestion state — shared with CallbackRouter via SdkQuestionState interface
  sdkQuestionData = new Map<string, { questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string; preview?: string }>; multiSelect: boolean }>; chatId: string }>();
  sdkQuestionAnswers = new Map<string, number>();
  sdkQuestionTextAnswers = new Map<string, string>();

  /** Idle timeout for LiveSessions (30 minutes) */
  private static SESSION_IDLE_MS = 30 * 60 * 1000;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  /** Optional callback to clean up permission whitelist when session is pruned */
  onSessionPruned?: (sessionKey: string) => void;

  constructor(
    private state: SessionStateManager,
    _router: ChannelRouter,
  ) {}

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
        continue;
      }
      if (!managed.session.isTurnActive && (now - managed.lastActiveAt) > SDKEngine.SESSION_IDLE_MS) {
        console.log(`[tlive:engine] Pruning idle LiveSession: ${key} (idle ${Math.round((now - managed.lastActiveAt) / 60000)}m)`);
        managed.session.close();
        this.registry.delete(key);
        this.cleanupBubblesForSession(key);
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

  // ── Session Registry ──

  /** Build session key: channelType:chatId:workdir */
  private sessionKey(channelType: string, chatId: string, workdir: string): string {
    return `${channelType}:${chatId}:${workdir}`;
  }

  /** Close a session (on /new, session expiry, workdir change) */
  closeSession(channelType: string, chatId: string, workdir?: string): void {
    const chatKey = `${channelType}:${chatId}`;
    if (workdir) {
      const key = this.sessionKey(channelType, chatId, workdir);
      const managed = this.registry.get(key);
      if (managed) {
        managed.session.close();
        this.registry.delete(key);
        this.cleanupBubblesForSession(key);
        if (this.activeSessionByChat.get(chatKey) === key) {
          this.activeSessionByChat.delete(chatKey);
        }
        console.log(`[tlive:engine] Closed LiveSession for ${key}`);
      }
    } else {
      // Close ALL sessions for this chat (e.g. on /new)
      const prefix = `${channelType}:${chatId}:`;
      for (const [key, managed] of this.registry) {
        if (key.startsWith(prefix)) {
          managed.session.close();
          this.registry.delete(key);
          this.cleanupBubblesForSession(key);
          console.log(`[tlive:engine] Closed LiveSession for ${key}`);
        }
      }
      this.activeSessionByChat.delete(chatKey);
    }
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
    options?: { sessionId?: string; effort?: EffortLevel; model?: string },
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
    });

    this.registry.set(key, { session, workdir, lastActiveAt: Date.now() });
    this.activeSessionByChat.set(chatKey, key);
    return session;
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

  /**
   * Resolve target session for a message.
   * - If replyToMessageId is provided and tracked → use that session
   * - Otherwise → use activeSessionByChat (most recent)
   */
  resolveTargetSession(channelType: string, chatId: string, replyToMessageId?: string): string | undefined {
    // Priority 1: reply to specific bubble
    if (replyToMessageId) {
      const bubbleSession = this.getSessionForBubble(replyToMessageId);
      if (bubbleSession) return bubbleSession;
    }
    // Priority 2: fallback to most recent session
    return this.activeSessionByChat.get(`${channelType}:${chatId}`);
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
   */
  async sendWithContext(
    channelType: string,
    chatId: string,
    text: string,
    replyToMessageId?: string,
  ): Promise<{ sent: boolean; mode: 'steer' | 'queue' | 'none'; sessionKey?: string }> {
    const sessionKey = this.resolveTargetSession(channelType, chatId, replyToMessageId);
    if (!sessionKey) {
      return { sent: false, mode: 'none' };
    }

    // Steer if turn active, queue otherwise
    if (this.canSteerSession(sessionKey)) {
      const sent = await this.sendToSession(sessionKey, text, 'now');
      return { sent, mode: 'steer', sessionKey };
    } else {
      const sent = await this.sendToSession(sessionKey, text, 'later');
      return { sent, mode: 'queue', sessionKey };
    }
  }

  // ── Shared State (CallbackRouter, /stop) ──

  /** Expose question state for CallbackRouter */
  getQuestionState(): SdkQuestionState {
    return {
      sdkQuestionData: this.sdkQuestionData,
      sdkQuestionAnswers: this.sdkQuestionAnswers,
      sdkQuestionTextAnswers: this.sdkQuestionTextAnswers,
    };
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
  setActiveMessageId(chatKey: string, messageId: string | undefined, sessionKey?: string): void {
    if (messageId && sessionKey) {
      this.linkBubble(messageId, sessionKey);
    }
  }

}
