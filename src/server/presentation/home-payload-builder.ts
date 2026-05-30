import type { BridgeStore } from '../store/interface.js';
import type { SessionStateManager } from '../engine/state/session-state.js';
import type { WorkspaceStateManager } from '../engine/state/workspace-state.js';
import type { SDKEngine } from '../engine/sdk/engine.js';
import type { PermissionCoordinator } from '../engine/coordinators/permission.js';
import type {
  HomeDirectoryData,
  HomeDirectoryEntry,
  HomeClientEntry,
  HomeData,
  HomeProviderEntry,
} from '../../shared/formatting/message-types.js';
import type { RemoteDirectoryEntry } from '../../shared/protocol/messages.js';
import type { RemoteClientRegistry } from '../clients/client-registry.js';
import type { QueryControls } from '../../shared/providers/base.js';
import type { AgentProviderRegistry } from '../../shared/providers/registry.js';
import { agentSessionKey } from '../../shared/providers/kinds.js';
import type { Locale } from '../../shared/i18n/index.js';
import type { TopicSessionManager, TopicSessionRecord } from '../engine/state/topic-sessions.js';
import type { BaseChannelAdapter } from '../channels/base.js';
import { shortPath } from '../../shared/core/path.js';
import { formatRelativeTime } from '../../shared/formatting/session-format.js';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
  remoteClientRegistry?: RemoteClientRegistry;
}

export interface HomePayloadBuildOptions {
  includeDirectory?: boolean;
}

/**
 * Builder for home screen payload data.
 * Extracted from CommandRouter for better separation of concerns.
 */
export class HomePayloadBuilder {
  constructor(private deps: HomePayloadBuilderDeps) {}

  async build(
    channelType: string,
    chatId: string,
    locale: Locale = 'zh',
    options: HomePayloadBuildOptions = {},
  ): Promise<HomeData> {
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
    const directory = options.includeDirectory
      ? await this.buildDirectoryData(currentCwd, defaultClient, clients)
      : undefined;
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
        fullCwd: currentCwd,
        binding: workspaceBinding ? shortPath(workspaceBinding) : undefined,
        project: projectName,
        directory,
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

  private async buildDirectoryData(
    currentCwd: string,
    defaultClient: string | undefined,
    clients: HomeClientEntry[],
  ): Promise<HomeDirectoryData> {
    if (defaultClient && this.deps.remoteClientRegistry) {
      return this.buildRemoteDirectoryData(currentCwd, defaultClient);
    }

    if (clients.length > 0 && !defaultClient) {
      return {
        path: currentCwd,
        displayPath: shortPath(currentCwd),
        source: 'client',
        entries: [],
        error: '请先选择一个默认执行节点，再浏览目录。',
      };
    }

    return this.buildLocalDirectoryData(currentCwd);
  }

  private async buildRemoteDirectoryData(
    currentCwd: string,
    clientId: string,
  ): Promise<HomeDirectoryData> {
    try {
      const result = await this.deps.remoteClientRegistry?.listDirectory(clientId, currentCwd);
      if (!result?.ok) {
        return directoryError(currentCwd, 'client', result?.error ?? '读取目录失败', clientId);
      }
      if (result.exists === false) {
        return directoryError(currentCwd, 'client', '目录不存在', clientId);
      }
      if (result.isDirectory === false) {
        return directoryError(currentCwd, 'client', '当前路径不是目录', clientId);
      }
      const path = result.path ?? currentCwd;
      return {
        path,
        displayPath: shortPath(path),
        source: 'client',
        clientId,
        parent: parentDirectory(path),
        entries: mapDirectoryEntries(result.entries ?? []),
        hasMore: result.hasMore,
      };
    } catch (err) {
      return directoryError(
        currentCwd,
        'client',
        err instanceof Error ? err.message : String(err),
        clientId,
      );
    }
  }

  private async buildLocalDirectoryData(currentCwd: string): Promise<HomeDirectoryData> {
    try {
      const st = await stat(currentCwd);
      if (!st.isDirectory()) {
        return directoryError(currentCwd, 'server', '当前路径不是目录');
      }
      const allEntries = await listLocalDirectoryEntries(currentCwd);
      return {
        path: currentCwd,
        displayPath: shortPath(currentCwd),
        source: 'server',
        parent: parentDirectory(currentCwd),
        entries: allEntries.slice(0, LOCAL_DIRECTORY_DISPLAY_LIMIT),
        hasMore: allEntries.length > LOCAL_DIRECTORY_DISPLAY_LIMIT,
      };
    } catch (err) {
      return directoryError(currentCwd, 'server', err instanceof Error ? err.message : String(err));
    }
  }
}

const LOCAL_DIRECTORY_DISPLAY_LIMIT = 200;

function directoryError(
  path: string,
  source: HomeDirectoryData['source'],
  error: string,
  clientId?: string,
): HomeDirectoryData {
  return {
    path,
    displayPath: shortPath(path),
    source,
    clientId,
    entries: [],
    error,
  };
}

async function listLocalDirectoryEntries(path: string): Promise<HomeDirectoryEntry[]> {
  const dirents = await readdir(path, { withFileTypes: true });
  return dirents
    .filter((entry) => entry.name !== '.' && entry.name !== '..')
    .map((entry) => ({
      name: entry.name,
      path: join(path, entry.name),
      kind: entry.isDirectory()
        ? ('directory' as const)
        : entry.isFile()
          ? ('file' as const)
          : ('other' as const),
    }))
    .sort(compareDirectoryEntries);
}

function mapDirectoryEntries(entries: RemoteDirectoryEntry[]): HomeDirectoryEntry[] {
  return entries
    .map((entry) => ({
      name: entry.name,
      path: entry.path,
      kind: entry.kind,
    }))
    .sort(compareDirectoryEntries)
    .slice(0, LOCAL_DIRECTORY_DISPLAY_LIMIT);
}

function compareDirectoryEntries(a: HomeDirectoryEntry, b: HomeDirectoryEntry): number {
  return directoryEntryRank(a) - directoryEntryRank(b) || a.name.localeCompare(b.name);
}

function directoryEntryRank(entry: HomeDirectoryEntry): number {
  const hiddenOffset = entry.name.startsWith('.') ? 10 : 0;
  if (entry.kind === 'directory') return hiddenOffset;
  if (entry.kind === 'file') return hiddenOffset + 1;
  return hiddenOffset + 2;
}

function parentDirectory(path: string): string | undefined {
  const parent = dirname(path);
  return parent && parent !== path ? parent : undefined;
}
