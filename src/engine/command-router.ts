import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import type { SessionStateManager } from './state/session-state.js';
import type { WorkspaceStateManager } from './state/workspace-state.js';
import type { ChannelRouter } from './utils/router.js';
import type { QueryControls } from '../providers/base.js';
import type { ClaudeSDKProvider } from '../providers/claude-sdk.js';
import type { SDKEngine, SessionCleanupReason } from './sdk/engine.js';
import type { ProjectsValidationResult, ClaudeSettingSource } from '../config.js';
import type { BridgeStore, ChannelBinding } from '../store/interface.js';
import type { HomeData } from '../formatting/message-types.js';
import type { RouterHelpers, CommandServices } from './commands/types.js';
import type { PermissionCoordinator } from './coordinators/permission.js';
import type { ScannedSession } from '../providers/session-scanner.js';
import { commandRegistry, registerAllCommands } from './commands/index.js';
import { DEFAULT_CLAUDE_SETTING_SOURCES } from '../config.js';
import { scanClaudeSessions, readSessionTranscriptPreview } from '../providers/session-scanner.js';
import { shortPath } from '../utils/path.js';
import { findGitRoot } from '../utils/repo.js';
import { generateSessionId } from '../utils/id.js';
import { SESSION_STALE_THRESHOLD_MS } from '../utils/constants.js';
import { formatSize } from './utils/session-format.js';

// Register all commands on module load
registerAllCommands();

