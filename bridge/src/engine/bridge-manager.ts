import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage, OutboundMessage } from '../channels/types.js';
import { ConversationEngine } from './conversation.js';
import { ChannelRouter } from './router.js';
import { PermissionBroker } from '../permissions/broker.js';
import { PendingPermissions } from '../permissions/gateway.js';
import { chunkByParagraph } from '../delivery/delivery.js';
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
import { CostTracker } from './cost-tracker.js';
import { basename } from 'node:path';
import { networkInterfaces } from 'node:os';
import { generateSessionId } from '../utils/id.js';
import { truncate } from '../utils/string.js';
import { CHANNEL_TYPES, PLATFORM_LIMITS, PLATFORM_REACTIONS, type ChannelType } from '../utils/constants.js';
import { handleCallbackMessage } from './callback-dispatcher.js';
import { IngressCoordinator } from './ingress-coordinator.js';
import { MessageLoopCoordinator } from './message-loop-coordinator.js';
import { TextDispatcher } from './text-dispatcher.js';

/** Bridge commands handled synchronously (don't block adapter loop) */
const QUICK_COMMANDS = new Set(['/new', '/status', '/verbose', '/hooks', '/sessions', '/session', '/help', '/perm', '/effort', '/stop', '/approve', '/pairings', '/settings', '/model', '/bash', '/cd', '/pwd']);

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

/** Detect LAN IP address, matching Go Core's getLocalIP() logic */
function getLocalIP(): string {
  try {
    // Prefer iterating interfaces for a private IPv4 address
    const ifaces = networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const info of ifaces[name] || []) {
        if (info.family === 'IPv4' && !info.internal && isPrivateIPv4(info.address)) {
          return info.address;
        }
      }
    }
  } catch {
    // Some test/container environments can fail interface inspection.
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
  private coreUrl: string;
  private token: string;
  private port: number;
  private coreAvailable = false;
  private state = new SessionStateManager();
  private permissions: PermissionCoordinator;
  /** SDK Engine for LiveSession management */
  private sdkEngine: SDKEngine;
  private ingress = new IngressCoordinator();
  private loop: MessageLoopCoordinator;
  private text: TextDispatcher;

  private commands: CommandRouter;
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
    this.commands = new CommandRouter(
      this.state,
      () => this.adapters,
      this.router,
      () => this.coreAvailable,
      this.sdkEngine.getActiveControls(),
      this.permissions,
      (channelType, chatId) => this.sdkEngine.closeSession(channelType, chatId),
    );
    this.loop = new MessageLoopCoordinator({
      state: this.state,
      sdkEngine: this.sdkEngine,
      permissions: this.permissions,
      quickCommands: QUICK_COMMANDS,
      hasPendingSdkQuestion: (channelType, chatId) => this.text.hasPendingSdkQuestion(channelType, chatId),
    });
    this.text = new TextDispatcher({
      permissions: this.permissions,
      sdkEngine: this.sdkEngine,
      state: this.state,
      coreUrl: this.coreUrl,
      token: this.token,
      isCoreAvailable: () => this.coreAvailable,
    });
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
    return this.ingress.getLastChatId(channelType);
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
      const { sdkQuestionData, sdkQuestionAnswers, sdkQuestionTextAnswers } = this.sdkEngine.getQuestionState();
      for (const [id] of sdkQuestionData) {
        if (!this.permissions.getGateway().isPending(id)) {
          sdkQuestionData.delete(id);
          sdkQuestionAnswers.delete(id);
          sdkQuestionTextAnswers.delete(id);
        }
      }
      this.ingress.pruneStaleState();
    }, 5 * 60 * 1000);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.ingress.dispose();
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

  private async runAdapterLoop(adapter: BaseChannelAdapter): Promise<void> {
    while (this.running) {
      const msg = await this.ingress.getNextMessage(adapter);
      if (!msg) { await new Promise(r => setTimeout(r, 100)); continue; }
      console.log(`[${adapter.channelType}] Message from ${msg.userId}: ${msg.text || '(callback)'}`);
      if (this.loop.isQuickMessage(adapter, msg)) {
        try {
          await this.handleInboundMessage(adapter, msg);
        } catch (err) {
          console.error(`[${adapter.channelType}] Error handling message:`, err);
        }
      } else {
        await this.loop.dispatchSlowMessage({
          adapter,
          msg,
          coalesceMessage: (dispatchAdapter, dispatchMsg) => this.ingress.coalesceMessages(dispatchAdapter, dispatchMsg),
          handleMessage: (dispatchAdapter, dispatchMsg) => this.handleInboundMessage(dispatchAdapter, dispatchMsg),
          onError: (err) => {
            console.error(`[${adapter.channelType}] Error handling message:`, err);
          },
        });
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
      this.ingress.recordChat(adapter.channelType, msg.chatId);
    }

    const attachmentResult = this.ingress.prepareAttachments(msg);
    msg = attachmentResult.message;
    if (attachmentResult.handled) {
      return true;
    }

    if (await this.text.handle(adapter, msg)) {
      return true;
    }

    // Callback data
    if (msg.callbackData) {
      return handleCallbackMessage(adapter, msg, {
        permissions: this.permissions,
        sdkEngine: this.sdkEngine,
        isCoreAvailable: () => this.coreAvailable,
        replayMessage: (replayAdapter, replayMsg) => this.handleInboundMessage(replayAdapter, replayMsg),
      });
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
      model: this.state.getModel(msg.channelType, msg.chatId),
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

    // When an AskUserQuestion is approved, auto-allow the next permission request
    // to avoid redundant confirmation (e.g. "delete this?" → yes → Bash permission)
    let askQuestionApproved = false;

    // Build SDK-level permission handler based on /perm mode
    const permMode = this.state.getPermMode(msg.channelType, msg.chatId);
    const sdkPermissionHandler = permMode === 'on'
      ? async (toolName: string, toolInput: Record<string, unknown>, _promptSentence: string, signal?: AbortSignal) => {
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
      await this.engine.processMessage({
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
        onStatus: (data) => {
          renderer.setModel(data.model);
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
            costTracker.finish(usage);
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
