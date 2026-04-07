import { BaseChannelAdapter, createAdapter } from '../channels/base.js';
import type { InboundMessage, OutboundMessage } from '../channels/types.js';
import { ConversationEngine } from './conversation.js';
import { ChannelRouter } from './router.js';
import { PermissionBroker } from '../permissions/broker.js';
import { PendingPermissions } from '../permissions/gateway.js';
import { DeliveryLayer, chunkByParagraph } from '../delivery/delivery.js';
import { getBridgeContext } from '../context.js';
import { loadConfig } from '../config.js';
import { markdownToTelegram } from '../markdown/index.js';
import { downgradeHeadings } from '../markdown/feishu.js';
import { MessageRenderer } from './message-renderer.js';
import { getToolCommand } from './tool-registry.js';
import { SessionStateManager } from './session-state.js';
import { PermissionCoordinator } from './permission-coordinator.js';
import { CommandRouter } from './command-router.js';
import { SDKEngine } from './sdk-engine.js';
import type { FeishuStreamingSession } from '../channels/feishu-streaming.js';
import { CostTracker } from './cost-tracker.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir, networkInterfaces, tmpdir } from 'node:os';
import { getTliveRuntimeDir, shortPath } from '../utils/path.js';
import { safeParseObject } from '../utils/json.js';
import { generateSessionId } from '../utils/id.js';
import { truncate } from '../utils/string.js';
import { CHANNEL_TYPES, PLATFORM_LIMITS, PLATFORM_REACTIONS, type ChannelType, CALLBACK_PREFIXES } from '../utils/constants.js';
import { parseAskqCallback, parseAskqToggleCallback, parseAskqSubmitCallback, parseAskqSkipCallback, parseHookCallback, parseAskqSubmitSdkCallback, parseCallback } from '../utils/callback.js';

/** Bridge commands handled synchronously (don't block adapter loop) */
const QUICK_COMMANDS = new Set(['/new', '/status', '/verbose', '/hooks', '/sessions', '/session', '/help', '/perm', '/effort', '/stop', '/approve', '/pairings', '/settings', '/model', '/bash', '/cd', '/pwd']);

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;
  const num = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

/** Detect LAN IP address, matching Go Core's getLocalIP() logic */
function getLocalIP(): string {
  // Prefer iterating interfaces for a private IPv4 address
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal && isPrivateIPv4(info.address)) {
        return info.address;
      }
    }
  }
  return 'localhost';
}

/** Data shape for hook notifications (stop, idle_prompt, etc.) from Go Core */
export interface HookNotificationData {
  tlive_hook_type?: string;
  tlive_session_id?: string;
  tlive_cwd?: string;
  notification_type?: string;
  message?: string;
  last_assistant_message?: string;
  last_output?: string;
  [key: string]: unknown;
}

export class BridgeManager {
  private adapters = new Map<string, BaseChannelAdapter>();
  private running = false;
  private engine = new ConversationEngine();
  private router = new ChannelRouter();
  private delivery = new DeliveryLayer();
  private coreUrl: string;
  private token: string;
  private port: number;
  private coreAvailable = false;
  private state = new SessionStateManager();
  private permissions: PermissionCoordinator;
  /** SDK Engine for LiveSession management */
  private sdkEngine: SDKEngine;
  private lastChatId = new Map<string, string>();
  /** Pending image attachments waiting for a text message to merge with (key: channelType:chatId) */
  private pendingAttachments = new Map<string, { attachments: import('../channels/types.js').FileAttachment[]; timestamp: number }>();
  /** Debounce timer for chatId persistence */
  private chatIdPersistTimer: ReturnType<typeof setTimeout> | null = null;
  /** Pushback buffer for message coalescing */
  private coalescePushback = new Map<string, InboundMessage>();
  /** Telegram message length limit — only coalesce if text is near this boundary */
  private static TG_MSG_LIMIT = 4096;

