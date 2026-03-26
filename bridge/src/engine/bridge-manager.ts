import { BaseChannelAdapter, createAdapter } from '../channels/base.js';
import type { InboundMessage, OutboundMessage } from '../channels/types.js';
import { ConversationEngine } from './conversation.js';
import { ChannelRouter } from './router.js';
import { PermissionBroker } from '../permissions/broker.js';
import { PendingPermissions } from '../permissions/gateway.js';
import { DeliveryLayer } from '../delivery/delivery.js';
import { getBridgeContext } from '../context.js';
import { loadConfig } from '../config.js';
import { markdownToTelegram } from '../markdown/index.js';
import { StreamController, type VerboseLevel } from './stream-controller.js';
import type { FeishuStreamingSession } from '../channels/feishu-streaming.js';
import { CostTracker } from './cost-tracker.js';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

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
  private gateway = new PendingPermissions();
  private broker: PermissionBroker;
  private coreUrl: string;
  private token: string;
  private coreAvailable = false;
  private verboseLevels = new Map<string, VerboseLevel>();
  private lastActive = new Map<string, number>();
  private lastChatId = new Map<string, string>();
  /** Deduplicate hook permission resolutions */
  private resolvedHookIds = new Set<string>();
  /** Store original permission card text for card updates after approval */
  private hookPermissionTexts = new Map<string, string>();
  /** Pending image attachments waiting for a text message to merge with (key: channelType:chatId) */
  private pendingAttachments = new Map<string, { attachments: import('../channels/types.js').FileAttachment[]; timestamp: number }>();
  private hookMessages = new Map<string, { sessionId: string; timestamp: number }>();
  private permissionMessages = new Map<string, { permissionId: string; sessionId: string; timestamp: number }>();
  private latestPermission = new Map<string, { permissionId: string; sessionId: string; messageId: string }>();

  private chatIdFile: string;

  constructor() {
    const config = loadConfig();
    this.broker = new PermissionBroker(this.gateway, config.publicUrl);
    this.coreUrl = config.coreUrl;
    this.token = config.token;
    // Load persisted chatIds (so hook routing works without needing a message first)
    this.chatIdFile = join(homedir(), '.tlive', 'runtime', 'chat-ids.json');
    try {
      const data = JSON.parse(readFileSync(this.chatIdFile, 'utf-8'));
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'string') this.lastChatId.set(k, v);
      }
    } catch { /* no saved chat IDs yet */ }
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
    this.gateway.denyAll();
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }
  }

  private stateKey(channelType: string, chatId: string): string {
    return `${channelType}:${chatId}`;
  }

  private getVerboseLevel(channelType: string, chatId: string): VerboseLevel {
    return this.verboseLevels.get(this.stateKey(channelType, chatId)) ?? 1;
  }

  private setVerboseLevel(channelType: string, chatId: string, level: VerboseLevel): void {
    this.verboseLevels.set(this.stateKey(channelType, chatId), level);
  }

  private checkAndUpdateLastActive(channelType: string, chatId: string): boolean {
    const key = this.stateKey(channelType, chatId);
    const last = this.lastActive.get(key);
    const now = Date.now();
    this.lastActive.set(key, now);
    if (last && (now - last) > 30 * 60 * 1000) return true;
    return false;
  }

  private clearLastActive(channelType: string, chatId: string): void {
    this.lastActive.delete(this.stateKey(channelType, chatId));
  }

  /** Track a hook message for reply routing */
  trackHookMessage(messageId: string, sessionId: string): void {
    // Track even without sessionId — reply routing will send to PTY if session exists,
    // and the tracking prevents the reply from being misrouted to the Bridge LLM.
    this.hookMessages.set(messageId, { sessionId: sessionId || '', timestamp: Date.now() });
    // Prune entries older than 24h
    for (const [id, entry] of this.hookMessages) {
      if (Date.now() - entry.timestamp > 24 * 60 * 60 * 1000) this.hookMessages.delete(id);
    }
  }

  /** Track a permission message for text-based approval (Feishu) */
  trackPermissionMessage(messageId: string, permissionId: string, sessionId: string, channelType: string): void {
    this.permissionMessages.set(messageId, { permissionId, sessionId, timestamp: Date.now() });
    this.latestPermission.set(channelType, { permissionId, sessionId, messageId });
    for (const [id, entry] of this.permissionMessages) {
      if (Date.now() - entry.timestamp > 24 * 60 * 60 * 1000) this.permissionMessages.delete(id);
    }
  }

  /** Store original permission card text for later card update */
  storeHookPermissionText(hookId: string, text: string): void {
    this.hookPermissionTexts.set(hookId, text);
  }

  /** Parse text as a permission decision */
  private parsePermissionText(text: string): string | null {
    const t = text.trim().toLowerCase();
    if (['allow', 'a', 'yes', 'y', '允许', '通过'].includes(t)) return 'allow';
    if (['deny', 'd', 'no', 'n', '拒绝', '否'].includes(t)) return 'deny';
    if (['always', '始终允许'].includes(t)) return 'allow_always';
    return null;
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
      title = '🖥 Local';
    } else if (hook.notification_type === 'idle_prompt') {
      title = '🖥 Local · ' + (hook.message || 'Waiting for input...');
      type = 'idle_prompt';
    } else {
      title = hook.message || 'Notification';
      type = 'generic';
    }

    let terminalUrl: string | undefined;
    if (this.coreAvailable && hook.tlive_session_id) {
      const config = loadConfig();
      const baseUrl = config.publicUrl || `http://localhost:${config.port || 8080}`;
      terminalUrl = `${baseUrl}/terminal.html?id=${hook.tlive_session_id}&token=${this.token}`;
    }

    const formatted = formatNotification({ type, title, summary, terminalUrl }, adapter.channelType as any);

    const outMsg: import('../channels/types.js').OutboundMessage = {
      chatId,
      text: formatted.text,
      html: formatted.html,
      embed: formatted.embed,
      feishuHeader: formatted.feishuHeader,
      feishuElements: (formatted as any).feishuElements,
      receiveIdType,
    };
    const result = await adapter.send(outMsg);
    this.trackHookMessage(result.messageId, hook.tlive_session_id || '');
  }

  private async runAdapterLoop(adapter: BaseChannelAdapter): Promise<void> {
    while (this.running) {
      const msg = await adapter.consumeOne();
      if (!msg) { await new Promise(r => setTimeout(r, 100)); continue; }
      console.log(`[${adapter.channelType}] Message from ${msg.userId}: ${msg.text || '(callback)'}`);
      try {
        await this.handleInboundMessage(adapter, msg);
      } catch (err) {
        console.error(`[${adapter.channelType}] Error handling message:`, err);
      }
    }
  }

  async handleInboundMessage(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    // Auth check
    if (!adapter.isAuthorized(msg.userId, msg.chatId)) return false;

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

    // Text-based permission resolution (Feishu only — Telegram/Discord use card action callbacks)
    if (msg.text && adapter.channelType === 'feishu') {
      const decision = this.parsePermissionText(msg.text);
      if (decision) {
        // Check quote-reply first, fall back to latest pending permission (only if unambiguous)
        let permEntry = msg.replyToMessageId ? this.permissionMessages.get(msg.replyToMessageId) : undefined;
        if (!permEntry) {
          // Only use fallback if exactly one permission is pending (avoid multi-session ambiguity)
          if (this.permissionMessages.size === 1) {
            const latest = this.latestPermission.get(adapter.channelType);
            if (latest) permEntry = this.permissionMessages.get(latest.messageId);
          } else if (this.permissionMessages.size > 1) {
            await adapter.send({ chatId: msg.chatId, text: '⚠️ 多个权限待审批，请引用回复具体的权限消息' });
            return true;
          }
        }
        if (permEntry && this.coreAvailable) {
          try {
            await fetch(`${this.coreUrl}/api/hooks/permission/${permEntry.permissionId}/resolve`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ decision }),
              signal: AbortSignal.timeout(5000),
            });
            const label = decision === 'deny' ? '❌ Denied' : decision === 'allow_always' ? '📌 Always allowed' : '✅ Allowed';
            await adapter.send({ chatId: msg.chatId, text: label });
            // Clean up
            for (const [id, e] of this.permissionMessages) {
              if (e.permissionId === permEntry.permissionId) this.permissionMessages.delete(id);
            }
            const latest = this.latestPermission.get(adapter.channelType);
            if (latest?.permissionId === permEntry.permissionId) this.latestPermission.delete(adapter.channelType);
          } catch (err) {
            await adapter.send({ chatId: msg.chatId, text: `❌ Failed to resolve: ${err}` });
          }
          return true;
        }
      }
    }

    // Reply routing: quote-reply to a hook message → send to PTY stdin
    if ((msg.text || msg.attachments?.length) && msg.replyToMessageId && this.hookMessages.has(msg.replyToMessageId)) {
      const entry = this.hookMessages.get(msg.replyToMessageId)!;
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
      // Hook permission callbacks (hook:allow:ID:sessionId, hook:allow_always:ID:sessionId, hook:deny:ID:sessionId)
      if (msg.callbackData.startsWith('hook:')) {
        const parts = msg.callbackData.split(':');
        const decision = parts[1]; // allow, allow_always, or deny
        const hookId = parts[2];
        const sessionId = parts[3] || '';

        // Deduplicate: skip if already resolved
        if (this.resolvedHookIds.has(hookId)) return true;
        this.resolvedHookIds.add(hookId);

        if (this.coreAvailable) {
          try {
            await fetch(`${this.coreUrl}/api/hooks/permission/${hookId}/resolve`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${this.token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ decision }),
              signal: AbortSignal.timeout(5000),
            });
            const labels: Record<string, string> = {
              allow: '✅ Allowed',
              allow_always: '📌 Always Allowed',
              deny: '❌ Denied',
            };
            const label = labels[decision] || '✅ Allowed';
            // Rebuild original permission text + disabled buttons showing result
            const permEntry = this.permissionMessages.get(msg.messageId);
            const originalText = this.hookPermissionTexts.get(hookId) || '';
            await adapter.editMessage(msg.chatId, msg.messageId, {
              chatId: msg.chatId,
              text: originalText + `\n\n${label}`,
              feishuHeader: {
                template: decision === 'deny' ? 'red' : 'green',
                title: label,
              },
              // No buttons — they're removed after approval
            });
            // Use messageId from edited card for reply tracking
            const confirmResult = { messageId: msg.messageId, success: true };
            // Track confirmation message for reply routing
            if (sessionId) {
              this.trackHookMessage(confirmResult.messageId, sessionId);
            }
          } catch (err) {
            await adapter.send({ chatId: msg.chatId, text: `❌ Failed to resolve: ${err}` });
          }
        } else {
          await adapter.send({ chatId: msg.chatId, text: '❌ Go Core not available' });
        }
        return true;
      }

      // Regular permission broker callbacks (perm:allow:ID, perm:deny:ID, perm:allow_session:ID)
      const resolved = this.broker.handlePermissionCallback(msg.callbackData);
      if (resolved) {
        const action = msg.callbackData.split(':')[1];
        const label = action === 'deny' ? '❌ Denied' : '✅ Allowed';
        await adapter.send({ chatId: msg.chatId, text: label });
      } else {
        await adapter.send({ chatId: msg.chatId, text: '⚠️ Permission already expired or resolved' });
      }
      return true;
    }

    // Commands
    if (msg.text.startsWith('/')) {
      return this.handleCommand(adapter, msg);
    }

    // Check for session expiry (>30 min inactivity) and auto-create new session
    const expired = this.checkAndUpdateLastActive(msg.channelType, msg.chatId);
    if (expired) {
      const newSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await this.router.rebind(msg.channelType, msg.chatId, newSessionId);
    }

    const binding = await this.router.resolve(msg.channelType, msg.chatId);

    // Start typing heartbeat
    const typingInterval = setInterval(() => {
      adapter.sendTyping(msg.chatId).catch(() => {});
    }, 4000);
    adapter.sendTyping(msg.chatId).catch(() => {});

    const verboseLevel = this.getVerboseLevel(msg.channelType, msg.chatId);
    const costTracker = new CostTracker();
    costTracker.start();

    // Add processing reaction
    const reactionEmojis: Record<string, { processing: string; done: string; error: string }> = {
      telegram: { processing: '\u{1F914}', done: '\u{1F44D}', error: '\u{1F631}' },
      feishu: { processing: 'Typing', done: 'OK', error: 'FACEPALM' },
      discord: { processing: '\u{1F914}', done: '\u{1F44D}', error: '\u{274C}' },
    };
    const reactions = reactionEmojis[adapter.channelType] || reactionEmojis.telegram;
    adapter.addReaction(msg.chatId, msg.messageId, reactions.processing).catch(() => {});

    // Feishu: use CardKit streaming session for smoother rendering
    let feishuSession: FeishuStreamingSession | null = null;
    if (adapter.channelType === 'feishu' && 'createStreamingSession' in adapter) {
      feishuSession = (adapter as any).createStreamingSession(msg.chatId, msg.receiveIdType);
    }

    const platformLimits: Record<string, number> = { telegram: 4096, discord: 2000, feishu: 30000 };
    const stream = new StreamController({
      verboseLevel,
      platformLimit: platformLimits[adapter.channelType] ?? 4096,
      flushCallback: async (content, isEdit) => {
        // Feishu: use CardKit streaming
        if (feishuSession) {
          if (!isEdit) {
            // First flush: start streaming session
            try {
              const messageId = await feishuSession.start(content);
              clearInterval(typingInterval);
              return messageId;
            } catch {
              // Fallback: streaming API not available, disable and use normal send
              feishuSession = null;
            }
          } else {
            // Subsequent flushes: stream update
            feishuSession.update(content).catch(() => {});
            return;
          }
        }

        // Non-streaming path (Telegram, Discord, Feishu fallback)
        let outMsg: OutboundMessage;
        if (adapter.channelType === 'telegram') {
          let styled = content;
          styled = styled.replace(/^((?:📖|✏️|📝|🖥️|🔍|📂|🤖|🌐|🔧)[^\n]*)\n(━+)/m, '<i>$1</i>\n$2');
          styled = styled.replace(/(📊[^\n]+)$/m, '<code>$1</code>');
          outMsg = { chatId: msg.chatId, html: markdownToTelegram(styled) };
        } else if (adapter.channelType === 'discord') {
          let styled = content;
          styled = styled.replace(/^((?:📖|✏️|📝|🖥️|🔍|📂|🤖|🌐|🔧)[^\n]*)\n(━+)/m, '*$1*\n$2');
          styled = styled.replace(/(📊[^\n]+)$/m, '`$1`');
          outMsg = { chatId: msg.chatId, text: styled };
        } else {
          // Feishu: pass raw markdown with card header for styled rendering
          outMsg = { chatId: msg.chatId, text: content, feishuHeader: { template: 'blue', title: '💬 Claude' } };
        }

        if (!isEdit) {
          const result = await adapter.send(outMsg);
          clearInterval(typingInterval);
          return result.messageId;
        } else {
          await adapter.editMessage(msg.chatId, stream.messageId!, outMsg);
        }
      },
    });

    let completedStats: import('./cost-tracker.js').UsageStats | undefined;

    try {
      const result = await this.engine.processMessage({
        sessionId: binding.sessionId,
        text: msg.text,
        attachments: msg.attachments,
        onTextDelta: (delta) => stream.onTextDelta(delta),
        onToolUse: (event) => stream.onToolStart(event.name, event.input as Record<string, unknown>),
        onResult: (event) => {
          const usage = event.usage ?? { input_tokens: 0, output_tokens: 0 };
          completedStats = costTracker.finish(usage);
          if (verboseLevel > 0) {
            stream.onComplete(completedStats);
          }
        },
        onError: (err) => stream.onError(err),
        onPermissionRequest: async (req) => {
          await this.broker.forwardPermissionRequest(
            req,
            (channelType) => this.getLastChatId(channelType) || msg.chatId,
            this.getAdapters()
          );
        },
      });

      // Level 0: deliver final response via delivery layer (stream didn't flush text)
      if (verboseLevel === 0) {
        const responseText = result.text.trim();
        if (!completedStats) {
          const usage = result.usage ?? { input_tokens: 0, output_tokens: 0 };
          completedStats = costTracker.finish(usage);
        }
        const costLine = CostTracker.format(completedStats);
        const fullText = responseText ? `${responseText}\n${costLine}` : costLine;
        await this.delivery.deliver(adapter, msg.chatId, fullText, {
          platformLimit: platformLimits[adapter.channelType] ?? 4096,
        });
      }
      // Success: change to done reaction
      adapter.addReaction(msg.chatId, msg.messageId, reactions.done).catch(() => {});
    } catch (err) {
      // Error: change to error reaction
      adapter.addReaction(msg.chatId, msg.messageId, reactions.error).catch(() => {});
      throw err;
    } finally {
      clearInterval(typingInterval);
      stream.dispose();
      // Close Feishu streaming card
      if (feishuSession) {
        feishuSession.close().catch(() => {});
      }
    }

    return true;
  }

  private async handleCommand(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    const parts = msg.text.split(' ');
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case '/status': {
        const ctx = getBridgeContext();
        const healthy = (ctx.core as { isHealthy?: () => boolean }).isHealthy?.() ?? false;
        const coreStatus = healthy ? '● connected' : '○ disconnected';
        const channelList = Array.from(this.adapters.keys()).join(', ') || 'none';
        const statusText = [
          '📡 TLive Status',
          '',
          `Bridge:     ● running`,
          `Core:       ${coreStatus}`,
          `Channels:   ${channelList}`,
        ].join('\n');

        if (adapter.channelType === 'telegram') {
          await adapter.send({ chatId: msg.chatId, html: `<pre>${statusText}</pre>` });
        } else if (adapter.channelType === 'discord') {
          await adapter.send({ chatId: msg.chatId, text: `\`\`\`\n${statusText}\n\`\`\`` });
        } else {
          await adapter.send({
            chatId: msg.chatId,
            text: statusText,
            feishuHeader: { template: 'blue', title: '📡 TLive Status' },
          });
        }
        return true;
      }
      case '/new': {
        const newSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await this.router.rebind(msg.channelType, msg.chatId, newSessionId);
        this.clearLastActive(msg.channelType, msg.chatId);
        if (adapter.channelType === 'feishu') {
          await adapter.send({
            chatId: msg.chatId,
            text: 'Session cleared. Send a message to begin.',
            feishuHeader: { template: 'green', title: '🆕 New Session' },
          });
        } else {
          await adapter.send({ chatId: msg.chatId, text: '🆕 New session started.' });
        }
        return true;
      }
      case '/verbose': {
        const level = parseInt(parts[1], 10) as VerboseLevel;
        if ([0, 1, 2].includes(level)) {
          this.setVerboseLevel(msg.channelType, msg.chatId, level);
          const labels = ['quiet', 'normal', 'detailed'];
          await adapter.send({ chatId: msg.chatId, text: `Verbose level: ${level} (${labels[level]})` });
        } else {
          await adapter.send({ chatId: msg.chatId, text: 'Usage: /verbose 0|1|2\n0=quiet, 1=normal, 2=detailed' });
        }
        return true;
      }
      case '/hooks': {
        const pauseFile = join(homedir(), '.tlive', 'hooks-paused');
        const sub = parts[1]?.toLowerCase();
        if (sub === 'pause') {
          mkdirSync(dirname(pauseFile), { recursive: true });
          writeFileSync(pauseFile, '');
          await adapter.send({ chatId: msg.chatId, text: '⏸ Hooks paused — auto-allow, no notifications.' });
        } else if (sub === 'resume') {
          try { unlinkSync(pauseFile); } catch {}
          await adapter.send({ chatId: msg.chatId, text: '▶ Hooks resumed — forwarding to IM.' });
        } else {
          const paused = existsSync(pauseFile);
          await adapter.send({ chatId: msg.chatId, text: `Hooks: ${paused ? '⏸ paused' : '▶ active'}` });
        }
        return true;
      }
      case '/sessions': {
        const { store } = getBridgeContext();
        const allSessions = await store.listSessions();
        const binding = await this.router.resolve(msg.channelType, msg.chatId);
        const currentSessionId = binding?.sessionId;

        if (allSessions.length === 0) {
          await adapter.send({ chatId: msg.chatId, text: 'No sessions found.' });
          return true;
        }

        const sorted = allSessions
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 10);

        const lines: string[] = [];
        for (let i = 0; i < sorted.length; i++) {
          const s = sorted[i];
          const isCurrent = s.id === currentSessionId;
          const marker = isCurrent ? ' ◀' : '';
          const date = new Date(s.createdAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          const msgs = await store.getMessages(s.id);
          const firstUser = msgs.find(m => m.role === 'user');
          const preview = firstUser
            ? (firstUser.content.length > 40 ? firstUser.content.slice(0, 37) + '...' : firstUser.content)
            : '(empty)';
          lines.push(`${i + 1}. ${date} — ${preview}${marker}`);
        }

        const footer = '\nUse /session <n> to switch';

        if (adapter.channelType === 'telegram') {
          await adapter.send({ chatId: msg.chatId, html: `<b>📋 Sessions</b>\n\n${lines.join('\n')}${footer}` });
        } else if (adapter.channelType === 'discord') {
          await adapter.send({ chatId: msg.chatId, text: `**📋 Sessions**\n${lines.join('\n')}${footer}` });
        } else {
          await adapter.send({
            chatId: msg.chatId,
            text: `${lines.join('\n')}${footer}`,
            feishuHeader: { template: 'blue', title: '📋 Sessions' },
          });
        }
        return true;
      }
      case '/session': {
        const idx = parseInt(parts[1], 10);
        if (isNaN(idx) || idx < 1) {
          await adapter.send({ chatId: msg.chatId, text: 'Usage: /session <number>\nUse /sessions to list.' });
          return true;
        }

        const { store } = getBridgeContext();
        const allSessions = await store.listSessions();
        const sorted = allSessions
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 10);

        if (idx > sorted.length) {
          await adapter.send({ chatId: msg.chatId, text: `Session ${idx} not found. Use /sessions to list.` });
          return true;
        }

        const target = sorted[idx - 1];
        await this.router.rebind(msg.channelType, msg.chatId, target.id);
        this.clearLastActive(msg.channelType, msg.chatId);

        const msgs = await store.getMessages(target.id);
        const firstUser = msgs.find(m => m.role === 'user');
        const preview = firstUser
          ? (firstUser.content.length > 50 ? firstUser.content.slice(0, 47) + '...' : firstUser.content)
          : '(empty)';
        const hasContext = target.sdkSessionId ? '✅ has context' : '⚠️ no SDK session';
        await adapter.send({
          chatId: msg.chatId,
          text: `🔄 Switched to session ${idx}\n${preview}\n${hasContext}`,
        });
        return true;
      }
      case '/help': {
        const helpLines = [
          '/new              New conversation',
          '/sessions         List recent sessions',
          '/session <n>      Switch to session #n',
          '/verbose 0|1|2    Detail level',
          '  0 = quiet (result only)',
          '  1 = normal (tools + streaming)',
          '  2 = detailed (tools + input summary)',
          '/hooks pause      Auto-allow, no notifications',
          '/hooks resume     Resume IM approval',
          '/status           Bridge + hooks status',
          '/help             This message',
        ];

        if (adapter.channelType === 'telegram') {
          const htmlLines = helpLines.map(line => {
            if (line.startsWith('  ')) return line; // indent lines
            const [cmd, ...desc] = line.split(/\s{2,}/);
            return desc.length ? `<code>${cmd}</code>  ${desc.join(' ')}` : line;
          });
          await adapter.send({ chatId: msg.chatId, html: `<b>TLive Commands</b>\n\n${htmlLines.join('\n')}` });
        } else if (adapter.channelType === 'discord') {
          await adapter.send({ chatId: msg.chatId, text: `**TLive Commands**\n\`\`\`\n${helpLines.join('\n')}\n\`\`\`` });
        } else {
          await adapter.send({
            chatId: msg.chatId,
            text: helpLines.join('\n'),
            feishuHeader: { template: 'indigo', title: '❓ TLive Commands' },
          });
        }
        return true;
      }
      default:
        return false;
    }
  }
}
