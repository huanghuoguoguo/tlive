import { basename } from 'node:path';
import { THREAD_SCOPE_SEPARATOR, splitChatKey } from '../../core/key.js';
import { shortPath } from '../../core/path.js';
import { SESSION_STALE_THRESHOLD_MS } from '../../core/timing.js';
import {
  formatRelativeTime,
  formatSessionDate,
  formatSize,
} from '../../formatting/session-format.js';
import type { HomeData } from '../../formatting/message-types.js';
import type { QueryControls } from '../../providers/base.js';
import {
  agentSessionKey,
  normalizeAgentProviderKind,
  type AgentProviderKind,
} from '../../providers/kinds.js';
import {
  readSessionTranscriptPreview,
  type ScannedSession,
} from '../../providers/session-scanner.js';
import type { ChannelBinding } from '../../store/interface.js';
import type { Locale } from '../../i18n/index.js';
import type { TopicSessionManager } from '../state/topic-sessions.js';
import { t } from '../../i18n/index.js';

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
  sessions: ScannedSession[],
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
}): HomeTopicEntry[] {
  return (
    opts.topicSessions
      ?.listRecent(8, {
        channelType: opts.channelType,
        chatId: opts.chatId,
      })
      .map((record, index) => {
        const provider = normalizeAgentProviderKind(record.provider);
        const agentSessionLabel = t('homeModel.agentSession');
        return {
          index: index + 1,
          sdkSessionId: record.sdkSessionId,
          scopeId: record.scopeId,
          threadId: record.threadId,
          cwd: shortPath(record.cwd || opts.currentCwd),
          title: record.title || record.preview || agentSessionLabel,
          preview: record.preview || record.title || agentSessionLabel,
          provider,
          providerDisplayName: opts.providerDisplayName?.(provider),
          clientId: record.clientId,
          updatedAt: formatRelativeTime(new Date(record.updatedAt).getTime(), opts.locale),
          isCurrent:
            !!opts.binding?.sdkSessionId &&
            opts.binding.sdkSessionId === record.sdkSessionId &&
            normalizeAgentProviderKind(opts.binding.provider) === provider,
          isActive: opts.activeControls.has(opts.stateKey(record.channelType, record.scopeId)),
        };
      }) ?? []
  );
}

export function buildHomeSessionEntries(
  sessions: ScannedSession[],
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
      session: ScannedSession,
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
      sdkSessionId: session.sdkSessionId,
      date: formatSessionDate(session.mtime, opts.locale),
      cwd: shortPath(session.cwd),
      size: formatSize(session.size),
      preview: session.preview,
      transcript: readSessionTranscriptPreview(session, 4),
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
