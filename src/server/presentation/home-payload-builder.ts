import type { BridgeStore } from '../store/interface.js';
import type { SessionStateManager } from '../engine/state/session-state.js';
import type { WorkspaceStateManager } from '../engine/state/workspace-state.js';
import type { SDKEngine } from '../engine/sdk/engine.js';
import type { PermissionCoordinator } from '../engine/coordinators/permission.js';
import type {
  HomeClientEntry,
  HomeData,
  HomeProviderEntry,
} from '../../shared/formatting/message-types.js';
import type { QueryControls } from '../../shared/providers/base.js';
import type { AgentProviderRegistry } from '../../client/providers/registry.js';
import { agentSessionKey } from '../../shared/providers/kinds.js';
import type { Locale } from '../../shared/i18n/index.js';
import type { TopicSessionManager, TopicSessionRecord } from '../engine/state/topic-sessions.js';
import type { BaseChannelAdapter } from '../channels/base.js';
import { shortPath } from '../../shared/core/path.js';
import { formatRelativeTime } from '../../shared/formatting/session-format.js';
import {
  buildActiveSdkSessionBindings,
  buildHomeSessionEntries,
  buildRecentProjects,
  buildTopicEntries,
  hasActiveTaskInConversation,
  type HomeSessionSource,
} from './home-model.js';

function homeProviderEntry(provider: {
  kind: HomeProviderEntry['kind'];
  displayName: string;
  available: boolean;
  isDefault: boolean;
  reason?: string;
}): HomeProviderEntry {
  return {
    kind: provider.kind,
    displayName: provider.displayName,
    available: provider.available,
    isDefault: provider.isDefault,
    reason: provider.reason,
  };
}

function buildSessionClientIndex(clients: HomeClientEntry[]): Map<string, HomeSessionSource> {
  const out = new Map<string, HomeSessionSource>();
  for (const client of clients) {
    for (const session of client.sessions ?? []) {
      out.set(agentSessionKey(session.provider, session.sdkSessionId), {
        ...session,
        clientId: client.clientId,
      });
    }
  }
  return out;
}

function clientSessions(clients: HomeClientEntry[]): HomeSessionSource[] {
  return clients
    .flatMap((client) =>
      (client.sessions ?? []).map((session) => ({
        ...session,
        clientId: client.clientId,
      })),
    )
    .sort((a, b) => b.mtime - a.mtime);
}

function clientSessionForTopic(
  record: TopicSessionRecord,
  sessionClientIndex: Map<string, HomeSessionSource>,
): HomeSessionSource | undefined {
  if (!record.sdkSessionId) return undefined;
  return sessionClientIndex.get(agentSessionKey(record.provider, record.sdkSessionId));
}

export interface HomePayloadBuilderDeps {
  store: BridgeStore;
  state: SessionStateManager;
  workspace: WorkspaceStateManager;
  sdkEngine?: SDKEngine;
  permissions: PermissionCoordinator;
  activeControls: Map<string, QueryControls>;
  getAdapters: () => Map<string, BaseChannelAdapter>;
  defaultWorkdir: string;
  providers: AgentProviderRegistry;
  topicSessions?: TopicSessionManager;
  getExecutionClients?: () => HomeClientEntry[];
}

/**
 * Builder for home screen payload data.
 * Extracted from CommandRouter for better separation of concerns.
 */
export class HomePayloadBuilder {
  constructor(private deps: HomePayloadBuilderDeps) {}

