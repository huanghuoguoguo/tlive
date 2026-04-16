import type { BridgeStore } from '../store/interface.js';
import type { ClaudeSDKProvider } from '../providers/claude-sdk.js';
import type { Config, ProjectsValidationResult } from '../config.js';
import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import { ChannelRouter } from '../utils/router.js';
import { PermissionBroker } from '../permissions/broker.js';
import { PendingPermissions } from '../permissions/gateway.js';
import { SessionStateManager } from './state/session-state.js';
import { WorkspaceStateManager } from './state/workspace-state.js';
import { RecentProjectsManager } from './state/recent-projects.js';
import { PermissionCoordinator } from './coordinators/permission.js';
import { CommandRouter } from './command-router.js';
import { SDKEngine } from './sdk/engine.js';
import { IngressCoordinator } from './coordinators/ingress.js';
import { MessageLoopCoordinator } from './coordinators/message-loop.js';
import { TextDispatcher } from './messages/text-dispatcher.js';
import { QueryOrchestrator } from './coordinators/query.js';
import { ConversationEngine } from '../utils/conversation.js';
import { HookNotificationDispatcher } from './messages/hook-notification.js';
import { getTliveRuntimeDir } from '../core/path.js';
import { loadProjectsConfig } from '../config.js';
import { networkInterfaces } from 'node:os';
import { commandRegistry } from './commands/index.js';

/** Get quick commands from registry */
function getQuickCommands(): Set<string> {
  return commandRegistry.getQuickCommands();
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

/** All engine components created by BridgeFactory */
export interface BridgeComponents {
  store: BridgeStore;
  router: ChannelRouter;
  state: SessionStateManager;
  workspace: WorkspaceStateManager;
  recentProjects: RecentProjectsManager;
  permissions: PermissionCoordinator;
  sdkEngine: SDKEngine;
  ingress: IngressCoordinator;
  loop: MessageLoopCoordinator;
  text: TextDispatcher;
  query: QueryOrchestrator;
  commands: CommandRouter;
  notifications: HookNotificationDispatcher;
  engine: ConversationEngine;
  port: number;
  localUrl: string;
  projectsConfig: ProjectsValidationResult | undefined;
}

/** Dependencies needed to create BridgeComponents */
export interface BridgeFactoryDeps {
  store: BridgeStore;
  llm: ClaudeSDKProvider;
  defaultWorkdir: string;
  config: Config;
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
  const runtimeDir = getTliveRuntimeDir();
  const localUrl = `http://${getLocalIP()}:${config.port || 8080}`;
  const gateway = new PendingPermissions();
  const broker = new PermissionBroker(gateway, localUrl);
  const port = config.port || 8080;

  const router = new ChannelRouter(store);
  const state = new SessionStateManager(runtimeDir);
  const workspace = new WorkspaceStateManager(runtimeDir);
  const recentProjects = new RecentProjectsManager(runtimeDir);
  const permissions = new PermissionCoordinator(gateway, broker);
  const engine = new ConversationEngine(store, llm);
  const sdkEngine = new SDKEngine();

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
    hasPendingSdkQuestion: (channelType: string, chatId: string) => text.hasPendingSdkQuestion(channelType, chatId),
    resolveProcessingKey: async (msg: InboundMessage) => {
      const binding = await router.resolve(msg.channelType, msg.chatId);
      if (msg.replyToMessageId) {
        return sdkEngine.getSessionForBubble(msg.replyToMessageId)
          ?? sdkEngine.getSessionKeyForBinding(msg.channelType, msg.chatId, binding.sessionId);
      }
      return sdkEngine.getSessionKeyForBinding(msg.channelType, msg.chatId, binding.sessionId);
    },
  });

  const query = new QueryOrchestrator({
    engine,
    llm,
    router,
    state,
    permissions,
    sdkEngine,
    store,
    defaultWorkdir,
    defaultClaudeSettingSources: config.claudeSettingSources,
    port,
    appendSystemPrompt: undefined, // Will be set by BridgeManager
  });

  const commands = new CommandRouter(
    state,
    workspace,
    recentProjects,
    () => new Map<string, BaseChannelAdapter>(), // Will be replaced by BridgeManager
    router,
    store,
    defaultWorkdir,
    llm,
    sdkEngine.getActiveControls(),
    permissions,
    config.claudeSettingSources,
    sdkEngine,
    projectsConfig,
  );

  const notifications = new HookNotificationDispatcher({
    permissions,
    buildTerminalUrl: (sessionId: string) => `http://${getLocalIP()}:${port}/terminal.html?id=${sessionId}`,
  });

  return {
    store,
    router,
    state,
    workspace,
    recentProjects,
    permissions,
    sdkEngine,
    ingress,
    loop,
    text,
    query,
    commands,
    notifications,
    engine,
    port,
    localUrl,
    projectsConfig,
  };
}