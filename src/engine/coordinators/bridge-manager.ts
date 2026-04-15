import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage, RenderedMessage } from '../../channels/types.js';
import type { FormattableMessage } from '../../formatting/message-types.js';
import type { AutomationBridge } from '../types/automation-bridge.js';
import { getBridgeContext } from '../../context.js';
import { loadConfig, type Config, type ClaudeSettingSource } from '../../config.js';
import { WebhookServer } from '../automation/webhook.js';
import { CronScheduler } from '../automation/cron.js';
import { buildCronSystemPrompt } from '../automation/cron-system-prompt.js';
import { handleCallbackMessage } from '../messages/callback-dispatcher.js';
import { getTliveRuntimeDir } from '../../utils/path.js';
import type { HookNotificationData } from '../messages/hook-notification.js';
import type { BridgeStore } from '../../store/interface.js';
import type { ClaudeSDKProvider } from '../../providers/claude-sdk.js';
import { generateRequestId, Logger, type LogContext } from '../../logger.js';
import { truncate } from '../../utils/string.js';
import { areSettingSourcesEqual } from '../../utils/automation.js';
import { generateSessionId } from '../../utils/id.js';
import { createBridgeComponents, type BridgeComponents, type BridgeFactoryDeps } from '../bridge-factory.js';
import { CommandRouter } from '../command-router.js';
import { QueryOrchestrator } from './query.js';
import type { PermissionCoordinator } from './permission.js';
import type { ChannelRouter } from '../../utils/router.js';
import type { SDKEngine } from '../sdk/engine.js';
import type { IngressCoordinator } from './ingress.js';
import type { SessionStateManager } from '../state/session-state.js';
import { t, type Locale } from '../../i18n/index.js';

interface BridgeManagerDeps {
  store: BridgeStore;
  llm: ClaudeSDKProvider;
  defaultWorkdir: string;
  config?: Config;
}

export class BridgeManager implements AutomationBridge {
  private adapters = new Map<string, BaseChannelAdapter>();
  private running = false;
  private components: BridgeComponents;
  /** Webhook server for automation entry */
  private webhookServer: WebhookServer | null = null;
  /** Cron scheduler for scheduled tasks */
  private cronScheduler: CronScheduler | null = null;
  /** Cleanup timer for SDK question data */
  private sdkQuestionCleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** Get the cron scheduler instance (null if disabled) */
  getCronScheduler(): CronScheduler | null {
    return this.cronScheduler;
  }

