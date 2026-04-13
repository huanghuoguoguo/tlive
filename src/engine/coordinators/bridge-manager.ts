import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage, RenderedMessage } from '../../channels/types.js';
import type { FeishuRenderedMessage } from '../../platforms/feishu/types.js';
import type { FormattableMessage } from '../../formatting/message-types.js';
import { getBridgeContext } from '../../context.js';
import { ChannelRouter } from '../utils/router.js';
import { PermissionBroker } from '../../permissions/broker.js';
import { PendingPermissions } from '../../permissions/gateway.js';
import { loadConfig, loadProjectsConfig, type Config, type ClaudeSettingSource } from '../../config.js';
import { SessionStateManager } from '../state/session-state.js';
import { WorkspaceStateManager } from '../state/workspace-state.js';
import { PermissionCoordinator } from './permission.js';
import { CommandRouter } from '../command-router.js';
import { SDKEngine } from '../sdk/engine.js';
import { WebhookServer } from '../automation/webhook.js';
import { CronScheduler } from '../automation/cron.js';
import { buildCronSystemPrompt } from '../automation/cron-system-prompt.js';
import { networkInterfaces } from 'node:os';
import { handleCallbackMessage } from '../messages/callback-dispatcher.js';
import { IngressCoordinator } from './ingress.js';
import { getTliveRuntimeDir } from '../../utils/path.js';
import { MessageLoopCoordinator } from './message-loop.js';
import { TextDispatcher } from '../messages/text-dispatcher.js';
import { QueryOrchestrator } from './query.js';
import { ConversationEngine } from '../utils/conversation.js';
import { HookNotificationDispatcher, type HookNotificationData } from '../messages/hook-notification.js';
import type { BridgeStore } from '../../store/interface.js';
import type { LLMProvider } from '../../providers/base.js';
import { generateRequestId, Logger, type LogContext } from '../../logger.js';
import { truncate } from '../../utils/string.js';
import { areSettingSourcesEqual } from '../../utils/automation.js';

/** Bridge commands handled synchronously (don't block adapter loop) */
const QUICK_COMMANDS = new Set(['/new', '/home', '/status', '/hooks', '/sessions', '/session', '/sessioninfo', '/help', '/help-cli', '/perm', '/stop', '/approve', '/pairings', '/settings', '/cd', '/pwd', '/bash', '/upgrade', '/restart']);

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