  private commands: CommandRouter;
  private chatIdFile: string;
  /** Cleanup timer for SDK question data */
  private sdkQuestionCleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    const config = loadConfig();
    const localUrl = `http://${getLocalIP()}:${config.port || 8080}`;
    const gateway = new PendingPermissions();
    const broker = new PermissionBroker(gateway, localUrl);
    this.coreUrl = config.coreUrl;
    this.token = config.token;
    this.port = config.port || 8080;
    this.permissions = new PermissionCoordinator(gateway, broker, this.coreUrl, this.token);
    this.sdkEngine = new SDKEngine(this.state, this.router, this.permissions);
    // Load persisted chatIds (so hook routing works without needing a message first)
    this.chatIdFile = join(getTliveRuntimeDir(), 'chat-ids.json');
    try {
      const data = JSON.parse(readFileSync(this.chatIdFile, 'utf-8'));
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'string') this.lastChatId.set(k, v);
      }
    } catch { /* no saved chat IDs yet */ }
    this.commands = new CommandRouter(
      this.state,
      () => this.adapters,
      this.router,
      () => this.coreAvailable,
      this.sdkEngine.getActiveControls(),
      this.permissions,
      (channelType, chatId) => this.sdkEngine.closeSession(channelType, chatId),
    );
  }

  /** Persist chatIds to file (debounced to avoid blocking message loop) */
  private persistChatIds(): void {
    if (this.chatIdPersistTimer) {
      clearTimeout(this.chatIdPersistTimer);
    }
    this.chatIdPersistTimer = setTimeout(() => {
      try {
        mkdirSync(getTliveRuntimeDir(), { recursive: true });
        writeFileSync(this.chatIdFile, JSON.stringify(Object.fromEntries(this.lastChatId)));
      } catch { /* non-fatal */ }
      this.chatIdPersistTimer = null;
    }, 1000); // 1 second debounce
  }

  /** Expose coreAvailable flag for main.ts polling loop */
  setCoreAvailable(available: boolean): void {
    this.coreAvailable = available;
  }

  /** Returns all active adapters */
  getAdapters(): BaseChannelAdapter[] {
    return Array.from(this.adapters.values());
  }

  getAdapter(channelType: string): BaseChannelAdapter | undefined {
    return this.adapters.get(channelType);
  }

  /** Get the last active chatId for a given channel type (for hook routing) */
  getLastChatId(channelType: string): string {
    return this.lastChatId.get(channelType) ?? '';
  }

  /** Delegate: track a hook message for reply routing */
  trackHookMessage(messageId: string, sessionId: string): void {
    this.permissions.trackHookMessage(messageId, sessionId);
  }

  /** Delegate: track a permission message for text-based approval */
  trackPermissionMessage(messageId: string, permissionId: string, sessionId: string, channelType: string): void {
    this.permissions.trackPermissionMessage(messageId, permissionId, sessionId, channelType);
  }

  /** Delegate: store original permission card text */
  storeHookPermissionText(hookId: string, text: string): void {
    this.permissions.storeHookPermissionText(hookId, text);
  }

  /** Delegate: store AskUserQuestion data */
  storeQuestionData(hookId: string, questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }>, contextSuffix?: string): void {
    this.permissions.storeQuestionData(hookId, questions, contextSuffix);
  }

  /** Find a pending SDK AskUserQuestion for numeric text reply */
  private findPendingSdkQuestion(_channelType: string, chatId: string): { permId: string } | null {
    // Find the most recent pending SDK askq permission scoped to this chat
    const { sdkQuestionData } = this.sdkEngine.getQuestionState();
    for (const [permId, data] of sdkQuestionData) {
      if (data.chatId === chatId && this.permissions.getGateway().isPending(permId)) {
        return { permId };
      }
    }
    return null;
  }

  registerAdapter(adapter: BaseChannelAdapter): void {
    this.adapters.set(adapter.channelType, adapter);
  }

  async start(): Promise<void> {
    this.running = true;
    for (const [type, adapter] of this.adapters) {
      const err = adapter.validateConfig();
      if (err) { console.warn(`Skipping ${type}: ${err}`); this.adapters.delete(type); continue; }
      await adapter.start();
      this.runAdapterLoop(adapter);
    }
    this.permissions.startPruning();
    this.sdkEngine.startSessionPruning();
    // Periodic cleanup of SDK question data (5 minute TTL) and stale attachments
    // Use 5-minute interval to avoid iterating all entries every minute
    this.sdkQuestionCleanupTimer = setInterval(() => {
      const now = Date.now();
      const maxAge = 5 * 60 * 1000;
      const { sdkQuestionData, sdkQuestionAnswers, sdkQuestionTextAnswers } = this.sdkEngine.getQuestionState();
      for (const [id] of sdkQuestionData) {
        if (!this.permissions.getGateway().isPending(id)) {
          sdkQuestionData.delete(id);
          sdkQuestionAnswers.delete(id);
          sdkQuestionTextAnswers.delete(id);
        }
      }
      for (const [key, entry] of this.pendingAttachments) {
        if (now - entry.timestamp > maxAge) {
          this.pendingAttachments.delete(key);
        }
      }
    }, 5 * 60 * 1000);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.sdkQuestionCleanupTimer) {
      clearInterval(this.sdkQuestionCleanupTimer);
      this.sdkQuestionCleanupTimer = null;
    }
    this.permissions.stopPruning();
    this.sdkEngine.stopSessionPruning();
    this.permissions.getGateway().denyAll();
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }
  }

  /** Send a hook notification to IM with [Local] prefix and track for reply routing */
  async sendHookNotification(adapter: BaseChannelAdapter, chatId: string, hook: HookNotificationData, receiveIdType?: string): Promise<void> {
    const { formatNotification } = await import('../formatting/index.js');
    const hookType = hook.tlive_hook_type || '';

    let title: string;
    let type: 'stop' | 'idle_prompt' | 'generic';
    let summary: string | undefined;

    // Build context suffix: project name + short session ID
    const contextParts: string[] = [];
    if (hook.tlive_cwd) {
      const projectName = basename(hook.tlive_cwd || '') || '';
      if (projectName) contextParts.push(projectName);
    }
    if (hook.tlive_session_id) {
      const shortId = hook.tlive_session_id.slice(-6);
      contextParts.push(`#${shortId}`);
    }
    const contextSuffix = contextParts.length > 0 ? ' · ' + contextParts.join(' · ') : '';

    if (hookType === 'stop') {
      type = 'stop';
      const raw = (hook.last_assistant_message || hook.last_output || '').trim();
      summary = raw ? truncate(raw, 3000) : undefined;
      title = `Terminal${contextSuffix}`;
    } else if (hook.notification_type === 'idle_prompt') {
      title = `Terminal${contextSuffix} · ` + (hook.message || 'Waiting for input...');
      type = 'idle_prompt';
    } else {
      title = hook.message || 'Notification';
      type = 'generic';
    }

    let terminalUrl: string | undefined;
    if (this.coreAvailable && hook.tlive_session_id) {
      terminalUrl = `http://${getLocalIP()}:${this.port}/terminal.html?id=${hook.tlive_session_id}&token=${this.token}`;
    }

    const formatted = formatNotification({ type, title, summary, terminalUrl }, adapter.channelType as any);

    const outMsg: import('../channels/types.js').OutboundMessage = {
      chatId,
      text: formatted.text,
      html: formatted.html,
      embed: formatted.embed,
      buttons: (formatted as any).buttons,
      feishuHeader: formatted.feishuHeader,
      feishuElements: (formatted as any).feishuElements,
      receiveIdType,
    };
    const result = await adapter.send(outMsg);
    this.permissions.trackHookMessage(result.messageId, hook.tlive_session_id || '');
  }

  /** Wait briefly for follow-up messages from the same user, merge text if they arrive quickly.
   *  Handles Telegram splitting long messages at 4096 chars. */
  private async coalesceMessages(adapter: BaseChannelAdapter, first: InboundMessage): Promise<InboundMessage> {
    if (!first.text || first.callbackData) return first;

    // Only wait for follow-up parts if message is near Telegram's 4096 char limit
    if (first.text.length < BridgeManager.TG_MSG_LIMIT - 200) return first;

    // Wait up to 500ms for follow-up parts
    const parts: string[] = [first.text];
    const deadline = Date.now() + 500;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
      const next = await adapter.consumeOne();
      if (!next) continue;

      // Only merge if same user, same chat, text-only (no callback/command), arrives quickly
      if (next.userId === first.userId && next.chatId === first.chatId
          && next.text && !next.callbackData && !next.text.startsWith('/')) {
        parts.push(next.text);
        console.log(`[${adapter.channelType}] Coalesced message part (${next.text.length} chars)`);
      } else {
        // Different message — put it back for next iteration
        this.coalescePushback.set(adapter.channelType, next);
        break;
      }
    }

    if (parts.length === 1) return first;
    console.log(`[${adapter.channelType}] Merged ${parts.length} message parts (${parts.reduce((s, p) => s + p.length, 0)} chars total)`);
    return { ...first, text: parts.join('\n') };
  }

  /** Process queued messages iteratively after current turn completes */
  private async drainQueue(adapter: BaseChannelAdapter, channelType: string, chatId: string): Promise<void> {
    let next: InboundMessage | undefined;
    while ((next = this.sdkEngine.dequeueMessage(channelType, chatId))) {
      console.log(`[${adapter.channelType}] Processing queued message`);
      try {
        await this.handleInboundMessage(adapter, next);
      } catch (err) {
        console.error(`[${adapter.channelType}] Error processing queued message:`, err);
        break;
      }
    }
  }

  private async runAdapterLoop(adapter: BaseChannelAdapter): Promise<void> {
    while (this.running) {
      // Check pushback from coalescing first
      let msg = this.coalescePushback.get(adapter.channelType) ?? await adapter.consumeOne();
      this.coalescePushback.delete(adapter.channelType);
      if (!msg) { await new Promise(r => setTimeout(r, 100)); continue; }
      console.log(`[${adapter.channelType}] Message from ${msg.userId}: ${msg.text || '(callback)'}`);
      // Callbacks, commands, and permission text are fast — await them.
      // Regular messages (Claude queries) are fire-and-forget so they don't
      // block the loop while waiting for LLM responses or permission approvals.
      const hasPendingQuestion = this.permissions.getLatestPendingQuestion(adapter.channelType) !== null
        || this.findPendingSdkQuestion(adapter.channelType, msg.chatId) !== null;
      const isQuickMessage = !!msg.callbackData
        || (msg.text && QUICK_COMMANDS.has(msg.text.split(' ')[0].toLowerCase()))
        || this.permissions.parsePermissionText(msg.text || '') !== null
        || hasPendingQuestion;
      if (isQuickMessage) {
        try {
          await this.handleInboundMessage(adapter, msg);
        } catch (err) {
          console.error(`[${adapter.channelType}] Error handling message:`, err);
        }
      } else {
        // Coalesce rapid-fire messages (e.g. Telegram splits long text at 4096 chars)
        const coalesced = await this.coalesceMessages(adapter, msg);

        // Guard: if this chat is already processing a message
        const chatKey = this.state.stateKey(coalesced.channelType, coalesced.chatId);
        if (this.state.isProcessing(chatKey)) {
          // Check if we can steer the active session
          if (coalesced.text && this.sdkEngine.canSteer(coalesced.channelType, coalesced.chatId, coalesced.replyToMessageId)) {
            this.sdkEngine.steer(coalesced.channelType, coalesced.chatId, coalesced.text);
            await adapter.send({ chatId: coalesced.chatId, text: '💬 Message sent to active session' }).catch(() => {});
          } else if (coalesced.text) {
            const queued = this.sdkEngine.queueMessage(coalesced.channelType, coalesced.chatId, coalesced);
            if (queued) {
              await adapter.send({ chatId: coalesced.chatId, text: '📥 Queued — will process after current task' }).catch(() => {});
            } else {
              await adapter.send({ chatId: coalesced.chatId, text: '⚠️ Queue full — please wait for current tasks to finish' }).catch(() => {});
            }
          }
          continue;
        }
        this.state.setProcessing(chatKey, true);
        this.handleInboundMessage(adapter, coalesced)
          .then(() => this.drainQueue(adapter, coalesced.channelType, coalesced.chatId))
          .catch(err => console.error(`[${adapter.channelType}] Error handling message:`, err))
          .finally(() => this.state.setProcessing(chatKey, false));
      }
    }
  }

  async handleInboundMessage(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    // Auth check — with pairing mode for Telegram
    if (!adapter.isAuthorized(msg.userId, msg.chatId)) {
      // Telegram pairing mode: generate code for unknown user (DM only)
      if (adapter.channelType === 'telegram' && 'requestPairing' in adapter && msg.text) {
        const tgAdapter = adapter as any;
        const username = msg.userId; // userId as fallback
        const code = tgAdapter.requestPairing(msg.userId, msg.chatId, username);
        if (code) {
          await adapter.send({
            chatId: msg.chatId,
            html: [
              `🔐 <b>Pairing Required</b>`,
              '',
              `Your pairing code: <code>${code}</code>`,
              '',
              `Ask an admin to run <code>/approve ${code}</code> in an authorized channel.`,
              `Code expires in 1 hour.`,
            ].join('\n'),
          });
        }
      }
      return false;
    }

    // Track last active chatId per channel type (used for hook notification routing)
    if (msg.chatId) {
      this.lastChatId.set(adapter.channelType, msg.chatId);
      // Persist debounced (non-blocking)
      this.persistChatIds();
    }

    // Image buffering: cache image-only messages, merge into next text message
    const attachKey = `${msg.channelType}:${msg.chatId}`;
    if (msg.attachments?.length && !msg.text && !msg.callbackData) {
      // Image-only message: buffer attachments and wait for text
      // Limit: max 5 attachments, max 10MB total
      const MAX_ATTACHMENTS = 5;
      const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
      let attachments = msg.attachments.slice(0, MAX_ATTACHMENTS);
      const totalBytes = attachments.reduce((sum, a) => sum + a.base64Data.length, 0);
      if (totalBytes > MAX_TOTAL_BYTES) {
        // Keep only attachments that fit within budget
        let budget = MAX_TOTAL_BYTES;
        attachments = attachments.filter(a => {
          if (a.base64Data.length <= budget) {
            budget -= a.base64Data.length;
            return true;
          }
          return false;
        });
        console.warn(`[${msg.channelType}] Attachment buffer exceeded 10MB limit, kept ${attachments.length}`);
      }
      if (attachments.length > 0) {
        this.pendingAttachments.set(attachKey, {
          attachments,
          timestamp: Date.now(),
        });
        console.log(`[${msg.channelType}] Buffered ${attachments.length} attachment(s), waiting for text`);
      }
      return true;
    }
    // Merge pending attachments into current text message
    if (msg.text && !msg.callbackData) {
      const pending = this.pendingAttachments.get(attachKey);
      if (pending && Date.now() - pending.timestamp < 60_000) {
        msg.attachments = [...(msg.attachments || []), ...pending.attachments];
        console.log(`[${msg.channelType}] Merged ${pending.attachments.length} buffered attachment(s) with text`);
      }
      this.pendingAttachments.delete(attachKey);
    }

    // Text-based permission resolution (all platforms — fallback when buttons expire)
    if (msg.text) {
      const decision = this.permissions.parsePermissionText(msg.text);
      if (decision) {
        // 1. Try SDK permission gateway — scoped to THIS chat only
        const chatKey = this.state.stateKey(msg.channelType, msg.chatId);
        if (this.permissions.tryResolveByText(chatKey, decision)) {
          // Brief reaction instead of a full card — avoids flooding
          const emoji = decision === 'deny' ? 'NO' : decision === 'allow_always' ? 'DONE' : 'OK';
          adapter.addReaction(msg.chatId, msg.messageId, emoji).catch(() => {});
          return true;
        }

        // 2. Try hook permission (via Go Core)
        if (this.permissions.pendingPermissionCount() > 1 && !msg.replyToMessageId) {
          const hint = adapter.channelType === 'feishu'
            ? '⚠️ 多个权限待审批，请引用回复具体的权限消息'
            : '⚠️ Multiple permissions pending — reply to the specific permission message';
          await adapter.send({ chatId: msg.chatId, text: hint });
          return true;
        }
        const permEntry = this.permissions.findHookPermission(msg.replyToMessageId, adapter.channelType);
        if (permEntry && this.coreAvailable) {
          try {
            await this.permissions.resolveHookPermission(permEntry.permissionId, decision, adapter.channelType, this.coreAvailable);
            const label = decision === 'deny' ? '❌ Denied' : decision === 'allow_always' ? '📌 Always allowed' : '✅ Allowed';
            await adapter.send({ chatId: msg.chatId, text: label });
          } catch (err) {
            await adapter.send({ chatId: msg.chatId, text: `❌ Failed to resolve: ${err}` });
          }
          return true;
        }
      }
    }

    // Text reply to pending AskUserQuestion — numeric (select option) or free text (direct input)
    if (msg.text) {
      const trimmed = msg.text.trim();
      // Check for any pending AskUserQuestion (hook or SDK mode)
      const pendingHookQ = this.permissions.getLatestPendingQuestion(adapter.channelType);
      const pendingSdkQ = this.findPendingSdkQuestion(adapter.channelType, msg.chatId);

      if (pendingHookQ || pendingSdkQ) {
        // Check if input is a valid in-range numeric option selection
        let validOptionIndex = -1;
        const numMatch = trimmed.match(/^(\d+)$/);
        if (numMatch) {
          const idx = parseInt(numMatch[1], 10) - 1;
          if (idx >= 0) {
            // Validate against actual options count to avoid "Selected: ?" for out-of-range numbers
            const { sdkQuestionData } = this.sdkEngine.getQuestionState();
            const qData = pendingHookQ
              ? this.permissions.getQuestionData(pendingHookQ.hookId)
              : pendingSdkQ ? sdkQuestionData.get(pendingSdkQ.permId) : null;
            const optionsCount = qData?.questions?.[0]?.options?.length ?? 0;
            if (idx < optionsCount) validOptionIndex = idx;
          }
        }

        if (validOptionIndex >= 0) {
          // Numeric reply — select option by validated index
          if (pendingHookQ) {
            await this.permissions.resolveAskQuestion(
              pendingHookQ.hookId, validOptionIndex, pendingHookQ.sessionId,
              pendingHookQ.messageId, adapter, msg.chatId, this.coreAvailable,
            );
            return true;
          }
          if (pendingSdkQ) {
            const { sdkQuestionAnswers } = this.sdkEngine.getQuestionState();
            sdkQuestionAnswers.set(pendingSdkQ.permId, validOptionIndex);
            this.permissions.getGateway().resolve(pendingSdkQ.permId, 'allow');
            return true;
          }
        } else {
          // Free text reply (including out-of-range numbers) — use text as direct answer
          if (pendingHookQ) {
            await this.permissions.resolveAskQuestionWithText(
              pendingHookQ.hookId, trimmed, pendingHookQ.sessionId,
              pendingHookQ.messageId, adapter, msg.chatId, this.coreAvailable,
            );
            return true;
          }
          if (pendingSdkQ) {
            const { sdkQuestionTextAnswers } = this.sdkEngine.getQuestionState();
            sdkQuestionTextAnswers.set(pendingSdkQ.permId, trimmed);
            this.permissions.getGateway().resolve(pendingSdkQ.permId, 'allow');
            return true;
          }
        }
      }
    }

    // Reply routing: quote-reply to a hook message → send to PTY stdin
    if ((msg.text || msg.attachments?.length) && msg.replyToMessageId && this.permissions.isHookMessage(msg.replyToMessageId)) {
      // Before forwarding to PTY, check Core for a pending AskUserQuestion that
      // the bridge hasn't polled yet (race condition: hook creates perm, bridge
      // polls every 2s, user replies before the next poll cycle).
      if (msg.text && this.coreAvailable) {
        try {
          const pendingResp = await fetch(`${this.coreUrl}/api/hooks/pending`, {
            headers: { Authorization: `Bearer ${this.token}` },
            signal: AbortSignal.timeout(2000),
          });
          if (pendingResp.ok) {
            const pending = await pendingResp.json() as Array<{ id: string; tool_name: string; input: unknown; session_id?: string }>;
            const askq = pending.find((p: { tool_name: string }) => p.tool_name === 'AskUserQuestion');
            if (askq) {
              // There's a pending AskUserQuestion — handle text as question answer
              const inputData = safeParseObject(askq.input as Record<string, unknown>);
              const questions = (inputData?.questions ?? []) as Array<{
                question: string; header: string;
                options: Array<{ label: string; description?: string }>; multiSelect: boolean;
              }>;
              if (questions.length > 0) {
                const q = questions[0];
                const trimmed = msg.text.trim();
                // Store question data if not already stored
                if (!this.permissions.getQuestionData(askq.id)) {
                  this.permissions.storeQuestionData(askq.id, questions);
                  this.permissions.trackPermissionMessage(msg.replyToMessageId, askq.id, askq.session_id || '', adapter.channelType);
                }
                // Numeric → option selection; else → free text
                const numMatch = trimmed.match(/^(\d+)$/);
                const idx = numMatch ? parseInt(numMatch[1], 10) - 1 : -1;
                if (idx >= 0 && idx < q.options.length) {
                  await this.permissions.resolveAskQuestion(
                    askq.id, idx, askq.session_id || '',
                    msg.replyToMessageId, adapter, msg.chatId, this.coreAvailable,
                  );
                } else {
                  await this.permissions.resolveAskQuestionWithText(
                    askq.id, trimmed, askq.session_id || '',
                    msg.replyToMessageId, adapter, msg.chatId, this.coreAvailable,
                  );
                }
                return true;
              }
            }
          }
        } catch { /* non-fatal: fall through to normal PTY routing */ }
      }

      const entry = this.permissions.getHookMessage(msg.replyToMessageId);
      if (!entry) {
        await adapter.send({ chatId: msg.chatId, text: '⚠️ Hook message expired or not found' });
        return true;
      }
      if (entry.sessionId && this.coreAvailable) {
        try {
          // If images attached, save as temp files and include paths in the text
          let inputText = msg.text || '';
          if (msg.attachments?.length) {
            const imgDir = join(tmpdir(), 'tlive-images');
            mkdirSync(imgDir, { recursive: true });
            for (const att of msg.attachments) {
              if (att.type === 'image') {
                const ext = att.mimeType === 'image/png' ? '.png' : '.jpg';
                const filePath = join(imgDir, `img-${Date.now()}${ext}`);
                writeFileSync(filePath, Buffer.from(att.base64Data, 'base64'));
                inputText = inputText ? `${inputText}\n${filePath}` : filePath;
              }
            }
          }
          await fetch(`${this.coreUrl}/api/sessions/${entry.sessionId}/input`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text: inputText + '\r' }),
            signal: AbortSignal.timeout(5000),
          });
          await adapter.send({ chatId: msg.chatId, text: '✓ Sent to local session' });
        } catch (err) {
          await adapter.send({ chatId: msg.chatId, text: `❌ Failed to send: ${err}` });
        }
      } else {
        await adapter.send({ chatId: msg.chatId, text: '⚠️ Local session not available (no session ID)' });
      }
      return true;
    }

    // Callback data
    if (msg.callbackData) {
      // Prompt suggestion callback — re-inject as a normal user message
      if (msg.callbackData.startsWith('suggest:')) {
        const suggestion = msg.callbackData.slice('suggest:'.length);
        // Re-process as a regular text message
        msg.text = suggestion;
        msg.callbackData = undefined;
        return this.handleInboundMessage(adapter, msg);
      }

      // AskUserQuestion answer callbacks (askq:{hookId}:{optionIndex}:{sessionId})
      // NOTE: check toggle/submit/skip BEFORE this — they also start with "askq"
      const askqParsed = parseAskqCallback(msg.callbackData);
      if (askqParsed) {
        await this.permissions.resolveAskQuestion(
          askqParsed.hookId, askqParsed.optionIndex, askqParsed.sessionId,
          msg.messageId, adapter, msg.chatId, this.coreAvailable,
        );
        return true;
      }

      // AskUserQuestion multi-select toggle (askq_toggle:{hookId}:{idx}:{sessionId})
      const askqToggleParsed = parseAskqToggleCallback(msg.callbackData);
      if (askqToggleParsed) {
        const selected = this.permissions.toggleMultiSelectOption(askqToggleParsed.hookId, askqToggleParsed.optionIndex);
        if (selected === null) return true;

        // Re-render the card with updated checkboxes
        const card = this.permissions.buildMultiSelectCard(hookId, sessionId, selected, adapter.channelType);
        if (card) {
          await adapter.editMessage(msg.chatId, msg.messageId, {
            chatId: msg.chatId,
            text: card.text,
            html: card.html,
            buttons: card.buttons,
            feishuHeader: adapter.channelType === 'feishu' ? { template: 'blue', title: '❓ Terminal' } : undefined,
          });
        }
        return true;
      }

      // AskUserQuestion multi-select submit (askq_submit:{hookId}:{sessionId})
      const askqSubmitParsed = parseAskqSubmitCallback(msg.callbackData);
      if (askqSubmitParsed) {
        await this.permissions.resolveMultiSelect(
          askqSubmitParsed.hookId, askqSubmitParsed.sessionId,
          msg.messageId, adapter, msg.chatId, this.coreAvailable,
        );
        return true;
      }

      // AskUserQuestion skip callback — resolve with allow + empty answers (askq_skip:{hookId}:{sessionId})
      const askqSkipParsed = parseAskqSkipCallback(msg.callbackData);
      if (askqSkipParsed) {
        await this.permissions.resolveAskQuestionSkip(
          askqSkipParsed.hookId, askqSkipParsed.sessionId,
          msg.messageId, adapter, msg.chatId, this.coreAvailable,
        );
        return true;
      }

      // SDK AskUserQuestion multi-select submit (askq_submit_sdk:{permId})
      const askqSubmitSdkParsed = parseAskqSubmitSdkCallback(msg.callbackData);
      if (askqSubmitSdkParsed) {
        const permId = askqSubmitSdkParsed.permId;
        const selected = this.permissions.getToggledSelections(permId);
        if (selected.size === 0) {
          await adapter.send({ chatId: msg.chatId, text: '⚠️ No options selected' });
          return true;
        }
        const { sdkQuestionData, sdkQuestionTextAnswers } = this.sdkEngine.getQuestionState();
        const qData = sdkQuestionData.get(permId);
        if (qData) {
          const q = qData.questions[0];
          const selectedLabels = [...selected].sort((a, b) => a - b).map(i => q.options[i]?.label).filter(Boolean);
          const answerText = selectedLabels.join(',');
          sdkQuestionTextAnswers.set(permId, answerText);
          // Edit card to show selection
          adapter.editMessage(msg.chatId, msg.messageId, {
            chatId: msg.chatId,
            text: `✅ Selected: ${selectedLabels.join(', ')}`,
            buttons: [],
            feishuHeader: msg.channelType === 'feishu' ? { template: 'green', title: '✅ Answered' } : undefined,
          }).catch(() => {});
        }
        this.permissions.cleanupQuestion(permId);
        this.permissions.getGateway().resolve(permId, 'allow');
        return true;
      }

      // Command shortcuts from help menu buttons
      if (msg.callbackData.startsWith('cmd:')) {
        const cmd = msg.callbackData.slice(4);
        // Inject as a text message
        const cmdMsg: InboundMessage = {
          channelType: msg.channelType,
          chatId: msg.chatId,
          text: '/' + cmd,
          userId: msg.userId,
          messageId: msg.messageId,
        };
        // Process through normal command flow
        await this.handleInboundMessage(adapter, cmdMsg);
        return true;
      }

      // Hook permission callbacks (hook:allow:ID:sessionId, hook:allow_always:ID:sessionId, hook:deny:ID:sessionId)
      const hookParsed = parseHookCallback(msg.callbackData);
      if (hookParsed) {
        await this.permissions.resolveHookCallback(hookParsed.hookId, hookParsed.decision, hookParsed.sessionId, msg.messageId, adapter, msg.chatId, this.coreAvailable);
        return true;
      }

      // Graduated permission callbacks — resolve gateway, no message edit
      // (renderer.onPermissionResolved() handles the visual transition)
      if (msg.callbackData.startsWith(CALLBACK_PREFIXES.PERM_ALLOW_EDITS)) {
        const permId = msg.callbackData.slice(CALLBACK_PREFIXES.PERM_ALLOW_EDITS.length);
        this.permissions.getGateway().resolve(permId, 'allow');
        return true;
      }

      if (msg.callbackData.startsWith(CALLBACK_PREFIXES.PERM_ALLOW_TOOL)) {
        const parts = parseCallback(msg.callbackData);
        const permId = parts[2];
        const toolName = parts.slice(3).join(':');
        this.permissions.getGateway().resolve(permId, 'allow');
        this.permissions.addAllowedTool(toolName);
        console.log(`[bridge] Added ${toolName} to session whitelist`);
        return true;
      }

      if (msg.callbackData.startsWith(CALLBACK_PREFIXES.PERM_ALLOW_BASH)) {
        const parts = parseCallback(msg.callbackData);
        const permId = parts[2];
        const prefix = parts.slice(3).join(':');
        this.permissions.getGateway().resolve(permId, 'allow');
        this.permissions.addAllowedBashPrefix(prefix);
        console.log(`[bridge] Added Bash(${prefix} *) to session whitelist`);
        return true;
      }

      // SDK AskUserQuestion answer callbacks (perm:allow:permId:askq:optionIndex)
      if (msg.callbackData.includes(':askq:')) {
        const parts = msg.callbackData.split(':');
        const askqIdx = parts.indexOf('askq');
        if (askqIdx >= 0) {
          const permId = parts.slice(2, askqIdx).join(':');
          const optionIndex = parseInt(parts[askqIdx + 1], 10);
          const { sdkQuestionData, sdkQuestionAnswers } = this.sdkEngine.getQuestionState();
          const qData = sdkQuestionData.get(permId);
          const selected = qData?.questions?.[0]?.options?.[optionIndex];
          if (!selected) {
            // Invalid option index (stale button or tampered data) — ignore
            return true;
          }
          sdkQuestionAnswers.set(permId, optionIndex);
          this.permissions.getGateway().resolve(permId, 'allow');
          adapter.editMessage(msg.chatId, msg.messageId, {
            chatId: msg.chatId,
            text: `✅ Selected: ${selected.label}`,
            buttons: [],
            feishuHeader: { template: 'green', title: `✅ ${selected.label}` },
          }).catch(() => {});
          return true;
        }
      }

      // SDK AskUserQuestion skip (perm:allow:permId:askq_skip) — resolve with deny so handler returns empty answers
      if (msg.callbackData.includes(':askq_skip')) {
        const parts = msg.callbackData.split(':');
        const skipIdx = parts.indexOf('askq_skip');
        if (skipIdx >= 0) {
          const permId = parts.slice(2, skipIdx).join(':');
          this.permissions.getGateway().resolve(permId, 'deny', 'Skipped');
          adapter.editMessage(msg.chatId, msg.messageId, {
            chatId: msg.chatId,
            text: '⏭ Skipped',
            buttons: [],
            feishuHeader: { template: 'grey', title: '⏭ Skipped' },
          }).catch(() => {});
          return true;
        }
      }

      // Regular permission broker callbacks (perm:allow:ID, perm:deny:ID)
      console.log(`[bridge] Perm callback: ${msg.callbackData}, gateway pending: ${this.permissions.getGateway().pendingCount()}`);
      this.permissions.handleBrokerCallback(msg.callbackData);
      // No message edit — renderer.onPermissionResolved() morphs back to status line
      return true;
    }

    // Bridge commands — only intercept known commands, pass others to Claude Code
    if (msg.text.startsWith('/')) {
      const handled = await this.commands.handle(adapter, msg);
      if (handled) return true;
      // Unrecognized slash command → fall through to Claude Code
    }

    // Check for session expiry (>30 min inactivity) and auto-create new session
    const expired = this.state.checkAndUpdateLastActive(msg.channelType, msg.chatId);
    if (expired) {
      await this.router.rebind(msg.channelType, msg.chatId, generateSessionId());
      this.state.clearThread(msg.channelType, msg.chatId);
      this.permissions.clearSessionWhitelist();
    }

    const binding = await this.router.resolve(msg.channelType, msg.chatId);
    const { store, defaultWorkdir } = getBridgeContext();

    // Resolve threadId: use existing thread if message came from one, or reuse session thread
    let threadId = msg.threadId;
    if (!threadId && adapter.channelType === CHANNEL_TYPES.DISCORD) {
      threadId = this.state.getThread(msg.channelType, msg.chatId);
    }

    // Reaction target: for Discord threads, reaction goes on the original channel message
    const reactionChatId = msg.chatId;

    // Start typing heartbeat (in thread if available)
    const typingTarget = threadId && adapter.channelType === CHANNEL_TYPES.DISCORD ? threadId : msg.chatId;
    const typingInterval = setInterval(() => {
      adapter.sendTyping(typingTarget).catch(() => {});
    }, 4000);
    adapter.sendTyping(typingTarget).catch(() => {});

    const costTracker = new CostTracker();
    costTracker.start();

    // Add processing reaction (use centralized platform reactions)
    const reactions = PLATFORM_REACTIONS[adapter.channelType as ChannelType] ?? PLATFORM_REACTIONS[CHANNEL_TYPES.TELEGRAM];
    adapter.addReaction(reactionChatId, msg.messageId, reactions.processing).catch(() => {});

    // Feishu streaming disabled — new renderer uses short status lines
    // that don't benefit from streaming, and streaming cards can't be
    // edited with im.message.patch (needed for permission buttons)
    let feishuSession: import('../channels/feishu-streaming.js').FeishuStreamingSession | null = null;

    let permissionReminderMsgId: string | undefined;
    let permissionReminderTool: string | undefined;
    let permissionReminderInput: string | undefined;
    const renderer = new MessageRenderer({
      platformLimit: PLATFORM_LIMITS[adapter.channelType as ChannelType] ?? 4096,
      throttleMs: 300,
      cwd: binding.cwd || defaultWorkdir,
      sessionId: binding.sdkSessionId,
      onPermissionTimeout: async (toolName, input, buttons) => {
        permissionReminderTool = toolName;
        permissionReminderInput = input;
        const text = `⚠️ Permission pending — ${toolName}: ${permissionReminderInput}`;
        const targetChatId = threadId && adapter.channelType === CHANNEL_TYPES.DISCORD ? threadId : msg.chatId;
        const outMsg: OutboundMessage = adapter.channelType === CHANNEL_TYPES.TELEGRAM
          ? { chatId: targetChatId, html: markdownToTelegram(text) }
          : { chatId: targetChatId, text };
        outMsg.buttons = buttons.map(b => ({ ...b, style: b.style as 'primary' | 'danger' | 'default' }));
        if (threadId) outMsg.threadId = threadId;
        try {
          const result = await adapter.send(outMsg);
          permissionReminderMsgId = result.messageId;
        } catch { /* non-fatal */ }
      },
      flushCallback: async (content, isEdit, buttons) => {
        // Feishu streaming path — skip when buttons needed (streaming doesn't support buttons)
        if (feishuSession && !buttons?.length) {
          if (!isEdit) {
            try {
              const messageId = await feishuSession.start(downgradeHeadings(content));
              clearInterval(typingInterval);
              return messageId;
            } catch {
              feishuSession = null;
            }
          } else {
            feishuSession.update(downgradeHeadings(content)).catch(() => {});
            return;
          }
        }
        // Non-streaming path
        let outMsg: OutboundMessage;
        if (adapter.channelType === 'telegram') {
          outMsg = { chatId: msg.chatId, html: markdownToTelegram(content), threadId };
        } else if (adapter.channelType === 'discord') {
          outMsg = { chatId: msg.chatId, text: content, threadId };
        } else {
          outMsg = { chatId: msg.chatId, text: content };
        }
        if (buttons?.length) {
          outMsg.buttons = buttons.map(b => ({ ...b, style: b.style as 'primary' | 'danger' | 'default' }));
        }
        if (!isEdit) {
          if (adapter.channelType === 'discord' && !threadId && 'createThread' in adapter) {
            const result = await adapter.send(outMsg);
            clearInterval(typingInterval);
            const preview = (msg.text || 'Claude').slice(0, 80);
            const newThreadId = await (adapter as any).createThread(msg.chatId, result.messageId, `💬 ${preview}`);
            if (newThreadId) {
              threadId = newThreadId;
              this.state.setThread(msg.channelType, msg.chatId, newThreadId);
            }
            return result.messageId;
          }
          const result = await adapter.send(outMsg);
          clearInterval(typingInterval);
          return result.messageId;
        } else {
          const limit = PLATFORM_LIMITS[adapter.channelType as ChannelType] ?? 4096;
          if (content.length > limit) {
            // Overflow: edit first chunk into existing message, send rest as new messages
            const chunks = chunkByParagraph(content, limit);
            const firstOutMsg: OutboundMessage = adapter.channelType === 'telegram'
              ? { chatId: msg.chatId, html: markdownToTelegram(chunks[0]), threadId }
              : adapter.channelType === 'discord'
                ? { chatId: msg.chatId, text: chunks[0], threadId }
                : { chatId: msg.chatId, text: chunks[0] };
            await adapter.editMessage(msg.chatId, renderer.messageId!, firstOutMsg);
            const target = threadId && adapter.channelType === 'discord' ? threadId : msg.chatId;
            for (let i = 1; i < chunks.length; i++) {
              const overflowMsg: OutboundMessage = adapter.channelType === 'telegram'
                ? { chatId: target, html: markdownToTelegram(chunks[i]) }
                : { chatId: target, text: chunks[i] };
              await adapter.send(overflowMsg);
            }
          } else {
            await adapter.editMessage(msg.chatId, renderer.messageId!, outMsg);
          }
        }
      },
    });

    let completedStats: import('./cost-tracker.js').UsageStats | undefined;

    // When an AskUserQuestion is approved, auto-allow the next permission request
    // to avoid redundant confirmation (e.g. "delete this?" → yes → Bash permission)
    let askQuestionApproved = false;

    // Build SDK-level permission handler based on /perm mode
    const permMode = this.state.getPermMode(msg.channelType, msg.chatId);
    const sdkPermissionHandler = permMode === 'on'
      ? async (toolName: string, toolInput: Record<string, unknown>, promptSentence: string, signal?: AbortSignal) => {
          // Check dynamic whitelist — auto-allow if previously approved
          if (this.permissions.isToolAllowed(toolName, toolInput)) {
            console.log(`[bridge] Auto-allowed ${toolName} via session whitelist`);
            return 'allow' as const;
          }

          // Auto-allow if user just approved an AskUserQuestion
          if (askQuestionApproved) {
            askQuestionApproved = false;
            console.log(`[bridge] Auto-allowed ${toolName} after AskUserQuestion approval`);
            return 'allow' as const;
          }

          const permId = `sdk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const chatKey = this.state.stateKey(msg.channelType, msg.chatId);
          this.permissions.setPendingSdkPerm(chatKey, permId);
          console.log(`[bridge] Permission request: ${toolName} (${permId}) for ${chatKey}`);

          // If SDK aborts (subagent stopped), clean up gateway entry and remove from queue
          const abortCleanup = () => {
            console.log(`[bridge] Permission cancelled by SDK: ${toolName} (${permId})`);
            this.permissions.getGateway().resolve(permId, 'deny', 'Cancelled by SDK');
            this.permissions.clearPendingSdkPerm(chatKey);
            renderer.onPermissionResolved(permId);
          };
          if (signal?.aborted) { abortCleanup(); return 'deny' as const; }
          signal?.addEventListener('abort', abortCleanup, { once: true });

          // Render permission inline in the terminal card
          const inputStr = getToolCommand(toolName, toolInput)
            || JSON.stringify(toolInput, null, 2);
          const buttons: Array<{ label: string; callbackData: string; style: string }> = [
            { label: '✅ Allow', callbackData: `perm:allow:${permId}`, style: 'primary' },
            { label: '❌ Deny', callbackData: `perm:deny:${permId}`, style: 'danger' },
          ];
          renderer.onPermissionNeeded(toolName, inputStr, permId, buttons);

          // Wait for user response (5 min timeout)
          const result = await this.permissions.getGateway().waitFor(permId, {
            timeoutMs: 5 * 60 * 1000,
            onTimeout: () => {
              this.permissions.clearPendingSdkPerm(chatKey);
              console.warn(`[bridge] Permission timeout: ${toolName} (${permId})`);
            },
          });
          signal?.removeEventListener('abort', abortCleanup);
          renderer.onPermissionResolved(permId);

          // Update timeout reminder message if it was sent
          if (permissionReminderMsgId) {
            const icon = result.behavior === 'deny' ? '❌' : '✅';
            const label = `${permissionReminderTool}: ${permissionReminderInput} ${icon}`;
            adapter.editMessage(msg.chatId, permissionReminderMsgId, {
              chatId: msg.chatId,
              text: label,
            }).catch(() => {});
            permissionReminderMsgId = undefined;
          }

          this.permissions.clearPendingSdkPerm(chatKey);
          console.log(`[bridge] Permission resolved: ${toolName} (${permId}) → ${result.behavior}`);
          return result.behavior as 'allow' | 'allow_always' | 'deny';
        }
      : undefined;

    // Build SDK-level AskUserQuestion handler
    const sdkAskQuestionHandler = async (
      questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }>,
      signal?: AbortSignal,
    ): Promise<Record<string, string>> => {
      if (!questions.length) return {};
      const q = questions[0];
      const permId = `askq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Build question text
      const header = q.header ? `📋 **${q.header}**\n\n` : '';
      const optionsList = q.options
        .map((opt, i) => `${i + 1}. **${opt.label}**${opt.description ? ` — ${opt.description}` : ''}`)
        .join('\n');
      const questionText = `${header}${q.question}\n\n${optionsList}`;

      // Build option buttons: multiSelect uses toggle+submit, singleSelect uses direct select
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

      // Store question data for answer resolution (also needed for toggle state)
      const { sdkQuestionData } = this.sdkEngine.getQuestionState();
      sdkQuestionData.set(permId, { questions, chatId: msg.chatId });
      // Store in permission coordinator for toggle tracking (reuse hookQuestionData)
      if (isMulti) {
        this.permissions.storeQuestionData(permId, questions);
      }

      // Create gateway entry BEFORE sending — prevents race condition where user
      // replies before waitFor is called, causing isPending() to return false
      const abortCleanup = () => {
        this.permissions.getGateway().resolve(permId, 'deny', 'Cancelled');
        sdkQuestionData.delete(permId);
      };
      if (signal?.aborted) { abortCleanup(); throw new Error('Cancelled'); }
      signal?.addEventListener('abort', abortCleanup, { once: true });
      const waitPromise = this.permissions.getGateway().waitFor(permId, {
        timeoutMs: 5 * 60 * 1000,
        onTimeout: () => { sdkQuestionData.delete(permId); },
      });

      // Send question card AFTER gateway entry exists — user replies are now safe
      const hint = isMulti
        ? (msg.channelType === 'feishu' ? '\n\n💬 点击选项切换选中，然后按 Submit 确认' : '\n\n💬 Tap options to toggle, then Submit')
        : (msg.channelType === 'feishu' ? '\n\n💬 回复数字选择，或直接输入内容' : '\n\n💬 Reply with number to select, or type your answer');

      const outMsg: import('../channels/types.js').OutboundMessage = {
        chatId: msg.chatId,
        text: msg.channelType !== 'telegram' ? questionText + hint : undefined,
        html: msg.channelType === 'telegram' ? questionText.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>') + hint : undefined,
        buttons,
        feishuHeader: msg.channelType === 'feishu' ? { template: 'blue', title: '❓ Question' } : undefined,
      };
      const sendResult = await adapter.send(outMsg);
      this.permissions.trackPermissionMessage(sendResult.messageId, permId, binding.sessionId, msg.channelType);

      // Await user answer
      const result = await waitPromise;
      signal?.removeEventListener('abort', abortCleanup);

      if (result.behavior === 'deny') {
        sdkQuestionData.delete(permId);
        // Throw so provider returns { behavior: 'deny' } — Claude stops asking
        adapter.editMessage(msg.chatId, sendResult.messageId, {
          chatId: msg.chatId,
          text: '⏭ Skipped',
          buttons: [],
          feishuHeader: msg.channelType === 'feishu' ? { template: 'grey', title: '⏭ Skipped' } : undefined,
        }).catch(() => {});
        throw new Error('User skipped question');
      }

      // User answered — auto-allow the next tool permission in this query
      askQuestionApproved = true;

      // Check for free text answer first, then option index
      const { sdkQuestionTextAnswers, sdkQuestionAnswers } = this.sdkEngine.getQuestionState();
      const textAnswer = sdkQuestionTextAnswers.get(permId);
      sdkQuestionTextAnswers.delete(permId);
      sdkQuestionData.delete(permId);

      if (textAnswer !== undefined) {
        // Free text reply
        adapter.editMessage(msg.chatId, sendResult.messageId, {
          chatId: msg.chatId,
          text: `✅ Answer: ${truncate(textAnswer, 50)}`,
          buttons: [],
          feishuHeader: msg.channelType === 'feishu' ? { template: 'green', title: '✅ Answered' } : undefined,
        }).catch(() => {});
        return { [q.question]: textAnswer };
      }

      // Option index reply (button callback already edited the message — skip redundant edit)
      const optionIndex = sdkQuestionAnswers.get(permId);
      sdkQuestionAnswers.delete(permId);
      const selected = optionIndex !== undefined ? q.options[optionIndex] : undefined;
      const answerLabel = selected?.label ?? '';

      if (!selected) {
        // Button callback already edited the card; only update if we somehow have no answer
        adapter.editMessage(msg.chatId, sendResult.messageId, {
          chatId: msg.chatId,
          text: '✅ Answered',
          buttons: [],
          feishuHeader: msg.channelType === 'feishu' ? { template: 'green', title: '✅ Answered' } : undefined,
        }).catch(() => {});
      }

      return { [q.question]: answerLabel };
    };

    try {
      const result = await this.engine.processMessage({
        sdkSessionId: binding.sdkSessionId,
        workingDirectory: binding.cwd || defaultWorkdir,
        text: msg.text,
        attachments: msg.attachments,
        sdkPermissionHandler,
        sdkAskQuestionHandler,
        effort: this.state.getEffort(msg.channelType, msg.chatId),
        model: this.state.getModel(msg.channelType, msg.chatId),
        onControls: (ctrl) => {
          const chatKey = this.state.stateKey(msg.channelType, msg.chatId);
          this.sdkEngine.setControlsForChat(chatKey, ctrl);
        },
        onSdkSessionId: async (id) => {
          binding.sdkSessionId = id;
          await store.saveBinding(binding);
        },
        onTextDelta: (delta) => renderer.onTextDelta(delta),
        onToolStart: (event) => {
          renderer.onToolStart(event.name, event.input);
        },
        onToolResult: (_event) => {
          renderer.onToolComplete(_event.toolUseId);
        },
        onAgentStart: (data) => {
          renderer.onToolStart('Agent', { description: data.description, prompt: '' });
        },
        onAgentProgress: (data) => {
          // Update progress for long-running agents
          if (data.usage?.durationMs) {
            renderer.onToolProgress({ toolName: 'Agent', elapsed: data.usage.durationMs });
          }
        },
        onAgentComplete: (_data) => {
          renderer.onToolComplete('agent-complete');
        },
        onToolProgress: (data) => {
          renderer.onToolProgress(data);
        },
        onRateLimit: (data) => {
          if (data.status === 'rejected') {
            renderer.onTextDelta('\n⚠️ Rate limited. Retrying...\n');
          } else if (data.status === 'allowed_warning' && data.utilization) {
            renderer.onTextDelta(`\n⚠️ Rate limit: ${Math.round(data.utilization * 100)}% used\n`);
          }
        },
        onQueryResult: async (event) => {
          if (event.permissionDenials?.length) {
            console.warn(`[bridge] Permission denials: ${event.permissionDenials.map(d => d.toolName).join(', ')}`);
          }
          const usage = { input_tokens: event.usage.inputTokens, output_tokens: event.usage.outputTokens, cost_usd: event.usage.costUsd };
          completedStats = costTracker.finish(usage);
          // Wait for final message to be sent
          await renderer.onComplete();
        },
        onPromptSuggestion: (suggestion) => {
          // Send as a quick-reply button after the response completes
          const chatId = threadId && adapter.channelType === 'discord' ? threadId : msg.chatId;
          const truncated = truncate(suggestion, 60);
          adapter.send({
            chatId,
            text: `💡 ${truncated}`,
            buttons: [{ label: '💡 ' + truncated, callbackData: `suggest:${suggestion.slice(0, 200)}`, style: 'default' as const }],
          }).catch(() => {});
        },
        onError: async (err) => {
          await renderer.onError(err);
        },
      });

      // Success: change to done reaction
      adapter.addReaction(reactionChatId, msg.messageId, reactions.done).catch(() => {});
    } catch (err) {
      // Error: change to error reaction
      adapter.addReaction(reactionChatId, msg.messageId, reactions.error).catch(() => {});
      throw err;
    } finally {
      clearInterval(typingInterval);
      renderer.dispose();
      this.sdkEngine.setControlsForChat(this.state.stateKey(msg.channelType, msg.chatId), undefined);
      // Close Feishu streaming card (no-op: streaming disabled)
      // if (feishuSession) { feishuSession.close().catch(() => {}); }
    }

    return true;
  }

}
