import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage, RenderedMessage } from '../../channels/types.js';
import type { FormattableMessage } from '../../formatting/message-types.js';
import type { AutomationBridge } from '../types/automation-bridge.js';
import { loadConfig, type Config } from '../../config.js';
import { WebhookServer } from '../automation/webhook.js';
import {
  buildFileSendSystemPrompt,
  configureFileSendEnvironment,
} from '../automation/file-send-prompt.js';
import {
  AutomationPromptInjector,
  type AutomationPromptOptions,
  type AutomationPromptResult,
} from '../automation/prompt-injector.js';
import type { BridgeStore } from '../../store/interface.js';
import type { AgentProvider } from '../../providers/base.js';
import type { AgentProviderRegistry } from '../../providers/registry.js';
import {
  createBridgeComponents,
  type BridgeComponents,
  type BridgeFactoryDeps,
} from '../bridge-factory.js';
import type { PermissionCoordinator } from './permission.js';
import type { ChannelRouter } from '../../utils/router.js';
import type { SDKEngine } from '../sdk/engine.js';
import type { IngressCoordinator } from './ingress.js';
import type { SessionStateManager } from '../state/session-state.js';
import type { QueryOrchestrator } from './query.js';
import { InboundDispatcher } from './inbound-dispatcher.js';
import { AdapterLoopRunner } from './adapter-loop-runner.js';

interface BridgeManagerDeps {
  store: BridgeStore;
  llm: AgentProvider;
  providers?: AgentProviderRegistry;
  defaultWorkdir: string;
  config?: Config;
}

export class BridgeManager implements AutomationBridge {
  private adapters = new Map<string, BaseChannelAdapter>();
  private running = false;
  private components: BridgeComponents;
  private inbound: InboundDispatcher;
  private adapterLoop: AdapterLoopRunner;
  private automationPrompts: AutomationPromptInjector;
  /** Webhook server for automation entry */
  private webhookServer: WebhookServer | null = null;
  /** Cleanup timer for SDK question data */
  private sdkQuestionCleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: BridgeManagerDeps) {
    const config = deps.config ?? loadConfig();
    const { store, llm, defaultWorkdir, providers } = deps;
    configureFileSendEnvironment({
      enabled: config.webhook.enabled,
      port: config.webhook.port,
      token: config.webhook.token,
    });
    const appendSystemPrompt = buildFileSendSystemPrompt({
      enabled: config.webhook.enabled,
      port: config.webhook.port,
      token: config.webhook.token,
    });

    // Create all engine components via factory
    const factoryDeps: BridgeFactoryDeps = {
      store,
      llm,
      providers,
      defaultWorkdir,
      config,
      getAdapters: () => this.adapters,
      appendSystemPrompt,
    };
    this.components = createBridgeComponents(factoryDeps);
    this.inbound = new InboundDispatcher({
      state: this.components.state,
      ingress: this.components.ingress,
      text: this.components.text,
      permissions: this.components.permissions,
      sdkEngine: this.components.sdkEngine,
      commands: this.components.commands,
      query: this.components.query,
    });
    this.adapterLoop = new AdapterLoopRunner({
      ingress: this.components.ingress,
      loop: this.components.loop,
      handleInboundMessage: (adapter, msg, requestId) =>
        this.handleInboundMessage(adapter, msg, requestId),
    });
    this.automationPrompts = new AutomationPromptInjector({
      getAdapter: (channelType) => this.getAdapter(channelType),
      router: this.components.router,
      store: this.components.store,
      ingress: this.components.ingress,
      query: this.components.query,
    });

    // Initialize webhook server if enabled.
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

  async injectAutomationPrompt(options: AutomationPromptOptions): Promise<AutomationPromptResult> {
    return this.automationPrompts.inject(options);
  }

  /** Get the last active chatId for a given channel type. */
  getLastChatId(channelType: string): string {
    return this.components.ingress.getLastChatId(channelType);
  }

  resolveFileDeliveryToken(token: string) {
    return this.components.sdkEngine.resolveFileDeliveryToken(token);
  }

  /** Broadcast a message to all active IM channels */
  async broadcast(msg: Omit<RenderedMessage, 'chatId'>): Promise<void> {
    for (const adapter of this.getAdapters()) {
      const chatId = this.getBroadcastTarget(adapter.channelType);
      if (!chatId) continue;
      const baseMsg = { chatId, ...msg } as RenderedMessage;
      await adapter.send(baseMsg);
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
      await adapter.send(outMsg);
    }
  }

  /** Get target chatId for broadcast messages */
  private getBroadcastTarget(channelType: string): string {
    return this.getLastChatId(channelType);
  }

  /** Delegate: track a permission message for text-based approval */
  trackPermissionMessage(
    messageId: string,
    permissionId: string,
    sessionId: string,
    channelType: string,
  ): void {
    this.components.permissions.trackPermissionMessage(
      messageId,
      permissionId,
      sessionId,
      channelType,
    );
  }

  /** Delegate: store AskUserQuestion data */
  storeQuestionData(
    interactionId: string,
    questions: Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect: boolean;
    }>,
    contextSuffix?: string,
  ): void {
    this.components.permissions.storeQuestionData(interactionId, questions, contextSuffix);
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
      if (err) {
        console.warn(`Skipping ${type}: ${err}`);
        this.adapters.delete(type);
        continue;
      }
      await adapter.start();
      this.runAdapterLoop(adapter);
    }
    this.components.permissions.startPruning();
    this.components.sdkEngine.startSessionPruning();
    this.sdkQuestionCleanupTimer = setInterval(
      () => {
        const interactionState = this.components.sdkEngine.getInteractionState();
        const gateway = this.components.permissions.getGateway();
        interactionState.pruneResolvedSdkQuestions(gateway);
        interactionState.pruneResolvedDeferredTools(gateway);
        this.components.ingress.pruneStaleState();
      },
      5 * 60 * 1000,
    );
    if (this.webhookServer) {
      this.webhookServer.start();
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
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }
  }

  private async runAdapterLoop(adapter: BaseChannelAdapter): Promise<void> {
    return this.adapterLoop.run(adapter, () => this.running);
  }

  private sendErrorNotification(
    adapter: BaseChannelAdapter,
    chatId: string | undefined,
    err: unknown,
    requestId?: string,
    sourceMsg?: InboundMessage,
  ): void {
    this.adapterLoop.sendErrorNotification(adapter, chatId, err, requestId, sourceMsg);
  }

  async handleInboundMessage(
    adapter: BaseChannelAdapter,
    msg: InboundMessage,
    requestId?: string,
  ): Promise<boolean> {
    return this.inbound.handle(adapter, msg, requestId);
  }
}
