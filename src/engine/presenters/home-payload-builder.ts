import type { BridgeStore, ChannelBinding } from '../../store/interface.js';
import type { SessionStateManager } from '../state/session-state.js';
import type { WorkspaceStateManager } from '../state/workspace-state.js';
import type { SDKEngine } from '../sdk/engine.js';
import type { PermissionCoordinator } from '../coordinators/permission.js';
import type { HomeData } from '../../formatting/message-types.js';
import type { ScannedSession } from '../../providers/session-scanner.js';
import type { QueryControls } from '../../providers/base.js';
import { scanClaudeSessions, readSessionTranscriptPreview } from '../../providers/session-scanner.js';
import { shortPath } from '../../utils/path.js';
import { formatSize, formatSessionDate, formatRelativeTime } from '../../utils/session-format.js';
import { SESSION_STALE_THRESHOLD_MS } from '../../utils/constants.js';

type BoundInfo = { channelType: string; chatId: string; isActive: boolean };

/** Shared mapping for scanned sessions (used by both recentSessions and allSessions) */
function mapScannedSession(
  session: ScannedSession,
  index: number,
  opts: {
    binding: ChannelBinding | null | undefined;
    activeSdkSessionBindings: Map<string, BoundInfo>;
    channelType: string;
    chatId: string;
    now: number;
    boundFilter: (boundInfo: BoundInfo | undefined, sdkSessionId: string) => BoundInfo | undefined;
  },
) {
  const boundInfo = opts.activeSdkSessionBindings.get(session.sdkSessionId);
  const boundToActiveSession = opts.boundFilter(boundInfo, session.sdkSessionId);
  return {
    index: index + 1,
    date: formatSessionDate(session.mtime),
    cwd: shortPath(session.cwd),
    size: formatSize(session.size),
    preview: session.preview,
    transcript: readSessionTranscriptPreview(session, 4),
    isCurrent: opts.binding?.sdkSessionId === session.sdkSessionId,
    boundToActiveSession,
    isStale: (opts.now - session.mtime) > SESSION_STALE_THRESHOLD_MS,
  };
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
}

import type { BaseChannelAdapter } from '../../channels/base.js';

/**
 * Builder for home screen payload data.
 * Extracted from CommandRouter for better separation of concerns.
 */
export class HomePayloadBuilder {
  constructor(private deps: HomePayloadBuilderDeps) {}

  async build(channelType: string, chatId: string): Promise<HomeData> {
    const { store, state, workspace, sdkEngine, permissions, activeControls, getAdapters, defaultWorkdir } = this.deps;
    const binding = await store.getBinding(channelType, chatId);
    const currentCwd = binding?.cwd || defaultWorkdir;
    const chatKey = state.stateKey(channelType, chatId);
    const now = Date.now();

    // Scan recent sessions (current workspace) and all sessions (global)
    const recentSessions = scanClaudeSessions(10, currentCwd);
    const allSessions = scanClaudeSessions(10, undefined);

    // Get all bindings to check which sdkSessions are bound to active bridge sessions
    const allBindings = await store.listBindings();

    // Build map: sdkSessionId -> binding that owns it (if active)
    const activeSdkSessionBindings = new Map<string, BoundInfo>();
    for (const b of allBindings) {
      if (b.sdkSessionId) {
        const bChatKey = state.stateKey(b.channelType, b.chatId);
        const isActive = activeControls.has(bChatKey);
        activeSdkSessionBindings.set(b.sdkSessionId, {
          channelType: b.channelType,
          chatId: b.chatId,
          isActive,
        });
      }
    }

    const permStatus = permissions.getPermissionStatus(chatKey, binding?.sessionId);
    const activeChannels = Array.from(getAdapters().keys());
    const workspaceBinding = workspace.getBinding(channelType, chatId);
    const projectName = binding?.projectName;
    const lastActiveTime = state.getLastActiveTime(channelType, chatId);
    const currentSessionKey = binding?.sessionId
      ? sdkEngine?.getSessionKeyForBinding?.(channelType, chatId, binding.sessionId)
      : sdkEngine?.getActiveSessionKey(channelType, chatId);
    const queueInfo = currentSessionKey ? sdkEngine?.getQueueInfo(currentSessionKey) : undefined;
    const sessionStale = currentSessionKey ? sdkEngine?.isSessionStale(currentSessionKey) ?? false : false;

    // Current bridge session info
    const currentBridgeSession = binding ? {
      sessionId: binding.sessionId,
      sdkSessionId: binding.sdkSessionId,
      cwd: shortPath(binding.cwd || currentCwd),
      isActive: activeControls.has(chatKey),
      queueDepth: queueInfo?.depth,
      lastActiveAt: lastActiveTime ? formatRelativeTime(lastActiveTime) : undefined,
    } : undefined;

    // Managed sessions in SDKEngine for this chat
    const rawManagedSessions = sdkEngine?.getSessionsForChat(channelType, chatId) ?? [];
    const managedSessions = rawManagedSessions.map(s => ({ ...s, workdir: shortPath(s.workdir) }));

    // Ensure current binding always appears in managedSessions (it may not be in registry yet if no query was sent)
    if (binding && !managedSessions.some(s => s.bindingSessionId === binding.sessionId)) {
      managedSessions.unshift({
        sessionKey: `${channelType}:${chatId}:${binding.sessionId}`,
        bindingSessionId: binding.sessionId,
        workdir: shortPath(binding.cwd || currentCwd),
        sdkSessionId: binding.sdkSessionId,
        isAlive: false,
        isTurnActive: false,
        lastActiveAt: Date.now(),
        isCurrent: true,
        queueDepth: 0,
      });
    }

    return {
      workspace: {
        cwd: shortPath(currentCwd),
        binding: workspaceBinding ? shortPath(workspaceBinding) : undefined,
        project: projectName,
      },
      task: {
        active: activeControls.has(chatKey),
      },
      session: {
        current: currentBridgeSession,
        managed: managedSessions.length > 0 ? managedSessions : undefined,
        recent: recentSessions.map((session, index) =>
          mapScannedSession(session, index, {
            binding, activeSdkSessionBindings, channelType, chatId, now,
            boundFilter: (bi) =>
              (bi && !bi.isActive && bi.channelType === channelType && bi.chatId === chatId)
                ? undefined
                : bi?.isActive ? bi : undefined,
          }),
        ),
        all: allSessions.map((session, index) =>
          mapScannedSession(session, index, {
            binding, activeSdkSessionBindings, channelType, chatId, now,
            boundFilter: (bi, sdkSessionId) =>
              bi?.isActive
                && !(bi.channelType === channelType && bi.chatId === chatId && binding?.sdkSessionId === sdkSessionId)
              ? bi : undefined,
          }),
        ),
        stale: sessionStale,
        lastActiveAt: lastActiveTime ? formatRelativeTime(lastActiveTime) : undefined,
      },
      permission: {
        mode: state.getPermMode(channelType, chatId, binding?.sessionId),
        pending: permStatus.pending,
        lastDecision: permStatus.lastDecision,
        whitelistCount: permStatus.rememberedTools + permStatus.rememberedBashPrefixes,
      },
      bridge: {
        healthy: activeChannels.length > 0,
        channels: activeChannels,
        queueInfo,
      },
      help: {
        entries: [],  // Will be populated by CommandRouter if needed
        recentSummary: recentSessions[0]?.preview,
      },
    };
  }
}