  async build(channelType: string, chatId: string, locale: Locale = 'zh'): Promise<HomeData> {
    const {
      store,
      state,
      workspace,
      sdkEngine,
      permissions,
      activeControls,
      getAdapters,
      defaultWorkdir,
      providers,
    } = this.deps;
    const topicSessions = this.deps.topicSessions;
    const binding = await store.getBinding(channelType, chatId);
    const clients = this.deps.getExecutionClients?.() ?? [];
    const defaultClient =
      binding?.clientId && clients.some((client) => client.clientId === binding.clientId)
        ? binding.clientId
        : clients.length === 1
          ? clients[0].clientId
          : undefined;
    const currentCwd = binding?.cwd || defaultWorkdir;
    const chatKey = state.stateKey(channelType, chatId);
    const now = Date.now();

    const allClientSessions = clientSessions(clients);
    const recentSessions = allClientSessions.slice(0, 10);
    const allSessions = allClientSessions.slice(0, 10);
    const allSessionsGlobal = allClientSessions.slice(0, 50);
    const allBindings = await store.listBindings();
    const sessionClientIndex = buildSessionClientIndex(clients);
    const activeSdkSessionBindings = buildActiveSdkSessionBindings(
      allBindings,
      activeControls,
      state.stateKey.bind(state),
    );
    const hasActiveTaskInChat = hasActiveTaskInConversation(
      channelType,
      chatId,
      activeControls,
      state.stateKey.bind(state),
    );

    const permStatus = permissions.getPermissionStatus(chatKey, binding?.sessionId);
    const adapters = getAdapters();
    const activeChannels = Array.from(adapters.keys());
    const channelInfo = Array.from(adapters.values()).map((adapter) => ({
      type: adapter.channelType,
      ...adapter.getBotInfo(),
    }));
    const workspaceBinding = workspace.getBinding(channelType, chatId);
    const projectName = binding?.projectName;
    const lastActiveTime = state.getLastActiveTime(channelType, chatId);
    const currentSessionKey = binding?.sessionId
      ? sdkEngine?.getSessionKeyForBinding?.(channelType, chatId, binding.sessionId)
      : sdkEngine?.getActiveSessionKey(channelType, chatId);
    const queueInfo = currentSessionKey ? sdkEngine?.getQueueInfo(currentSessionKey) : undefined;
    const sessionStale = currentSessionKey
      ? (sdkEngine?.isSessionStale(currentSessionKey) ?? false)
      : false;

    const topicEntries = buildTopicEntries({
      topicSessions,
      channelType,
      chatId,
      currentCwd,
      binding,
      activeControls,
      stateKey: state.stateKey.bind(state),
      locale,
      providerDisplayName: (kind) =>
        kind ? (providers.descriptor(kind)?.displayName ?? kind) : undefined,
      resolveClientSession: (record) => clientSessionForTopic(record, sessionClientIndex),
    });

    return {
      providers: {
        defaultKind: providers.defaultProviderKind,
        available: providers.availableForNewSession().map(homeProviderEntry),
        all: providers.list().map(homeProviderEntry),
      },
      clients: {
        defaultClientId: defaultClient,
        entries: clients.map((client) => ({
          ...client,
          isDefault: client.clientId === defaultClient,
        })),
      },
      workspace: {
        cwd: shortPath(currentCwd),
        binding: workspaceBinding ? shortPath(workspaceBinding) : undefined,
        project: projectName,
      },
      task: {
        active: hasActiveTaskInChat,
      },
      session: {
        topics: topicEntries.length > 0 ? topicEntries : undefined,
        recent: buildHomeSessionEntries(recentSessions, {
          binding,
          activeSdkSessionBindings,
          channelType,
          chatId,
          topicSessions,
          now,
          locale,
          boundFilter: (bi) =>
            bi && !bi.isActive && bi.channelType === channelType && bi.chatId === chatId
              ? undefined
              : bi?.isActive
                ? bi
                : undefined,
        }),
        all: buildHomeSessionEntries(allSessions, {
          binding,
          activeSdkSessionBindings,
          channelType,
          chatId,
          topicSessions,
          now,
          locale,
          boundFilter: (bi, session) =>
            bi?.isActive &&
            !(
              bi.channelType === channelType &&
              bi.chatId === chatId &&
              binding?.sdkSessionId &&
              agentSessionKey(binding.provider, binding.sdkSessionId) ===
                agentSessionKey(session.provider, session.sdkSessionId)
            )
              ? bi
              : undefined,
        }),
        stale: sessionStale,
        lastActiveAt: lastActiveTime ? formatRelativeTime(lastActiveTime, locale) : undefined,
      },
      permission: {
        mode: state.getPermMode(channelType, chatId),
        pending: permStatus.pending,
        lastDecision: permStatus.lastDecision,
        whitelistCount: permStatus.rememberedTools + permStatus.rememberedBashPrefixes,
      },
      bridge: {
        healthy: activeChannels.length > 0,
        channels: activeChannels,
        channelInfo,
        queueInfo,
      },
      help: {
        entries: [], // Will be populated by CommandRouter if needed
        recentSummary: recentSessions[0]?.preview,
      },
      recentProjects: buildRecentProjects(allSessionsGlobal, currentCwd),
    };
  }
}