/** Detect a private LAN IP address for local bridge links. */
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
  private store: BridgeStore;
  private engine: ConversationEngine;
  private router: ChannelRouter;
  private port: number;
  private state = new SessionStateManager(getTliveRuntimeDir());
  private workspace = new WorkspaceStateManager(getTliveRuntimeDir());
  private permissions: PermissionCoordinator;
  /** SDK Engine for LiveSession management */
  private sdkEngine: SDKEngine;
  private ingress = new IngressCoordinator();
  private loop: MessageLoopCoordinator;
  private text: TextDispatcher;
  private query: QueryOrchestrator;
  private notifications: HookNotificationDispatcher;
  /** Webhook server for automation entry */
  private webhookServer: WebhookServer | null = null;
  /** Cron scheduler for scheduled tasks (Phase 3) */
  private cronScheduler: CronScheduler | null = null;

  /** Get the cron scheduler instance (null if disabled) */
  getCronScheduler(): CronScheduler | null {
    return this.cronScheduler;
  }

  private commands: CommandRouter;
  /** Cleanup timer for SDK question data */
  private sdkQuestionCleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps?: BridgeManagerDeps) {
    const config = deps?.config ?? loadConfig();
    const context = deps ?? getBridgeContext();
    const { store, llm, defaultWorkdir } = context;
    this.store = store;
    const localUrl = `http://${getLocalIP()}:${config.port || 8080}`;
    const gateway = new PendingPermissions();
    const broker = new PermissionBroker(gateway, localUrl);
    this.port = config.port || 8080;
    this.router = new ChannelRouter(store);
    this.permissions = new PermissionCoordinator(gateway, broker);
    this.engine = new ConversationEngine(store, llm);
    this.sdkEngine = new SDKEngine();
    this.sdkEngine.onSessionPruned = (sessionKey) => {
      this.permissions.clearSessionWhitelist(sessionKey);
    };
    // Load projects config once for CommandRouter, WebhookServer, and CronScheduler
    const projectsResult = loadProjectsConfig();
    this.commands = new CommandRouter(
      this.state,
      this.workspace,
      () => this.adapters,
      this.router,
      store,
      defaultWorkdir,
      llm,
      this.sdkEngine.getActiveControls(),
      this.permissions,
      config.claudeSettingSources,
      this.sdkEngine,
      projectsResult,
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
    });
    this.query = new QueryOrchestrator({
      engine: this.engine,
      llm,
      router: this.router,
      state: this.state,
      permissions: this.permissions,
      sdkEngine: this.sdkEngine,
      store,
      defaultWorkdir,
      defaultClaudeSettingSources: config.claudeSettingSources,
      port: this.port,
      appendSystemPrompt: this.buildAppendSystemPrompt(config),
    });
    this.notifications = new HookNotificationDispatcher({
      permissions: this.permissions,
      buildTerminalUrl: (sessionId) => `http://${getLocalIP()}:${this.port}/terminal.html?id=${sessionId}`,
    });
    // Initialize webhook server if enabled
    if (config.webhook.enabled && config.webhook.token) {
      this.webhookServer = new WebhookServer({
        token: config.webhook.token,
        port: config.webhook.port,
        path: config.webhook.path,
        bridge: this,
        sessionStrategy: config.webhook.sessionStrategy,
        callbackUrl: config.webhook.callbackUrl,
        rateLimitPerMinute: config.webhook.rateLimitPerMinute,
        projects: projectsResult?.valid,
        defaultProject: projectsResult?.defaultProject,
        defaultWorkdir,
      });
    }
    // Initialize cron scheduler if enabled (Phase 3)
    if (config.cron.enabled) {
      this.cronScheduler = new CronScheduler({
        runtimeDir: getTliveRuntimeDir(),
        bridge: this,
        enabled: config.cron.enabled,
        maxConcurrency: config.cron.maxConcurrency,
        projects: projectsResult?.valid,
      });
    }
  }

  
  /** Returns all active adapters */
  getAdapters(): BaseChannelAdapter[] {
    return Array.from(this.adapters.values());
  }

  getAdapter(channelType: string): BaseChannelAdapter | undefined {
    return this.adapters.get(channelType);
  }

  async getBinding(channelType: string, chatId: string) {
    return this.store.getBinding(channelType, chatId);
  }

  async getBindingBySessionId(sessionId: string) {
    return this.store.getBindingBySessionId(sessionId);
  }

  hasActiveSession(channelType: string, chatId: string, workdir?: string): boolean {
    return this.sdkEngine.hasActiveSession(channelType, chatId, workdir);
  }

  async injectAutomationPrompt(options: {
    channelType: string;
    chatId: string;
    text: string;
    requestId?: string;
    messageId?: string;
    userId?: string;
    workdir?: string;
    projectName?: string;
    claudeSettingSources?: ClaudeSettingSource[];
  }): Promise<{ sessionId?: string }> {
    const adapter = this.getAdapter(options.channelType);
    if (!adapter) {
      throw new Error(`Channel '${options.channelType}' not available`);
    }

    const binding = await this.router.resolve(options.channelType, options.chatId);
    const previousCwd = binding.cwd;
    const workdirChanged = options.workdir !== undefined && binding.cwd !== options.workdir;
    const projectChanged = options.projectName !== undefined && binding.projectName !== options.projectName;
    const settingsChanged = options.claudeSettingSources !== undefined
      && !areSettingSourcesEqual(binding.claudeSettingSources, options.claudeSettingSources);
    const sessionContextChanged = workdirChanged || projectChanged || settingsChanged;

    let bindingChanged = false;

    if (options.workdir !== undefined && binding.cwd !== options.workdir) {
      binding.cwd = options.workdir;
      bindingChanged = true;
    }
    if (options.projectName !== undefined && binding.projectName !== options.projectName) {
      binding.projectName = options.projectName;
      bindingChanged = true;
    }
    if (options.claudeSettingSources !== undefined && settingsChanged) {
      const nextSources = [...options.claudeSettingSources];
      binding.claudeSettingSources = nextSources;
      bindingChanged = true;
    }

    if (sessionContextChanged) {
      this.sdkEngine.cleanupSession(
        options.channelType,
        options.chatId,
        workdirChanged || projectChanged ? 'cd' : 'settings',
        previousCwd,
      );
      binding.sdkSessionId = undefined;
      this.permissions.clearSessionWhitelist(binding.sessionId);
      bindingChanged = true;
    }

    if (bindingChanged) {
      await this.store.saveBinding(binding);
    }

    this.ingress.recordChat(options.channelType, options.chatId);
    await this.query.run(adapter, {
      channelType: adapter.channelType,
      chatId: options.chatId,
      userId: options.userId ?? 'automation',
      text: options.text,
      messageId: options.messageId ?? `automation-${options.requestId || generateRequestId()}`,
      attachments: [],
    }, options.requestId);

    const updatedBinding = await this.store.getBinding(options.channelType, options.chatId);
    return {
      sessionId: updatedBinding?.sdkSessionId ?? updatedBinding?.sessionId,
    };
  }

  /** Get the last active chatId for a given channel type (for hook routing) */
  getLastChatId(channelType: string): string {
    return this.ingress.getLastChatId(channelType);
  }

  /** Broadcast a message to all active IM channels */
  async broadcast(msg: Omit<RenderedMessage, 'chatId'>): Promise<void> {
    for (const adapter of this.getAdapters()) {
      const chatId = this.getBroadcastTarget(adapter.channelType);
      if (!chatId) continue;
      // Build platform-specific message
      const baseMsg = { chatId, ...msg };
      if (adapter.channelType === 'feishu') {
        // Feishu needs receiveIdType
        await adapter.send({
          ...baseMsg,
          receiveIdType: this.getBroadcastReceiveIdType(adapter.channelType),
        } as FeishuRenderedMessage);
      } else {
        await adapter.send(baseMsg as any);
      }
    }
  }

  /** Convenience: broadcast a plain text message */
  async broadcastText(text: string): Promise<void> {
    return this.broadcast({ text });
  }

  /** Broadcast a semantic message to all active IM channels */
  async broadcastFormatted(msg: Omit<FormattableMessage, 'chatId'>): Promise<void> {
    for (const adapter of this.getAdapters()) {
      const chatId = this.getBroadcastTarget(adapter.channelType);
      if (!chatId) continue;
      const outMsg = adapter.format({ ...msg, chatId } as FormattableMessage);
      // Only add receiveIdType for Feishu
      if (adapter.channelType === 'feishu') {
        await adapter.send({
          ...outMsg,
          receiveIdType: this.getBroadcastReceiveIdType(adapter.channelType),
        } as FeishuRenderedMessage);
      } else {
        await adapter.send(outMsg);
      }
    }
  }

  /** Get target chatId for broadcast messages */
  private getBroadcastTarget(channelType: string): string {
    // Broadcast uses last active chat since config doesn't have per-channel defaults
    return this.getLastChatId(channelType);
  }

  /** Get receiveIdType for broadcast messages */
  private getBroadcastReceiveIdType(_channelType: string): string | undefined {
    return undefined;
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
      this.sdkEngine.getInteractionState().pruneResolvedSdkQuestions(this.permissions.getGateway());
      this.ingress.pruneStaleState();
    }, 5 * 60 * 1000);
    // Start webhook server if configured
    if (this.webhookServer) {
      this.webhookServer.start();
    }
    // Start cron scheduler if configured (Phase 3)
    if (this.cronScheduler) {
      this.cronScheduler.start();
    }
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
    // Stop webhook server
    if (this.webhookServer) {
      this.webhookServer.stop();
    }
    // Stop cron scheduler (Phase 3)
    if (this.cronScheduler) {
      this.cronScheduler.stop();
    }
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }
  }

  /** Send a hook notification to IM with [Local] prefix and track for reply routing */
  async sendHookNotification(adapter: BaseChannelAdapter, chatId: string, hook: HookNotificationData, receiveIdType?: string): Promise<void> {
    await this.notifications.send(adapter, chatId, hook, receiveIdType);
  }

  /** Build appendSystemPrompt for agent sessions based on enabled features */
  private buildAppendSystemPrompt(config: Config): string | undefined {
    const parts: string[] = [];

    // Cron management prompt (only when both webhook and cron are enabled)
    if (config.cron.enabled && config.webhook.enabled && config.webhook.token) {
      parts.push(buildCronSystemPrompt(config.webhook.port, config.webhook.token));
    }

    return parts.length > 0 ? parts.join('\n\n') : undefined;
  }

  private async runAdapterLoop(adapter: BaseChannelAdapter): Promise<void> {
    while (this.running) {
      const msg = await this.ingress.getNextMessage(adapter);
      if (!msg) { await new Promise(r => setTimeout(r, 100)); continue; }
      const requestId = generateRequestId();
      const ctx: LogContext = { requestId, chatId: msg.chatId };
      const textPreview = msg.text ? truncate(msg.text, 50) : '(callback)';
      console.log(`[${adapter.channelType}] ${ctx.requestId} RECV user=${msg.userId} chat=${msg.chatId?.slice(-8) || '?'}: ${textPreview}`);
      if (this.loop.isQuickMessage(adapter, msg)) {
        try {
          await this.handleInboundMessage(adapter, msg, requestId);
        } catch (err) {
          console.error(`[${adapter.channelType}] ${ctx.requestId} ERROR: ${Logger.formatError(err)}`);
        }
      } else {
        await this.loop.dispatchSlowMessage({
          adapter,
          msg,
          requestId,
          coalesceMessage: (dispatchAdapter, dispatchMsg) => this.ingress.coalesceMessages(dispatchAdapter, dispatchMsg),
          handleMessage: (dispatchAdapter, dispatchMsg, rid) => this.handleInboundMessage(dispatchAdapter, dispatchMsg, rid),
          onError: (err, rid) => {
            console.error(`[${adapter.channelType}] ${rid} ERROR: ${Logger.formatError(err)}`);
          },
        });
      }
    }
  }

  async handleInboundMessage(adapter: BaseChannelAdapter, msg: InboundMessage, requestId?: string): Promise<boolean> {
    const ctx: LogContext = { requestId: requestId || generateRequestId(), chatId: msg.chatId };
    // Menu events: fallback to user's last active chat
    if (!msg.chatId && msg.userId) {
      const userLastChat = this.state.getUserLastChat(msg.userId);
      if (userLastChat && userLastChat.channelType === adapter.channelType) {
        console.log(`[${adapter.channelType}] ${ctx.requestId} MENU fallback to user's last chat ${userLastChat.chatId.slice(-8)}`);
        msg = { ...msg, chatId: userLastChat.chatId };
        ctx.chatId = msg.chatId;
      } else {
        console.warn(`[${adapter.channelType}] ${ctx.requestId} MENU dropped: no recent chat for user ${msg.userId}`);
        return false;
      }
    }

    // Callback without chatId: fallback to last active chat for this channel
    if (msg.callbackData && !msg.chatId) {
      const fallbackChatId = this.ingress.getLastChatId(adapter.channelType);
      if (fallbackChatId) {
        console.warn(`[${adapter.channelType}] ${ctx.requestId} CALLBACK fallback to last chat ${fallbackChatId.slice(-8)}`);
        msg = { ...msg, chatId: fallbackChatId };
        ctx.chatId = msg.chatId;
      }
    }

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

    // Track user's last active chat (for menu fallback)
    if (msg.chatId && msg.userId) {
      this.state.setUserLastChat(msg.userId, adapter.channelType, msg.chatId);
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
        replayMessage: (replayAdapter, replayMsg) => this.handleInboundMessage(replayAdapter, replayMsg, ctx.requestId),
      });
    }

    // Bridge commands — only intercept known commands, pass others to Claude Code
    if (msg.text.startsWith('/')) {
      const handled = await this.commands.handle(adapter, msg);
      if (handled) {
        console.log(`[bridge] ${ctx.requestId} CMD ${msg.text.split(' ')[0]}`);
        return true;
      }
      // Unrecognized slash command → fall through to Claude Code
    }

    return this.query.run(adapter, msg, ctx.requestId);
  }

}
