import type { BridgeStore } from '../store/interface.js';
import type { AgentProvider } from '../providers/base.js';
import { singleProviderRegistry, type AgentProviderRegistry } from '../providers/registry.js';
import type { Config, ProjectsValidationResult } from '../config.js';
import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import { ChannelRouter } from '../utils/router.js';
import { PendingPermissions } from '../permissions/gateway.js';
import { SessionStateManager } from './state/session-state.js';
import { WorkspaceStateManager } from './state/workspace-state.js';
import { RecentProjectsManager } from './state/recent-projects.js';
import { TopicSessionManager } from './state/topic-sessions.js';
import { PermissionCoordinator } from './coordinators/permission.js';
import { CommandRouter } from './command-router.js';
import { SDKEngine } from './sdk/engine.js';
import { IngressCoordinator } from './coordinators/ingress.js';
import { MessageLoopCoordinator } from './coordinators/message-loop.js';
import { TextDispatcher } from './messages/text-dispatcher.js';
import { QueryOrchestrator } from './coordinators/query.js';
import { ConversationEngine } from '../utils/conversation.js';
import { getTliveRuntimeDir } from '../core/path.js';
import { loadProjectsConfig } from '../config.js';
import { commandRegistry } from './commands/index.js';
import { conversationScopeId } from '../channels/conversation-context.js';

/** Get quick commands from registry */
function getQuickCommands(): Set<string> {
  return commandRegistry.getQuickCommands();
}

/** All engine components created by BridgeFactory */
export interface BridgeComponents {
  store: BridgeStore;
  router: ChannelRouter;
  state: SessionStateManager;
  workspace: WorkspaceStateManager;
  recentProjects: RecentProjectsManager;
  topicSessions: TopicSessionManager;
  permissions: PermissionCoordinator;
  sdkEngine: SDKEngine;
  ingress: IngressCoordinator;
  loop: MessageLoopCoordinator;
  text: TextDispatcher;
  query: QueryOrchestrator;
  commands: CommandRouter;
  engine: ConversationEngine;
  port: number;
  projectsConfig: ProjectsValidationResult | undefined;
}

/** Dependencies needed to create BridgeComponents */
export interface BridgeFactoryDeps {
  store: BridgeStore;
  llm: AgentProvider;
  providers?: AgentProviderRegistry;
  defaultWorkdir: string;
  config: Config;
  getAdapters?: () => Map<string, BaseChannelAdapter>;
  appendSystemPrompt?: string;
}

/**
 * Factory function that creates all engine components.
 *
 * Extracted from BridgeManager to enable:
 * - Direct component construction in tests (no `(manager as any)` hacks)
 * - Separation of component wiring from adapter lifecycle
 */
export function createBridgeComponents(deps: BridgeFactoryDeps): BridgeComponents {
  const { store, llm, defaultWorkdir, config } = deps;
  const providers = deps.providers ?? singleProviderRegistry(llm);
  const getAdapters = deps.getAdapters ?? (() => new Map<string, BaseChannelAdapter>());
  const runtimeDir = getTliveRuntimeDir();
  const gateway = new PendingPermissions();
  const port = config.port || 8080;

  const router = new ChannelRouter(store);
  const state = new SessionStateManager(runtimeDir);
  const workspace = new WorkspaceStateManager(runtimeDir);
  const recentProjects = new RecentProjectsManager(runtimeDir);
  const topicSessions = new TopicSessionManager(runtimeDir);
  const permissions = new PermissionCoordinator(gateway);
  const engine = new ConversationEngine(store);
  const sdkEngine = new SDKEngine();
  sdkEngine.onSessionCreated = (_sessionKey: string, workdir: string) => {
    recentProjects.recordSession(workdir);
  };

  const projectsConfig = loadProjectsConfig();

  const ingress = new IngressCoordinator();

  const text = new TextDispatcher({
    permissions,
    sdkEngine,
    state,
  });

  const loop = new MessageLoopCoordinator({
    state,
    sdkEngine,
    permissions,
    quickCommands: getQuickCommands(),
    hasPendingSdkQuestion: (msg: InboundMessage) => text.hasPendingSdkQuestion(msg),
    resolveProcessingKey: async (msg: InboundMessage) => {
      const scopeId = conversationScopeId(msg);
      const binding = await router.resolve(msg.channelType, scopeId);
      if (msg.replyToMessageId) {
        return (
          sdkEngine.getSessionForBubble(msg.replyToMessageId) ??
          sdkEngine.getSessionKeyForBinding(msg.channelType, scopeId, binding.sessionId)
        );
      }
      return sdkEngine.getSessionKeyForBinding(msg.channelType, scopeId, binding.sessionId);
    },
  });

  const query = new QueryOrchestrator({
    engine,
    llm,
    providers,
    router,
    state,
    permissions,
    sdkEngine,
    store,
    defaultWorkdir,
    topicSessions,
    defaultAgentSettingSources: config.agentSettingSources,
    port,
    appendSystemPrompt: deps.appendSystemPrompt,
    onConversationMessageResolved: (msg) => ingress.recordDeliveryTarget(msg),
  });

  const commands = new CommandRouter(
    state,
    workspace,
    recentProjects,
    getAdapters,
    router,
    store,
    defaultWorkdir,
    llm,
    providers,
    sdkEngine.getActiveControls(),
    permissions,
    config.agentSettingSources,
    sdkEngine,
    projectsConfig,
    topicSessions,
  );

  return {
    store,
    router,
    state,
    workspace,
    recentProjects,
    topicSessions,
    permissions,
    sdkEngine,
    ingress,
    loop,
    text,
    query,
    commands,
    engine,
    port,
    projectsConfig,
  };
}
