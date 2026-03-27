import { BaseChannelAdapter, createAdapter } from '../channels/base.js';
import type { InboundMessage, OutboundMessage } from '../channels/types.js';
import { ConversationEngine } from './conversation.js';
import { ChannelRouter } from './router.js';
import { PermissionBroker } from '../permissions/broker.js';
import { PendingPermissions } from '../permissions/gateway.js';
import { DeliveryLayer } from '../delivery/delivery.js';
import { getBridgeContext } from '../context.js';
import { resolveProvider } from '../providers/index.js';
import type { LLMProvider } from '../providers/base.js';
import { loadConfig } from '../config.js';
import { markdownToTelegram } from '../markdown/index.js';
import { downgradeHeadings } from '../markdown/feishu.js';
import { TerminalCardRenderer, type VerboseLevel } from './terminal-card-renderer.js';
import { SessionStateManager } from './session-state.js';
import { PermissionCoordinator } from './permission-coordinator.js';
import { CommandRouter } from './command-router.js';
import type { FeishuStreamingSession } from '../channels/feishu-streaming.js';
import { CostTracker } from './cost-tracker.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';

/** Bridge commands handled synchronously (don't block adapter loop) */
const QUICK_COMMANDS = new Set(['/new', '/status', '/verbose', '/hooks', '/sessions', '/session', '/help', '/perm', '/effort', '/stop', '/approve', '/pairings', '/runtime']);

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
  private coreAvailable = false;
  private state = new SessionStateManager();
  private permissions: PermissionCoordinator;
  /** Active query controls per chat — for /stop command */
  private activeControls = new Map<string, import('../providers/base.js').QueryControls>();
  private lastChatId = new Map<string, string>();
  /** Pending image attachments waiting for a text message to merge with (key: channelType:chatId) */
  private pendingAttachments = new Map<string, { attachments: import('../channels/types.js').FileAttachment[]; timestamp: number }>();

  private commands: CommandRouter;
  private chatIdFile: string;
  /** Cached LLM providers keyed by runtime name */
  private providerCache = new Map<string, LLMProvider>();

  constructor() {
    const config = loadConfig();
    const effectivePublicUrl = config.publicUrl || `http://${getLocalIP()}:${config.port || 8080}`;
    const gateway = new PendingPermissions();
    const broker = new PermissionBroker(gateway, effectivePublicUrl);
    this.coreUrl = config.coreUrl;
    this.token = config.token;
    this.permissions = new PermissionCoordinator(gateway, broker, this.coreUrl, this.token);
    // Load persisted chatIds (so hook routing works without needing a message first)
    this.chatIdFile = join(homedir(), '.tlive', 'runtime', 'chat-ids.json');
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
      this.activeControls,
      this.permissions,
    );
  }

  /** Expose coreAvailable flag for main.ts polling loop */
  setCoreAvailable(available: boolean): void {
    this.coreAvailable = available;
  }

  /** Returns all active adapters */
  getAdapters(): BaseChannelAdapter[] {
    return Array.from(this.adapters.values());
  }

  /** Get the last active chatId for a given channel type (for hook routing) */
  getLastChatId(channelType: string): string {
    return this.lastChatId.get(channelType) ?? '';
  }

  /** Resolve LLM provider for a chat — uses per-chat runtime if set, else global default */
  private getProvider(channelType: string, chatId: string): LLMProvider {
    const runtime = this.state.getRuntime(channelType, chatId);
    if (!runtime) return getBridgeContext().llm;

    if (!this.providerCache.has(runtime)) {
      this.providerCache.set(runtime, resolveProvider(runtime, this.permissions.getGateway()));
    }
    return this.providerCache.get(runtime)!;
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
  }

  async stop(): Promise<void> {
    this.running = false;
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

    if (hookType === 'stop') {
      type = 'stop';
      const raw = (hook.last_assistant_message || hook.last_output || '').trim();
      summary = raw ? (raw.length > 3000 ? raw.slice(0, 2997) + '...' : raw) : undefined;
      title = 'Terminal';
    } else if (hook.notification_type === 'idle_prompt') {
      title = 'Terminal · ' + (hook.message || 'Waiting for input...');
      type = 'idle_prompt';
    } else {
      title = hook.message || 'Notification';
      type = 'generic';
    }

    let terminalUrl: string | undefined;
    if (this.coreAvailable && hook.tlive_session_id) {
      const config = loadConfig();
      const baseUrl = config.publicUrl || `http://${getLocalIP()}:${config.port || 8080}`;
      terminalUrl = `${baseUrl}/terminal.html?id=${hook.tlive_session_id}&token=${this.token}`;
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
      const msg = await adapter.consumeOne();
      if (!msg) { await new Promise(r => setTimeout(r, 100)); continue; }
      console.log(`[${adapter.channelType}] Message from ${msg.userId}: ${msg.text || '(callback)'}`);
      // Callbacks, commands, and permission text are fast — await them.
      // Regular messages (Claude queries) are fire-and-forget so they don't
      // block the loop while waiting for LLM responses or permission approvals.
      const isQuickMessage = !!msg.callbackData
        || (msg.text && QUICK_COMMANDS.has(msg.text.split(' ')[0].toLowerCase()))
        || this.permissions.parsePermissionText(msg.text || '') !== null;
      if (isQuickMessage) {
        try {
          await this.handleInboundMessage(adapter, msg);
        } catch (err) {
          console.error(`[${adapter.channelType}] Error handling message:`, err);
        }
      } else {
        // Guard: if this chat is already processing a message, tell the user
        const chatKey = this.state.stateKey(msg.channelType, msg.chatId);
        if (this.state.isProcessing(chatKey)) {
          await adapter.send({ chatId: msg.chatId, text: '⏳ Previous message still processing, please wait...' }).catch(() => {});
          continue;
        }
        this.state.setProcessing(chatKey, true);
        this.handleInboundMessage(adapter, msg)
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
      // Persist so hooks work even after Bridge restart
      try {
        mkdirSync(join(homedir(), '.tlive', 'runtime'), { recursive: true });
        writeFileSync(this.chatIdFile, JSON.stringify(Object.fromEntries(this.lastChatId)));
      } catch { /* non-fatal */ }
    }

    // Image buffering: cache image-only messages, merge into next text message
    const attachKey = `${msg.channelType}:${msg.chatId}`;
    if (msg.attachments?.length && !msg.text && !msg.callbackData) {
      // Image-only message: buffer attachments and wait for text
      this.pendingAttachments.set(attachKey, {
        attachments: msg.attachments,
        timestamp: Date.now(),
      });
      console.log(`[${msg.channelType}] Buffered ${msg.attachments.length} attachment(s), waiting for text`);
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

    // Reply routing: quote-reply to a hook message → send to PTY stdin
    if ((msg.text || msg.attachments?.length) && msg.replyToMessageId && this.permissions.isHookMessage(msg.replyToMessageId)) {
      const entry = this.permissions.getHookMessage(msg.replyToMessageId)!;
      if (entry.sessionId && this.coreAvailable) {
        try {
          // If images attached, save as temp files and include paths in the text
          let inputText = msg.text || '';
          if (msg.attachments?.length) {
            const { writeFileSync, mkdirSync } = await import('node:fs');
            const { join } = await import('node:path');
            const { tmpdir } = await import('node:os');
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

      // Hook permission callbacks (hook:allow:ID:sessionId, hook:allow_always:ID:sessionId, hook:deny:ID:sessionId)
      if (msg.callbackData.startsWith('hook:')) {
        const parts = msg.callbackData.split(':');
        const decision = parts[1]; // allow, allow_always, or deny
        const hookId = parts[2];
        const sessionId = parts[3] || '';
        await this.permissions.resolveHookCallback(hookId, decision, sessionId, msg.messageId, adapter, msg.chatId, this.coreAvailable);
        return true;
      }

      // Graduated permission callbacks
      if (msg.callbackData.startsWith('perm:allow_edits:')) {
        const permId = msg.callbackData.split(':').slice(2).join(':');
        this.permissions.getGateway().resolve(permId, 'allow');
        // Edit tools allowed via acceptEdits mode — no whitelist needed, SDK handles it
        if (msg.messageId) {
          adapter.editMessage(msg.chatId, msg.messageId, { chatId: msg.chatId, text: '✅ Allowed (all edits)' }).catch(() => {});
        }
        return true;
      }

      if (msg.callbackData.startsWith('perm:allow_tool:')) {
        const parts = msg.callbackData.split(':');
        const permId = parts[2];
        const toolName = parts.slice(3).join(':');
        this.permissions.getGateway().resolve(permId, 'allow');
        this.permissions.addAllowedTool(toolName);
        console.log(`[bridge] Added ${toolName} to session whitelist`);
        if (msg.messageId) {
          adapter.editMessage(msg.chatId, msg.messageId, { chatId: msg.chatId, text: `✅ Allowed (${toolName} for session)` }).catch(() => {});
        }
        return true;
      }

      if (msg.callbackData.startsWith('perm:allow_bash:')) {
        const parts = msg.callbackData.split(':');
        const permId = parts[2];
        const prefix = parts.slice(3).join(':');
        this.permissions.getGateway().resolve(permId, 'allow');
        this.permissions.addAllowedBashPrefix(prefix);
        console.log(`[bridge] Added Bash(${prefix} *) to session whitelist`);
        if (msg.messageId) {
          adapter.editMessage(msg.chatId, msg.messageId, { chatId: msg.chatId, text: `✅ Allowed (Bash ${prefix} * for session)` }).catch(() => {});
        }
        return true;
      }

      // Regular permission broker callbacks (perm:allow:ID, perm:deny:ID, perm:allow_session:ID)
      console.log(`[bridge] Perm callback: ${msg.callbackData}, gateway pending: ${this.permissions.getGateway().pendingCount()}`);
      const resolved = this.permissions.handleBrokerCallback(msg.callbackData);
      console.log(`[bridge] Perm resolved: ${resolved}`);
      // Shrink the card to a single line — no "撤回" notice, no flooding.
      if (msg.messageId) {
        const action = resolved ? (msg.callbackData.split(':')[1] || 'allow') : 'expired';
        const label = action === 'deny' ? '❌' : action === 'allow_session' ? '📌' : action === 'expired' ? '⏳' : '✅';
        adapter.editMessage(msg.chatId, msg.messageId, {
          chatId: msg.chatId,
          text: label,
        }).catch(() => {});
      }
      // If not resolved (expired/cancelled), silently ignore
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
      const newSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await this.router.rebind(msg.channelType, msg.chatId, newSessionId);
      this.state.clearThread(msg.channelType, msg.chatId);
      this.permissions.clearSessionWhitelist();
    }

    const binding = await this.router.resolve(msg.channelType, msg.chatId);

    // Resolve threadId: use existing thread if message came from one, or reuse session thread
    let threadId = msg.threadId;
    if (!threadId && adapter.channelType === 'discord') {
      threadId = this.state.getThread(msg.channelType, msg.chatId);
    }
    // For Telegram topics, always pass threadId through
    if (!threadId && msg.threadId) {
      threadId = msg.threadId;
    }

    // Reaction target: for Discord threads, reaction goes on the original channel message
    const reactionChatId = msg.chatId;

    // Start typing heartbeat (in thread if available)
    const typingTarget = threadId && adapter.channelType === 'discord' ? threadId : msg.chatId;
    const typingInterval = setInterval(() => {
      adapter.sendTyping(typingTarget).catch(() => {});
    }, 4000);
    adapter.sendTyping(typingTarget).catch(() => {});

    const verboseLevel = this.state.getVerboseLevel(msg.channelType, msg.chatId);
    const costTracker = new CostTracker();
    costTracker.start();

    // Add processing reaction
    const reactionEmojis: Record<string, { processing: string; done: string; error: string }> = {
      telegram: { processing: '\u{1F914}', done: '\u{1F44D}', error: '\u{1F631}' },
      feishu: { processing: 'Typing', done: 'OK', error: 'FACEPALM' },
      discord: { processing: '\u{1F914}', done: '\u{1F44D}', error: '\u{274C}' },
    };
    const reactions = reactionEmojis[adapter.channelType] || reactionEmojis.telegram;
    adapter.addReaction(reactionChatId, msg.messageId, reactions.processing).catch(() => {});

    // Feishu: use CardKit streaming session for smoother rendering
    let feishuSession: FeishuStreamingSession | null = null;
    if (adapter.channelType === 'feishu' && 'createStreamingSession' in adapter) {
      feishuSession = (adapter as any).createStreamingSession(msg.chatId, msg.receiveIdType);
    }

    const platformLimits: Record<string, number> = { telegram: 4096, discord: 2000, feishu: 30000 };
    const windowSizes: Record<string, number> = { telegram: 5, discord: 6, feishu: 8 };
    const renderer = new TerminalCardRenderer({
      verboseLevel,
      platformLimit: platformLimits[adapter.channelType] ?? 4096,
      throttleMs: 300,
      windowSize: windowSizes[adapter.channelType] ?? 8,
      flushCallback: async (content, isEdit) => {
        // Feishu streaming path
        if (feishuSession) {
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
          outMsg = { chatId: msg.chatId, text: content, feishuHeader: { template: 'blue', title: '💬 Claude' } };
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
          await adapter.editMessage(msg.chatId, renderer.messageId!, outMsg);
        }
      },
    });

    let completedStats: import('./cost-tracker.js').UsageStats | undefined;
    const toolIdMap = new Map<string, string>(); // SDK tool_use_id → renderer tool ID

    // Build SDK-level permission handler based on /perm mode
    const permMode = this.state.getPermMode(msg.channelType, msg.chatId);
    const sdkPermissionHandler = permMode === 'on'
      ? async (toolName: string, toolInput: Record<string, unknown>, promptSentence: string, signal?: AbortSignal) => {
          // Check dynamic whitelist — auto-allow if previously approved
          if (this.permissions.isToolAllowed(toolName, toolInput)) {
            console.log(`[bridge] Auto-allowed ${toolName} via session whitelist`);
            return 'allow' as const;
          }

          const permId = `sdk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const chatKey = this.state.stateKey(msg.channelType, msg.chatId);
          this.permissions.setPendingSdkPerm(chatKey, permId);
          console.log(`[bridge] Permission request: ${toolName} (${permId}) for ${chatKey}`);

          // If SDK aborts (subagent stopped), clean up gateway entry immediately
          const abortCleanup = () => {
            console.log(`[bridge] Permission cancelled by SDK: ${toolName} (${permId})`);
            this.permissions.getGateway().resolve(permId, 'deny', 'Cancelled by SDK');
            this.permissions.clearPendingSdkPerm(chatKey);
          };
          if (signal?.aborted) { abortCleanup(); return 'deny' as const; }
          signal?.addEventListener('abort', abortCleanup, { once: true });

          // Render permission inline in the terminal card
          const inputStr = typeof toolInput === 'string'
            ? toolInput as string
            : JSON.stringify(toolInput, null, 2);
          const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
          const buttons: Array<{ label: string; callbackData: string; style: string }> = [
            { label: '✅ Yes', callbackData: `perm:allow:${permId}`, style: 'primary' },
          ];

          if (EDIT_TOOLS.has(toolName)) {
            buttons.push({ label: '✅ Allow all edits', callbackData: `perm:allow_edits:${permId}`, style: 'default' });
          } else if (toolName === 'Bash') {
            const cmd = typeof toolInput.command === 'string' ? toolInput.command : '';
            const prefix = this.permissions.extractBashPrefix(cmd);
            if (prefix) {
              buttons.push({ label: `✅ Bash(${prefix} *)`, callbackData: `perm:allow_bash:${permId}:${prefix}`, style: 'default' });
            }
          } else {
            buttons.push({ label: `✅ Allow ${toolName}`, callbackData: `perm:allow_tool:${permId}:${toolName}`, style: 'default' });
          }

          buttons.push({ label: '❌ No', callbackData: `perm:deny:${permId}`, style: 'danger' });
          renderer.onPermissionNeeded(toolName, inputStr, promptSentence, buttons);

          // Send buttons as separate message (IM platforms need interactive buttons)
          try {
            const targetChatId = threadId && adapter.channelType === 'discord' ? threadId : msg.chatId;
            await adapter.send({
              chatId: targetChatId,
              text: `🔐 ${toolName}`,
              buttons: buttons.map(b => ({ ...b, style: b.style as 'primary' | 'danger' | 'default' })),
            });
          } catch (err) {
            console.warn(`[bridge] Failed to send permission buttons: ${err}`);
          }

          // Wait for user response (5 min timeout)
          const result = await this.permissions.getGateway().waitFor(permId, {
            timeoutMs: 5 * 60 * 1000,
            onTimeout: () => {
              this.permissions.clearPendingSdkPerm(chatKey);
              console.warn(`[bridge] Permission timeout: ${toolName} (${permId})`);
            },
          });
          signal?.removeEventListener('abort', abortCleanup);
          renderer.onPermissionResolved();
          this.permissions.clearPendingSdkPerm(chatKey);
          console.log(`[bridge] Permission resolved: ${toolName} (${permId}) → ${result.behavior}`);
          return result.behavior as 'allow' | 'allow_always' | 'deny';
        }
      : undefined;

    try {
      const result = await this.engine.processMessage({
        sessionId: binding.sessionId,
        text: msg.text,
        attachments: msg.attachments,
        llm: this.getProvider(msg.channelType, msg.chatId),
        sdkPermissionHandler,
        effort: this.state.getEffort(msg.channelType, msg.chatId),
        onControls: (ctrl) => {
          const chatKey = this.state.stateKey(msg.channelType, msg.chatId);
          this.activeControls.set(chatKey, ctrl);
        },
        onTextDelta: (delta) => renderer.onTextDelta(delta),
        onToolStart: (event) => {
          const parentId = (event as any).parentToolUseId ? toolIdMap.get((event as any).parentToolUseId) ?? (event as any).parentToolUseId : undefined;
          const rendererToolId = renderer.onToolStart(event.name, event.input, parentId);
          if (event.id) toolIdMap.set(event.id, rendererToolId);
        },
        onToolResult: (event) => {
          const rendererToolId = toolIdMap.get(event.toolUseId) ?? event.toolUseId;
          renderer.onToolComplete(rendererToolId, event.content, event.isError);
        },
        onAgentStart: (data) => {
          const toolUseId = data.taskId ? (toolIdMap.get(data.taskId) ?? data.taskId) : undefined;
          renderer.onAgentStart(data.description, toolUseId);
        },
        onAgentProgress: (data) => {
          const usage = data.usage ? { tool_uses: data.usage.toolUses, duration_ms: data.usage.durationMs } : undefined;
          renderer.onAgentProgress(data.description, data.lastTool, usage);
        },
        onAgentComplete: (data) => renderer.onAgentComplete(data.summary, data.status as 'completed' | 'failed' | 'stopped'),
        onToolProgress: (data) => {
          renderer.onAgentProgress(`${data.toolName} running...`, undefined, { tool_uses: 0, duration_ms: data.elapsed * 1000 });
        },
        onRateLimit: (data) => {
          if (data.status === 'rejected') {
            renderer.onTextDelta('\n⚠️ Rate limited. Retrying...\n');
          } else if (data.status === 'allowed_warning' && data.utilization) {
            renderer.onTextDelta(`\n⚠️ Rate limit: ${Math.round(data.utilization * 100)}% used\n`);
          }
        },
        onQueryResult: (event) => {
          if (event.permissionDenials?.length) {
            console.warn(`[bridge] Permission denials: ${event.permissionDenials.map(d => d.toolName).join(', ')}`);
          }
          const usage = { input_tokens: event.usage.inputTokens, output_tokens: event.usage.outputTokens, cost_usd: event.usage.costUsd };
          completedStats = costTracker.finish(usage);
          if (verboseLevel > 0) {
            renderer.onComplete(completedStats);
          }
        },
        onPromptSuggestion: (suggestion) => {
          // Send as a quick-reply button after the response completes
          const chatId = threadId && adapter.channelType === 'discord' ? threadId : msg.chatId;
          const truncated = suggestion.length > 60 ? suggestion.slice(0, 57) + '...' : suggestion;
          adapter.send({
            chatId,
            text: `💡 ${truncated}`,
            buttons: [{ label: '💡 ' + truncated, callbackData: `suggest:${suggestion.slice(0, 200)}`, style: 'default' as const }],
          }).catch(() => {});
        },
        onError: (err) => renderer.onError(err),
      });

      // Level 0: deliver final response via delivery layer (renderer didn't flush text)
      if (verboseLevel === 0) {
        const responseText = renderer.getResponseText().trim() || result.text.trim();
        if (!completedStats) {
          const usage = {
            input_tokens: result.usage?.inputTokens ?? 0,
            output_tokens: result.usage?.outputTokens ?? 0,
            cost_usd: result.usage?.costUsd,
          };
          completedStats = costTracker.finish(usage);
        }
        const costLine = CostTracker.format(completedStats);
        const fullText = responseText ? `${responseText}\n${costLine}` : costLine;
        const deliverTarget = threadId && adapter.channelType === 'discord' ? threadId : msg.chatId;
        await this.delivery.deliver(adapter, deliverTarget, fullText, {
          platformLimit: platformLimits[adapter.channelType] ?? 4096,
        });
      }
      // Success: change to done reaction
      adapter.addReaction(reactionChatId, msg.messageId, reactions.done).catch(() => {});
    } catch (err) {
      // Error: change to error reaction
      adapter.addReaction(reactionChatId, msg.messageId, reactions.error).catch(() => {});
      throw err;
    } finally {
      clearInterval(typingInterval);
      renderer.dispose();
      this.activeControls.delete(this.state.stateKey(msg.channelType, msg.chatId));
      // Close Feishu streaming card
      if (feishuSession) {
        feishuSession.close().catch(() => {});
      }
    }

    return true;
  }

}