  constructor(deps?: BridgeManagerDeps) {
    const config = deps?.config ?? loadConfig();
    const context = deps ?? getBridgeContext();
    const { store, llm, defaultWorkdir } = context;

    // Create all engine components via factory
    const factoryDeps: BridgeFactoryDeps = { store, llm, defaultWorkdir, config };
    this.components = createBridgeComponents(factoryDeps);

    // Re-create CommandRouter with proper adapter getter
    this.components.commands = new CommandRouter(
      this.components.state,
      this.components.workspace,
      () => this.adapters,
      this.components.router,
      store,
      defaultWorkdir,
      llm,
      this.components.sdkEngine.getActiveControls(),
      this.components.permissions,
      config.claudeSettingSources,
      this.components.sdkEngine,
      this.components.projectsConfig,
    );

    // Update query with appendSystemPrompt
    this.components.query = new QueryOrchestrator({
      engine: this.components.engine,
      llm,
      router: this.components.router,
      state: this.components.state,
      permissions: this.components.permissions,
      sdkEngine: this.components.sdkEngine,
      store,
      defaultWorkdir,
      defaultClaudeSettingSources: config.claudeSettingSources,
      port: this.components.port,
      appendSystemPrompt: this.buildAppendSystemPrompt(config),
    });

    // Initialize cron scheduler if enabled
    if (config.cron.enabled) {
      this.cronScheduler = new CronScheduler({
        runtimeDir: getTliveRuntimeDir(),
        bridge: this,
        enabled: config.cron.enabled,
        maxConcurrency: config.cron.maxConcurrency,
        projects: this.components.projectsConfig?.valid,
      });
    }

    // Initialize webhook server if enabled (after cron scheduler so we can pass it)
    if (config.webhook.enabled && config.webhook.token) {
      this.webhookServer = new WebhookServer({
        token: config.webhook.token,
        port: config.webhook.port,
        path: config.webhook.path,
        bridge: this,
        sessionStrategy: config.webhook.sessionStrategy,
        callbackUrl: config.webhook.callbackUrl,
        rateLimitPerMinute: config.webhook.rateLimitPerMinute,
        projects: this.components.projectsConfig?.valid,
        defaultProject: this.components.projectsConfig?.defaultProject,
        defaultWorkdir,
        cronScheduler: this.cronScheduler,
        pushConfig: config.push,
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
    return this.components.store.getBinding(channelType, chatId);
  }

  async getBindingBySessionId(sessionId: string) {
    return this.components.store.getBindingBySessionId(sessionId);
  }

  hasActiveSession(channelType: string, chatId: string, workdir?: string): boolean {
    return this.components.sdkEngine.hasActiveSession(channelType, chatId, workdir);
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

    const binding = await this.components.router.resolve(options.channelType, options.chatId);
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
      binding.sessionId = generateSessionId();
      binding.sdkSessionId = undefined;
      bindingChanged = true;
    }

    if (bindingChanged) {
      await this.components.store.saveBinding(binding);
    }

    this.components.ingress.recordChat(options.channelType, options.chatId);
    await this.components.query.run(adapter, {
      channelType: adapter.channelType,
      chatId: options.chatId,
      userId: options.userId ?? 'automation',
      text: options.text,
      messageId: options.messageId ?? `automation-${options.requestId || generateRequestId()}`,
      attachments: [],
    }, options.requestId);

    const updatedBinding = await this.components.store.getBinding(options.channelType, options.chatId);
    return {
      sessionId: updatedBinding?.sdkSessionId ?? updatedBinding?.sessionId,
    };
  }

  /** Get the last active chatId for a given channel type (for hook routing) */
  getLastChatId(channelType: string): string {
    return this.components.ingress.getLastChatId(channelType);
  }

  /** Broadcast a message to all active IM channels */
  async broadcast(msg: Omit<RenderedMessage, 'chatId'>): Promise<void> {
    for (const adapter of this.getAdapters()) {
      const chatId = this.getBroadcastTarget(adapter.channelType);
      if (!chatId) continue;
      const baseMsg = { chatId, ...msg } as RenderedMessage;
      const preparedMsg = adapter.prepareBroadcast(baseMsg as any);
      await adapter.send(preparedMsg);
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
      const preparedMsg = adapter.prepareBroadcast(outMsg as any);
      await adapter.send(preparedMsg);
    }
  }

  /** Get target chatId for broadcast messages */
  private getBroadcastTarget(channelType: string): string {
    return this.getLastChatId(channelType);
  }

  /** Push session context to mobile IM for continuing on phone */
  async pushToMobile(options: {
    channelType: string;
    chatId: string;
    workdir: string;
    projectName?: string;
    message?: string;
    preview?: string;
  }): Promise<{ success: boolean; sessionId?: string; error?: string }> {
    const adapter = this.getAdapter(options.channelType);
    if (!adapter) {
      return { success: false, error: `Channel '${options.channelType}' not available` };
    }

    // Get binding to retrieve session info
    const binding = await this.components.store.getBinding(options.channelType, options.chatId);
    const locale: Locale = 'zh'; // Default to zh for push notifications
    const sessionIdShort = binding?.sdkSessionId?.slice(-8) ?? binding?.sessionId?.slice(-8) ?? 'unknown';

    // Format push notification message
    const lines = [
      t(locale, 'push.title'),
      '',
      `${t(locale, 'push.workdir')}: ${options.workdir}`,
    ];
    if (options.projectName) {
      lines.push(`${t(locale, 'push.project')}: ${options.projectName}`);
    }
    lines.push(`${t(locale, 'push.session')}: ${sessionIdShort}`);

    // Add preview if provided
    if (options.preview) {
      lines.push('');
      lines.push(`💬 ${t(locale, 'push.preview')}:`);
      lines.push(options.preview);
    }

    lines.push('');
    lines.push(t(locale, 'push.continueHint'));

    const pushText = lines.join('\n');

    try {
      await adapter.send({
        chatId: options.chatId,
        text: pushText,
      });

      // Return session ID from binding for resuming on mobile
      return {
        success: true,
        sessionId: binding?.sdkSessionId ?? binding?.sessionId,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Delegate: track a hook message for reply routing */
  trackHookMessage(messageId: string, sessionId: string): void {
    this.components.permissions.trackHookMessage(messageId, sessionId);
  }

  /** Delegate: track a permission message for text-based approval */
  trackPermissionMessage(messageId: string, permissionId: string, sessionId: string, channelType: string): void {
    this.components.permissions.trackPermissionMessage(messageId, permissionId, sessionId, channelType);
  }

  /** Delegate: store original permission card text */
  storeHookPermissionText(hookId: string, text: string): void {
    this.components.permissions.storeHookPermissionText(hookId, text);
  }

  /** Delegate: store AskUserQuestion data */
  storeQuestionData(hookId: string, questions: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean }>, contextSuffix?: string): void {
    this.components.permissions.storeQuestionData(hookId, questions, contextSuffix);
  }

  /** Get permissions coordinator for direct access */
  getPermissions(): PermissionCoordinator {
    return this.components.permissions;
  }

  /** Get router for binding resolution */
  getRouter(): ChannelRouter {
    return this.components.router;
  }

  /** Get store for persistence */
  getStore(): BridgeStore {
    return this.components.store;
  }

  /** Get SDK engine for session management */
  getSdkEngine(): SDKEngine {
    return this.components.sdkEngine;
  }

  /** Get query orchestrator */
  getQuery(): QueryOrchestrator {
    return this.components.query;
  }

  /** Get ingress coordinator for testing */
  getIngress(): IngressCoordinator {
    return this.components.ingress;
  }

  /** Get session state manager */
  getState(): SessionStateManager {
    return this.components.state;
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
    this.components.permissions.startPruning();
    this.components.sdkEngine.startSessionPruning();
    this.sdkQuestionCleanupTimer = setInterval(() => {
      const interactionState = this.components.sdkEngine.getInteractionState();
      const gateway = this.components.permissions.getGateway();
      interactionState.pruneResolvedSdkQuestions(gateway);
      interactionState.pruneResolvedDeferredTools(gateway);
      this.components.ingress.pruneStaleState();
    }, 5 * 60 * 1000);
    if (this.webhookServer) {
      this.webhookServer.start();
    }
    if (this.cronScheduler) {
      this.cronScheduler.start();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.components.ingress.dispose();
    if (this.sdkQuestionCleanupTimer) {
      clearInterval(this.sdkQuestionCleanupTimer);
      this.sdkQuestionCleanupTimer = null;
    }
    this.components.permissions.stopPruning();
    this.components.sdkEngine.stopSessionPruning();
    this.components.permissions.getGateway().denyAll();
    if (this.webhookServer) {
      this.webhookServer.stop();
    }
    if (this.cronScheduler) {
      this.cronScheduler.stop();
    }
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }
  }

  /** Send a hook notification to IM with [Local] prefix and track for reply routing */
  async sendHookNotification(adapter: BaseChannelAdapter, chatId: string, hook: HookNotificationData, receiveIdType?: string): Promise<void> {
    await this.components.notifications.send(adapter, chatId, hook, receiveIdType);
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
      const msg = await this.components.ingress.getNextMessage(adapter);
      if (!msg) { await new Promise(r => setTimeout(r, 100)); continue; }
      const requestId = generateRequestId();
      const ctx: LogContext = { requestId, chatId: msg.chatId };
      const textPreview = msg.text ? truncate(msg.text, 50) : '(callback)';
      console.log(`[${adapter.channelType}] ${ctx.requestId} RECV user=${msg.userId} chat=${msg.chatId?.slice(-8) || '?'}: ${textPreview}`);
      if (this.components.loop.isQuickMessage(adapter, msg)) {
        try {
          await this.handleInboundMessage(adapter, msg, requestId);
        } catch (err) {
          console.error(`[${adapter.channelType}] ${ctx.requestId} ERROR: ${Logger.formatError(err)}`);
        }
      } else {
        await this.components.loop.dispatchSlowMessage({
          adapter,
          msg,
          requestId,
          coalesceMessage: (dispatchAdapter, dispatchMsg) => this.components.ingress.coalesceMessages(dispatchAdapter, dispatchMsg),
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
    const { state, ingress, text, permissions, sdkEngine, commands, query } = this.components;

    // Menu events: fallback to user's last active chat
    if (!msg.chatId && msg.userId) {
      const userLastChat = state.getUserLastChat(msg.userId);
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
      const fallbackChatId = ingress.getLastChatId(adapter.channelType);
      if (fallbackChatId) {
        console.warn(`[${adapter.channelType}] ${ctx.requestId} CALLBACK fallback to last chat ${fallbackChatId.slice(-8)}`);
        msg = { ...msg, chatId: fallbackChatId };
        ctx.chatId = msg.chatId;
      }
    }

    // Auth check — with pairing mode for platforms that support it
    if (!adapter.isAuthorized(msg.userId, msg.chatId)) {
      // Pairing mode: generate code for unknown user (DM only)
      if (adapter.supportsPairing() && 'requestPairing' in adapter && msg.text) {
        const tgAdapter = adapter as any;
        const username = msg.userId;
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
      state.setUserLastChat(msg.userId, adapter.channelType, msg.chatId);
    }

    // Track last active chatId per channel type
    if (msg.chatId) {
      ingress.recordChat(adapter.channelType, msg.chatId);
    }

    const attachmentResult = ingress.prepareAttachments(msg);
    msg = attachmentResult.message;
    if (attachmentResult.handled) {
      return true;
    }

    if (await text.handle(adapter, msg)) {
      return true;
    }

    // Callback data
    if (msg.callbackData) {
      return handleCallbackMessage(adapter, msg, {
        permissions,
        sdkEngine,
        replayMessage: (replayAdapter, replayMsg) => this.handleInboundMessage(replayAdapter, replayMsg, ctx.requestId),
      });
    }

    // Bridge commands
    if (msg.text.startsWith('/')) {
      const handled = await commands.handle(adapter, msg);
      if (handled) {
        console.log(`[bridge] ${ctx.requestId} CMD ${msg.text.split(' ')[0]}`);
        return true;
      }
    }

    return query.run(adapter, msg, ctx.requestId);
  }
}
