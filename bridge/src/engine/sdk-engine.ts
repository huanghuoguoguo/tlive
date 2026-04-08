/**
 * SDKEngine — manages LiveSessions, steer/queue logic, and AskUserQuestion handling.
 *
 * Core responsibilities:
 * - Session registry: manage LiveSessions per chat+workdir
 * - Steer/Queue: inject messages into active turns or queue for later
 * - AskUserQuestion: handle multi-question flows
 */

import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage, OutboundMessage } from '../channels/types.js';
import type { QueryControls, LiveSession } from '../providers/base.js';
import type { PermissionCoordinator } from './permission-coordinator.js';
import type { SessionStateManager } from './session-state.js';
import type { ChannelRouter } from './router.js';
import { truncate } from '../utils/string.js';
import { generateId } from '../utils/id.js';

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
 * Handles the full SDK conversation flow: session management, renderer setup,
 * permission handler construction, AskUserQuestion handling, and turn processing.
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
    private permissions: PermissionCoordinator,
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
        // Clear active session ref if this was the active one
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
      // Clear active session ref
      this.activeSessionByChat.delete(chatKey);
    }
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

  // ── AskUserQuestion ──

  /** Ask a single question from an AskUserQuestion call. Returns the answer string. */
  async askSingleQuestion(
    adapter: BaseChannelAdapter,
    msg: InboundMessage,
    sessionId: string,
    q: { question: string; header: string; options: Array<{ label: string; description?: string; preview?: string }>; multiSelect: boolean },
  ): Promise<string> {
    const permId = generateId('askq', 8);

    const header = q.header ? `📋 **${q.header}**\n\n` : '';
    const optionLines: string[] = [];
    for (let i = 0; i < q.options.length; i++) {
      const opt = q.options[i];
      let line = `${i + 1}. **${opt.label}**${opt.description ? ` — ${opt.description}` : ''}`;
      if (opt.preview) {
        line += '\n' + opt.preview.split('\n').map(l => `   ${l}`).join('\n');
      }
      optionLines.push(line);
    }
    const questionText = `${header}${q.question}\n\n${optionLines.join('\n')}`;

    const isMulti = q.multiSelect;
    const buttons: Array<{ label: string; callbackData: string; style: 'primary' | 'danger'; row?: number }> = isMulti
      ? [
          ...q.options.map((opt, idx) => ({
            label: `☐ ${opt.label}`,
            callbackData: `askq_toggle:${permId}:${idx}:sdk`,
            style: 'primary' as const,
            row: idx,
          })),
          { label: '✅ Submit', callbackData: `askq_submit_sdk:${permId}`, style: 'primary' as const, row: q.options.length },
          { label: '❌ Skip', callbackData: `perm:allow:${permId}:askq_skip`, style: 'danger' as const, row: q.options.length },
        ]
      : [
          ...q.options.map((opt, idx) => ({
            label: `${idx + 1}. ${opt.label}`,
            callbackData: `perm:allow:${permId}:askq:${idx}`,
            style: 'primary' as const,
          })),
          { label: '❌ Skip', callbackData: `perm:allow:${permId}:askq_skip`, style: 'danger' as const },
        ];

    this.sdkQuestionData.set(permId, { questions: [q], chatId: msg.chatId });
    if (isMulti) {
      this.permissions.storeQuestionData(permId, [q] as any);
    }

    const waitPromise = this.permissions.getGateway().waitFor(permId);

    const hint = isMulti
      ? (msg.channelType === 'feishu' ? '\n\n💬 点击选项切换选中，然后按 Submit 确认' : '\n\n💬 Tap options to toggle, then Submit')
      : (msg.channelType === 'feishu' ? '\n\n💬 回复数字选择，或直接输入内容' : '\n\n💬 Reply with number to select, or type your answer');

    const outMsg: OutboundMessage = {
      chatId: msg.chatId,
      text: msg.channelType !== 'telegram' ? questionText + hint : undefined,
      html: msg.channelType === 'telegram' ? questionText.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>') + hint : undefined,
      buttons,
      feishuHeader: msg.channelType === 'feishu' ? { template: 'blue', title: '❓ Question' } : undefined,
    };
    const sendResult = await adapter.send(outMsg);
    this.permissions.trackPermissionMessage(sendResult.messageId, permId, sessionId, msg.channelType);

    const result = await waitPromise;

    if (result.behavior === 'deny') {
      this.sdkQuestionData.delete(permId);
      adapter.editMessage(msg.chatId, sendResult.messageId, {
        chatId: msg.chatId, text: '⏭ Skipped', buttons: [],
        feishuHeader: msg.channelType === 'feishu' ? { template: 'grey', title: '⏭ Skipped' } : undefined,
      }).catch(() => {});
      throw new Error('User skipped question');
    }

    const textAnswer = this.sdkQuestionTextAnswers.get(permId);
    this.sdkQuestionTextAnswers.delete(permId);
    this.sdkQuestionData.delete(permId);

    if (textAnswer !== undefined) {
      adapter.editMessage(msg.chatId, sendResult.messageId, {
        chatId: msg.chatId,
        text: `✅ Answer: ${truncate(textAnswer, 50)}`,
        buttons: [],
        feishuHeader: msg.channelType === 'feishu' ? { template: 'green', title: '✅ Answered' } : undefined,
      }).catch(() => {});
      return textAnswer;
    }

    const optionIndex = this.sdkQuestionAnswers.get(permId);
    this.sdkQuestionAnswers.delete(permId);
    const selected = optionIndex !== undefined ? q.options[optionIndex] : undefined;
    const answerLabel = selected?.label ?? '';

    if (!selected) {
      adapter.editMessage(msg.chatId, sendResult.messageId, {
        chatId: msg.chatId, text: '✅ Answered', buttons: [],
        feishuHeader: msg.channelType === 'feishu' ? { template: 'green', title: '✅ Answered' } : undefined,
      }).catch(() => {});
    }

    return answerLabel;
  }
}
