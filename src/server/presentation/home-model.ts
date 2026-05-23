import { basename } from 'node:path';
import { THREAD_SCOPE_SEPARATOR, splitChatKey } from '../../shared/core/key.js';
import { shortPath } from '../../shared/core/path.js';
import { SESSION_STALE_THRESHOLD_MS } from '../../shared/core/timing.js';
import {
  formatRelativeTime,
  formatSessionDate,
  formatSize,
} from '../../shared/formatting/session-format.js';
import type { HomeData } from '../../shared/formatting/message-types.js';
import type { QueryControls } from '../../shared/providers/base.js';
import {
  agentSessionKey,
  normalizeAgentProviderKind,
  type AgentProviderKind,
} from '../../shared/providers/kinds.js';
import type { AgentSessionDescriptor } from '../../shared/formatting/message-types.js';
import type { ChannelBinding } from '../store/interface.js';
import type { Locale } from '../../shared/i18n/index.js';
import type { TopicSessionManager, TopicSessionRecord } from '../engine/state/topic-sessions.js';
import { t } from '../../shared/i18n/index.js';

export type BoundInfo = {
  channelType: string;
  chatId: string;
  provider: AgentProviderKind;
  isActive: boolean;
};

type StateKey = (channelType: string, chatId: string) => string;
type HomeSessionEntry = NonNullable<HomeData['session']['recent']>[number];
type HomeTopicEntry = NonNullable<HomeData['session']['topics']>[number];
type RecentProjectEntry = NonNullable<HomeData['recentProjects']>[number];

export interface HomeSessionSource extends AgentSessionDescriptor {
  clientId?: string;
  transcript?: Array<{ role: string; text: string; timestamp?: string }>;
}

export function buildActiveSdkSessionBindings(
  bindings: ChannelBinding[],
  activeControls: Map<string, QueryControls>,
  stateKey: StateKey,
): Map<string, BoundInfo> {
  const result = new Map<string, BoundInfo>();
  for (const binding of bindings) {
    if (!binding.sdkSessionId) continue;
    const provider = normalizeAgentProviderKind(binding.provider);
    result.set(agentSessionKey(provider, binding.sdkSessionId), {
      channelType: binding.channelType,
      chatId: binding.chatId,
      provider,
      isActive: activeControls.has(stateKey(binding.channelType, binding.chatId)),
    });
  }
  return result;
}

export function hasActiveTaskInConversation(
  channelType: string,
  chatId: string,
  activeControls: Map<string, QueryControls>,
  stateKey: StateKey,
): boolean {
  if (activeControls.has(stateKey(channelType, chatId))) return true;
  for (const key of activeControls.keys()) {
    const parsed = splitChatKey(key);
    if (parsed.channelType !== channelType) continue;
    if (parsed.chatId.startsWith(`${chatId}${THREAD_SCOPE_SEPARATOR}`)) return true;
  }
  return false;
}

export function buildRecentProjects(
  sessions: HomeSessionSource[],
  currentCwd: string,
): RecentProjectEntry[] {
  const workdirs = new Map<string, { lastMtime: number }>();
  for (const session of sessions) {
    const existing = workdirs.get(session.cwd);
    if (existing) {
      existing.lastMtime = Math.max(existing.lastMtime, session.mtime);
    } else {
      workdirs.set(session.cwd, { lastMtime: session.mtime });
    }
  }

  return Array.from(workdirs.entries())
    .sort((a, b) => b[1].lastMtime - a[1].lastMtime)
    .slice(0, 5)
    .map(([workdir]) => ({
      name: basename(workdir),
      workdir: shortPath(workdir),
      fullWorkdir: workdir,
      isCurrent: workdir === currentCwd,
    }));
}

export function buildTopicEntries(opts: {
  topicSessions?: TopicSessionManager;
  channelType: string;
  chatId: string;
  currentCwd: string;
  binding?: ChannelBinding | null;
  activeControls: Map<string, QueryControls>;
  stateKey: StateKey;
  locale: Locale;
  providerDisplayName?: (provider: AgentProviderKind | undefined) => string | undefined;
  resolveClientSession?: (record: TopicSessionRecord) => HomeSessionSource | undefined;
}): HomeTopicEntry[] {
  return (
    opts.topicSessions
      ?.listRecent(8, {
        channelType: opts.channelType,
        chatId: opts.chatId,
      })
      .flatMap((record) => {
        const provider = normalizeAgentProviderKind(record.provider);
        const clientSession = opts.resolveClientSession?.(record);
        if (!clientSession) return [];
        const agentSessionLabel = t('homeModel.agentSession');
        return {
          index: 0,
          sdkSessionId: clientSession.sdkSessionId,
          scopeId: record.scopeId,
          threadId: record.threadId,
          cwd: shortPath(clientSession.cwd || record.cwd || opts.currentCwd),
          title: record.title || clientSession.preview || agentSessionLabel,
          preview: clientSession.preview || record.preview || record.title || agentSessionLabel,
          provider: clientSession.provider ?? provider,
          providerDisplayName:
            clientSession.providerDisplayName ?? opts.providerDisplayName?.(provider),
          clientId: clientSession.clientId,
          updatedAt: formatRelativeTime(new Date(record.updatedAt).getTime(), opts.locale),
          isCurrent:
            !!opts.binding?.sdkSessionId &&
            opts.binding.sdkSessionId === record.sdkSessionId &&
            normalizeAgentProviderKind(opts.binding.provider) === provider,
          isActive: opts.activeControls.has(opts.stateKey(record.channelType, record.scopeId)),
        };
      })
      .map((entry, index) => ({ ...entry, index: index + 1 })) ?? []
  );
}

export function buildHomeSessionEntries(
  sessions: HomeSessionSource[],
  opts: {
    binding?: ChannelBinding | null;
    activeSdkSessionBindings: Map<string, BoundInfo>;
    channelType: string;
    chatId: string;
    topicSessions?: TopicSessionManager;
    now: number;
    locale: Locale;
    boundFilter: (
      boundInfo: BoundInfo | undefined,
      session: HomeSessionSource,
    ) => BoundInfo | undefined;
  },
): HomeSessionEntry[] {
  return sessions.map((session, index) => {
    const sessionKey = agentSessionKey(session.provider, session.sdkSessionId);
    const boundInfo = opts.activeSdkSessionBindings.get(sessionKey);
    const boundToActiveSession = opts.boundFilter(boundInfo, session);
    const topic = opts.topicSessions?.findBySdkSession(session.provider, session.sdkSessionId);
    return {
      index: index + 1,
      provider: session.provider,
      providerDisplayName: session.providerDisplayName,
      clientId: session.clientId,
      sdkSessionId: session.sdkSessionId,
      date: formatSessionDate(session.mtime, opts.locale),
      cwd: shortPath(session.cwd),
      size: session.size === undefined ? undefined : formatSize(session.size),
      preview: session.preview,
      transcript: session.transcript,
      isCurrent:
        opts.binding?.sdkSessionId === session.sdkSessionId &&
        normalizeAgentProviderKind(opts.binding?.provider) === session.provider,
      topic: topic
        ? {
            scopeId: topic.scopeId,
            threadId: topic.threadId,
            updatedAt: formatRelativeTime(new Date(topic.updatedAt).getTime(), opts.locale),
            isActive: opts.activeSdkSessionBindings.get(sessionKey)?.isActive ?? false,
          }
        : undefined,
      boundToActiveSession,
      isStale: opts.now - session.mtime > SESSION_STALE_THRESHOLD_MS,
    };
  });
}
