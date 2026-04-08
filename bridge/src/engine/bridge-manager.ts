import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import { getBridgeContext } from '../context.js';
import { ChannelRouter } from './router.js';
import { PermissionBroker } from '../permissions/broker.js';
import { PendingPermissions } from '../permissions/gateway.js';
import { loadConfig, type Config } from '../config.js';
import { SessionStateManager } from './session-state.js';
import { PermissionCoordinator } from './permission-coordinator.js';
import { CommandRouter } from './command-router.js';
import { SDKEngine } from './sdk-engine.js';
import { networkInterfaces } from 'node:os';
import { handleCallbackMessage } from './callback-dispatcher.js';
import { IngressCoordinator } from './ingress-coordinator.js';
import { MessageLoopCoordinator } from './message-loop-coordinator.js';
import { TextDispatcher } from './text-dispatcher.js';
import { QueryOrchestrator } from './query-orchestrator.js';
import { ConversationEngine } from './conversation.js';
import { HookNotificationDispatcher, type HookNotificationData } from './hook-notification-dispatcher.js';
import type { BridgeStore } from '../store/interface.js';
import type { LLMProvider } from '../providers/base.js';

/** Bridge commands handled synchronously (don't block adapter loop) */
const QUICK_COMMANDS = new Set(['/new', '/status', '/verbose', '/hooks', '/sessions', '/session', '/help', '/perm', '/effort', '/stop', '/approve', '/pairings', '/settings', '/model', '/cd', '/pwd']);

interface BridgeManagerDeps {
  store: BridgeStore;
  llm: LLMProvider;
  defaultWorkdir: string;
  config?: Config;
}

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

export class BridgeManager {
  private adapters = new Map<string, BaseChannelAdapter>();
  private running = false;
  private engine: ConversationEngine;
  private router: ChannelRouter;
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
  private query: QueryOrchestrator;
  private notifications: HookNotificationDispatcher;

  private commands: CommandRouter;
  /** Cleanup timer for SDK question data */
  private sdkQuestionCleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps?: BridgeManagerDeps) {
    const config = deps?.config ?? loadConfig();
    const context = deps ?? getBridgeContext();
    const { store, llm, defaultWorkdir } = context;
    const localUrl = `http://${getLocalIP()}:${config.port || 8080}`;
    const gateway = new PendingPermissions();
    const broker = new PermissionBroker(gateway, localUrl);
    this.coreUrl = config.coreUrl;
    this.token = config.token;
    this.port = config.port || 8080;
    this.router = new ChannelRouter(store);
    this.permissions = new PermissionCoordinator(gateway, broker, this.coreUrl, this.token);
    this.engine = new ConversationEngine(store, llm);
    this.sdkEngine = new SDKEngine(this.state, this.router);
    this.commands = new CommandRouter(
      this.state,
      () => this.adapters,
      this.router,
      () => this.coreAvailable,
      store,
      defaultWorkdir,
      llm,
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
    this.query = new QueryOrchestrator({
      engine: this.engine,
      router: this.router,
      state: this.state,
      permissions: this.permissions,
      sdkEngine: this.sdkEngine,
      store,
      defaultWorkdir,
      port: this.port,
      token: this.token,
      isCoreAvailable: () => this.coreAvailable,
    });
    this.notifications = new HookNotificationDispatcher({
      permissions: this.permissions,
      isCoreAvailable: () => this.coreAvailable,
      buildTerminalUrl: (sessionId) => `http://${getLocalIP()}:${this.port}/terminal.html?id=${sessionId}&token=${this.token}`,
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
    await this.notifications.send(adapter, chatId, hook, receiveIdType);
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

    return this.query.run(adapter, msg);
  }

}
