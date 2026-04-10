/**
 * SDKEngine — manages LiveSessions plus steer/queue state for SDK conversations.
 *
 * Core responsibilities:
 * - Session registry: manage LiveSessions per chat+workdir
 * - Steer/Queue: inject messages into active turns or queue for later using SDK native priority
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
  /** Active session per chat: channelType:chatId → sessionKey (for O(1) steer/canSteer) */
  private activeSessionByChat = new Map<string, string>();
  /** Current working card messageId per chat — for legacy steer matching */
  private activeMessageIds = new Map<string, string>();

  // SDK AskUserQuestion state — shared with CallbackRouter via SdkQuestionState interface
  sdkQuestionData = new Map<string, { questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string; preview?: string }>; multiSelect: boolean }>; chatId: string }>();
  sdkQuestionAnswers = new Map<string, number>();
  sdkQuestionTextAnswers = new Map<string, string>();

  /** Idle timeout for LiveSessions (30 minutes) */
  private static SESSION_IDLE_MS = 30 * 60 * 1000;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

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
        continue;
      }
      if (!managed.session.isTurnActive && (now - managed.lastActiveAt) > SDKEngine.SESSION_IDLE_MS) {
        console.log(`[tlive:engine] Pruning idle LiveSession: ${key} (idle ${Math.round((now - managed.lastActiveAt) / 60000)}m)`);
        managed.session.close();
        this.registry.delete(key);
      }
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

  /** Check if there's an active session for this chat (for steer/queue) */
  hasActiveSession(channelType: string, chatId: string): boolean {
    const sessionKey = this.activeSessionByChat.get(`${channelType}:${chatId}`);
    if (!sessionKey) return false;
    const managed = this.registry.get(sessionKey);
    return managed?.session.isAlive ?? false;
  }

  /** Send message with SDK native priority. Returns true if sent, false if no session. */
  async sendWithPriority(channelType: string, chatId: string, text: string, priority: MessagePriority): Promise<boolean> {
    const sessionKey = this.activeSessionByChat.get(`${channelType}:${chatId}`);
    if (!sessionKey) return false;
    const managed = this.registry.get(sessionKey);
    if (!managed?.session.isAlive) return false;
    try {
      await managed.session.sendWithPriority(text, priority);
      return true;
    } catch (err) {
      console.error(`[tlive:engine] sendWithPriority error:`, err);
      return false;
    }
  }

  /** Steer the active turn using SDK native priority='now' */
  async steer(channelType: string, chatId: string, text: string): Promise<boolean> {
    return this.sendWithPriority(channelType, chatId, text, 'now');
  }

  /** Queue message using SDK native priority='later' */
  async queue(channelType: string, chatId: string, text: string): Promise<boolean> {
    return this.sendWithPriority(channelType, chatId, text, 'later');
  }

  // Legacy methods kept for backwards compatibility during transition
  /** @deprecated Use sendWithPriority instead */
  canSteer(channelType: string, chatId: string, replyToMessageId?: string): boolean {
    const chatKey = this.state.stateKey(channelType, chatId);
    const activeId = this.activeMessageIds.get(chatKey);
    if (!replyToMessageId || !activeId || replyToMessageId !== activeId) return false;
    // O(1) lookup: check active session for this chat
    const sessionKey = this.activeSessionByChat.get(`${channelType}:${chatId}`);
    if (!sessionKey) return false;
    const managed = this.registry.get(sessionKey);
    return managed?.session.isTurnActive ?? false;
  }

  /** @deprecated Use steer() async version instead */
  steerSync(channelType: string, chatId: string, text: string): void {
    // O(1) lookup: get active session for this chat
    const sessionKey = this.activeSessionByChat.get(`${channelType}:${chatId}`);
    if (!sessionKey) return;
    const managed = this.registry.get(sessionKey);
    if (managed?.session.isTurnActive) {
      managed.session.steerTurn(text);
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

  /** Track active message ID for steer matching */
  setActiveMessageId(chatKey: string, messageId: string | undefined): void {
    if (messageId) {
      this.activeMessageIds.set(chatKey, messageId);
    } else {
      this.activeMessageIds.delete(chatKey);
    }
  }

}
