import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage, RenderedMessage } from '../../channels/types.js';
import type { FormattableMessage } from '../../../shared/formatting/message-types.js';
import type { TliveMcpBridge } from '../../mcp/bridge.js';
import { loadConfig, type Config } from '../../../shared/config.js';
import { TliveMcpHttpServer } from '../../mcp/http-server.js';
import type { BridgeStore } from '../../store/interface.js';
import type { HomeClientEntry } from '../../../shared/formatting/message-types.js';
import type { AgentProvider } from '../../../shared/providers/base.js';
import type { AgentProviderRegistry } from '../../../client/providers/registry.js';
import type { RemoteClientRegistry } from '../../clients/client-registry.js';
import {
  createBridgeComponents,
  type BridgeComponents,
  type BridgeFactoryDeps,
} from '../bridge-factory.js';
import type { PermissionCoordinator } from './permission.js';
import type { ChannelRouter } from '../channel-router.js';
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
  getExecutionClients?: () => HomeClientEntry[];
  remoteClientRegistry?: RemoteClientRegistry;
}

export class BridgeManager implements TliveMcpBridge {
  private adapters = new Map<string, BaseChannelAdapter>();
  private running = false;
  private components: BridgeComponents;
  private inbound: InboundDispatcher;
  private adapterLoop: AdapterLoopRunner;
  private mcpServer: TliveMcpHttpServer | null = null;
  /** Cleanup timer for SDK question data */
  private sdkQuestionCleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: BridgeManagerDeps) {
    const config = deps.config ?? loadConfig();
    const { store, llm, defaultWorkdir, providers } = deps;

    // Create all engine components via factory
    const factoryDeps: BridgeFactoryDeps = {
      store,
      llm,
      providers,
      defaultWorkdir,
      config,
      getAdapters: () => this.adapters,
      getExecutionClients: deps.getExecutionClients,
      remoteClientRegistry: deps.remoteClientRegistry,
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
    if (config.mcp.enabled && config.mcp.token) {
      this.mcpServer = new TliveMcpHttpServer({
        token: config.mcp.token,
        port: config.mcp.port,
        path: config.mcp.path,
        bridge: this,
        defaultWorkdir,
        maxFileSizeBytes: config.mcp.maxFileSizeBytes,
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
    if (this.mcpServer) {
      this.mcpServer.start();
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
    if (this.mcpServer) {
      this.mcpServer.stop();
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
