import { BaseChannelAdapter, createAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import { ConversationEngine } from './conversation.js';
import { ChannelRouter } from './router.js';
import { PermissionBroker } from '../permissions/broker.js';
import { PendingPermissions } from '../permissions/gateway.js';
import { DeliveryLayer } from '../delivery/delivery.js';
import { getBridgeContext } from '../context.js';
import { loadConfig } from '../config.js';
import { markdownToTelegram } from '../markdown/index.js';
import { StreamController, type VerboseLevel } from './stream-controller.js';
import { CostTracker } from './cost-tracker.js';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
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
  private hookMessages = new Map<string, { sessionId: string; timestamp: number }>();

  constructor() {
    const config = loadConfig();
    this.broker = new PermissionBroker(this.gateway, config.publicUrl);
    this.coreUrl = config.coreUrl;
    this.token = config.token;
  }

  /** Expose coreAvailable flag for main.ts polling loop */
  setCoreAvailable(available: boolean): void {
    this.coreAvailable = available;
  }

  /** Returns all active adapters */
  getAdapters(): BaseChannelAdapter[] {
    return Array.from(this.adapters.values());
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

  /** Send a hook notification to IM with [Local] prefix and track for reply routing */
  async sendHookNotification(adapter: BaseChannelAdapter, chatId: string, hook: HookNotificationData): Promise<void> {
    const hookType = hook.tlive_hook_type || '';
    const parts: string[] = [];

    if (hookType === 'stop') {
      parts.push('🖥 [Local] ✅ Task complete');

      // Use last_assistant_message from Claude Code Stop hook (primary),
      // fall back to last_output enriched by Go Core from PTY buffer
      const summary = (hook.last_assistant_message || hook.last_output || '').trim();
      if (summary) {
        const truncated = summary.length > 3000 ? summary.slice(0, 2997) + '...' : summary;
        parts.push('', `> ${truncated.replace(/\n/g, '\n> ')}`);
      }
    } else if (hook.notification_type === 'idle_prompt') {
      parts.push(`🖥 [Local] ${hook.message || 'Claude is waiting for input...'}`);
    } else {
      parts.push(`🖥 [Local] ${hook.message || 'Notification'}`);
    }

    // Add web terminal link if Go Core is available
    if (this.coreAvailable && hook.tlive_session_id) {
      const config = loadConfig();
      const baseUrl = config.publicUrl || `http://localhost:${config.port || 8080}`;
      parts.push('', `🔗 ${baseUrl}/terminal.html?id=${hook.tlive_session_id}&token=${this.token}`);
    }

    const raw = parts.join('\n');
    const outMsg = adapter.channelType === 'telegram'
      ? { chatId, html: markdownToTelegram(raw) }
      : { chatId, text: raw };
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

    // Reply routing: quote-reply to a hook message → send to PTY stdin
    if (msg.text && msg.replyToMessageId && this.hookMessages.has(msg.replyToMessageId)) {
      const entry = this.hookMessages.get(msg.replyToMessageId)!;
      if (entry.sessionId && this.coreAvailable) {
        try {
          await fetch(`${this.coreUrl}/api/sessions/${entry.sessionId}/input`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text: msg.text + '\r' }),
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
            const confirmResult = await adapter.send({
              chatId: msg.chatId,
              text: labels[decision] || '✅ Allowed',
            });
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

    const platformLimits: Record<string, number> = { telegram: 4096, discord: 2000, feishu: 30000 };
    const stream = new StreamController({
      verboseLevel,
      platformLimit: platformLimits[adapter.channelType] ?? 4096,
      flushCallback: async (content, isEdit) => {
        // Convert markdown to platform-specific format
        const outMsg = adapter.channelType === 'telegram'
          ? { chatId: msg.chatId, html: markdownToTelegram(content) }
          : { chatId: msg.chatId, text: content };

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
          await this.broker.forwardPermissionRequest(req, msg.chatId, [adapter]);
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
    } finally {
      clearInterval(typingInterval);
      stream.dispose();
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
        await adapter.send({
          chatId: msg.chatId,
          text: `TermLive Status\nCore: ${healthy ? '● connected' : '○ disconnected'}\nAdapters: ${this.adapters.size} active`,
        });
        return true;
      }
      case '/new': {
        const newSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await this.router.rebind(msg.channelType, msg.chatId, newSessionId);
        this.clearLastActive(msg.channelType, msg.chatId);
        await adapter.send({ chatId: msg.chatId, text: '🆕 New session started.' });
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

        // Sort by creation date (newest first) and limit to 10
        const sorted = allSessions
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 10);

        const lines: string[] = ['📋 Sessions:'];
        for (let i = 0; i < sorted.length; i++) {
          const s = sorted[i];
          const isCurrent = s.id === currentSessionId;
          const marker = isCurrent ? ' ◀' : '';
          const date = new Date(s.createdAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          // Get first user message as preview
          const msgs = await store.getMessages(s.id);
          const firstUser = msgs.find(m => m.role === 'user');
          const preview = firstUser
            ? (firstUser.content.length > 40 ? firstUser.content.slice(0, 37) + '...' : firstUser.content)
            : '(empty)';
          lines.push(`${i + 1}. ${date} — ${preview}${marker}`);
        }
        lines.push('', 'Use /session <n> to switch');
        await adapter.send({ chatId: msg.chatId, text: lines.join('\n') });
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
        await adapter.send({
          chatId: msg.chatId,
          text: [
            'TLive IM Commands:',
            '',
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
          ].join('\n'),
        });
        return true;
      }
      default:
        return false;
    }
  }
}