function formatSessionDate(mtime: number): string {
  return new Date(mtime).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  if (diffHour < 24) return `${diffHour}小时前`;
  if (diffDay < 7) return `${diffDay}天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

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

export class CommandRouter {
  private projectsConfig: ProjectsValidationResult | undefined;
  private services: CommandServices;

  constructor(
    private state: SessionStateManager,
    private workspace: WorkspaceStateManager,
    private getAdapters: () => Map<string, BaseChannelAdapter>,
    router: ChannelRouter,
    private store: BridgeStore,
    private defaultWorkdir: string,
    llm: ClaudeSDKProvider,
    private activeControls: Map<string, QueryControls>,
    private permissions: PermissionCoordinator,
    private defaultClaudeSettingSources: ClaudeSettingSource[] = DEFAULT_CLAUDE_SETTING_SOURCES,
    private sdkEngine?: SDKEngine,
    projectsConfig?: ProjectsValidationResult,
  ) {
    this.projectsConfig = projectsConfig;
    this.services = {
      store, router, state, workspace, permissions, sdkEngine, llm,
      activeControls, defaultWorkdir, defaultClaudeSettingSources, getAdapters,
    };
  }

  /** Build RouterHelpers implementation for command context */
  private buildHelpers(): RouterHelpers {
    return {
      resetSessionContext: this.resetSessionContext.bind(this),
      buildHomePayload: this.buildHomePayload.bind(this),
      updateWorkspaceBindingFromPath: this.updateWorkspaceBindingFromPath.bind(this),
      getSettingsPreset: this.getSettingsPreset.bind(this),
      projectsConfig: this.projectsConfig ?? null,
      defaultClaudeSettingSources: this.defaultClaudeSettingSources,
    };
  }

  private getSettingsPreset(sources: ClaudeSettingSource[]): string {
    if (sources.length === 0) return 'isolated';
    if (sources.length === 1 && sources[0] === 'user') return 'user';
    if (sources.length === 3 && sources[0] === 'user' && sources[1] === 'project' && sources[2] === 'local') {
      return 'full';
    }
    return sources.join(',');
  }

  private updateWorkspaceBindingFromPath(channelType: string, chatId: string, cwd: string): void {
    const gitRoot = findGitRoot(cwd);
    if (gitRoot) {
      this.workspace.setBinding(channelType, chatId, gitRoot);
      return;
    }
    this.workspace.clearBinding(channelType, chatId);
  }

  private async resetSessionContext(
    channelType: string,
    chatId: string,
    _reason: SessionCleanupReason,
    opts: {
      previousCwd?: string;
      clearProject?: boolean;
      clearLastActive?: boolean;
      binding?: ChannelBinding | null;
    } = {},
  ): Promise<{ hadActiveSession: boolean; binding: ChannelBinding | null }> {
    const binding = opts.binding ?? await this.store.getBinding(channelType, chatId);
    const hadActiveSession = binding
      ? (this.sdkEngine?.hasSessionContext?.(channelType, chatId, binding.sessionId) ?? false) || !!binding.sdkSessionId
      : false;

    if (binding) {
      binding.sessionId = generateSessionId();
      binding.sdkSessionId = undefined;
      if (opts.clearProject) {
        binding.projectName = undefined;
      }
      await this.store.saveBinding(binding);
    }

    if (opts.clearLastActive) {
      this.state.clearLastActive(channelType, chatId);
    }

    return { hadActiveSession, binding };
  }

  private async buildHomePayload(channelType: string, chatId: string): Promise<HomeData> {
    const binding = await this.store.getBinding(channelType, chatId);
    const currentCwd = binding?.cwd || this.defaultWorkdir;
    const chatKey = this.state.stateKey(channelType, chatId);
    const now = Date.now();

    // Scan recent sessions (current workspace) and all sessions (global)
    const recentSessions = scanClaudeSessions(10, currentCwd);
    const allSessions = scanClaudeSessions(10, undefined);

    // Get all bindings to check which sdkSessions are bound to active bridge sessions
    const allBindings = await this.store.listBindings();

    // Build map: sdkSessionId -> binding that owns it (if active)
    const activeSdkSessionBindings = new Map<string, { channelType: string; chatId: string; isActive: boolean }>();
    for (const b of allBindings) {
      if (b.sdkSessionId) {
        const bChatKey = this.state.stateKey(b.channelType, b.chatId);
        const isActive = this.activeControls.has(bChatKey);
        activeSdkSessionBindings.set(b.sdkSessionId, {
          channelType: b.channelType,
          chatId: b.chatId,
          isActive,
        });
      }
    }

    const permStatus = this.permissions.getPermissionStatus(chatKey, binding?.sessionId);
    const activeChannels = Array.from(this.getAdapters().keys());
    const workspaceBinding = this.workspace.getBinding(channelType, chatId);
    const projectName = binding?.projectName;
    const lastActiveTime = this.state.getLastActiveTime(channelType, chatId);
    const currentSessionKey = binding?.sessionId
      ? this.sdkEngine?.getSessionKeyForBinding?.(channelType, chatId, binding.sessionId)
      : this.sdkEngine?.getActiveSessionKey(channelType, chatId);
    const queueInfo = currentSessionKey ? this.sdkEngine?.getQueueInfo(currentSessionKey) : undefined;
    const sessionStale = currentSessionKey ? this.sdkEngine?.isSessionStale(currentSessionKey) ?? false : false;

    // Current bridge session info
    const currentBridgeSession = binding ? {
      sessionId: binding.sessionId,
      sdkSessionId: binding.sdkSessionId,
      cwd: shortPath(binding.cwd || currentCwd),
      isActive: this.activeControls.has(chatKey),
      queueDepth: queueInfo?.depth,
      lastActiveAt: lastActiveTime ? formatRelativeTime(lastActiveTime) : undefined,
    } : undefined;

    // Managed sessions in SDKEngine for this chat
    const rawManagedSessions = this.sdkEngine?.getSessionsForChat(channelType, chatId) ?? [];
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
        active: this.activeControls.has(chatKey),
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
        mode: this.state.getPermMode(channelType, chatId, binding?.sessionId),
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
        entries: commandRegistry.getHelpEntries(),
        recentSummary: recentSessions[0]?.preview,
      },
    };
  }

  /** Handle command message using registry dispatch */
  async handle(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    const parts = msg.text.split(' ');
    const cmd = parts[0].toLowerCase();

    // Try registry dispatch
    const handler = commandRegistry.get(cmd);
    if (handler) {
      const ctx = {
        adapter,
        msg,
        parts,
        services: this.services,
        helpers: this.buildHelpers(),
      };
      return handler.execute(ctx);
    }

    // Unknown command
    return false;
  }
}
