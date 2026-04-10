/**
 * SDKEngine — manages LiveSessions plus steer/queue state for SDK conversations.
 *
 * Core responsibilities:
 * - Session registry: manage LiveSessions per chat+workdir
 * - Steer/Queue: inject messages into active turns or queue for later
 */

import type { InboundMessage } from '../channels/types.js';
import type { QueryControls, LiveSession, LLMProvider } from '../providers/base.js';
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
  /** Current working card messageId per chat — for steer matching */
  private activeMessageIds = new Map<string, string>();
  /** Queued messages per chat — processed after current turn completes */
  private messageQueue = new Map<string, Array<InboundMessage>>();

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

  /** Check if reply-to matches the current working card (for steer) */
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

  /** Steer the active turn (inject text into running turn) */
  steer(channelType: string, chatId: string, text: string): void {
    // O(1) lookup: get active session for this chat
    const sessionKey = this.activeSessionByChat.get(`${channelType}:${chatId}`);
    if (!sessionKey) return;
    const managed = this.registry.get(sessionKey);
    if (managed?.session.isTurnActive) {
      managed.session.steerTurn(text);
    }
  }

  private static MAX_QUEUE_SIZE = 10;

  /** Queue a message for processing after the current turn completes. Returns false if queue is full. */
  queueMessage(channelType: string, chatId: string, msg: InboundMessage): boolean {
    const chatKey = this.state.stateKey(channelType, chatId);
    const queue = this.messageQueue.get(chatKey) ?? [];
    if (queue.length >= SDKEngine.MAX_QUEUE_SIZE) return false;
    queue.push(msg);
    this.messageQueue.set(chatKey, queue);
    return true;
  }

  /** Dequeue the next message for a chat */
  dequeueMessage(channelType: string, chatId: string): InboundMessage | undefined {
    const chatKey = this.state.stateKey(channelType, chatId);
    const queue = this.messageQueue.get(chatKey);
    if (!queue?.length) return undefined;
    const msg = queue.shift()!;
    if (queue.length === 0) this.messageQueue.delete(chatKey);
    return msg;
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
