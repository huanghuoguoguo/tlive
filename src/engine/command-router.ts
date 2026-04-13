import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import type { SessionStateManager } from './state/session-state.js';
import type { WorkspaceStateManager } from './state/workspace-state.js';
import type { ChannelRouter } from './utils/router.js';
import type { LLMProvider, QueryControls } from '../providers/base.js';
import type { SDKEngine, SessionCleanupReason } from './sdk/engine.js';
import type { ProjectsValidationResult, ClaudeSettingSource } from '../config.js';
import type { BridgeStore, ChannelBinding } from '../store/interface.js';
import type { HomeData } from '../formatting/message-types.js';
import type { RouterHelpers } from './commands/types.js';
import type { PermissionCoordinator } from './coordinators/permission.js';
import { commandRegistry, registerAllCommands } from './commands/index.js';
import { DEFAULT_CLAUDE_SETTING_SOURCES } from '../config.js';
import { scanClaudeSessions } from '../session-scanner.js';
import { shortPath } from '../utils/path.js';
import { findGitRoot } from '../utils/repo.js';
import { generateSessionId } from '../utils/id.js';

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

export class CommandRouter {
  private projectsConfig: ProjectsValidationResult | undefined;

  constructor(
    private state: SessionStateManager,
    private workspace: WorkspaceStateManager,
    private getAdapters: () => Map<string, BaseChannelAdapter>,
    private router: ChannelRouter,
    private store: BridgeStore,
    private defaultWorkdir: string,
    private llm: LLMProvider,
    private activeControls: Map<string, QueryControls>,
    private permissions: PermissionCoordinator,
    private defaultClaudeSettingSources: ClaudeSettingSource[] = DEFAULT_CLAUDE_SETTING_SOURCES,
    private sdkEngine?: SDKEngine,
    projectsConfig?: ProjectsValidationResult,
  ) {
    this.projectsConfig = projectsConfig;
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
    const recentSessions = scanClaudeSessions(3, currentCwd);

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

    return {
      cwd: shortPath(currentCwd),
      workspaceBinding: workspaceBinding ? shortPath(workspaceBinding) : undefined,
      currentProject: projectName,
      hasActiveTask: this.activeControls.has(chatKey),
      permissionMode: this.state.getPermMode(channelType, chatId),
      recentSummary: recentSessions[0]?.preview,
      recentSessions: recentSessions.map((session, index) => ({
        index: index + 1,
        date: formatSessionDate(session.mtime),
        preview: session.preview,
        isCurrent: binding?.sdkSessionId === session.sdkSessionId,
      })),
      pendingPermission: permStatus.pending,
      lastPermissionDecision: permStatus.lastDecision,
      sessionWhitelistCount: permStatus.rememberedTools + permStatus.rememberedBashPrefixes,
      bridgeHealthy: activeChannels.length > 0,
      activeChannels,
      lastActiveAt: lastActiveTime ? formatRelativeTime(lastActiveTime) : undefined,
      queueInfo,
      sessionStale,
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
        store: this.store,
        router: this.router,
        state: this.state,
        workspace: this.workspace,
        permissions: this.permissions,
        sdkEngine: this.sdkEngine,
        llm: this.llm,
        activeControls: this.activeControls,
        defaultWorkdir: this.defaultWorkdir,
        defaultClaudeSettingSources: this.defaultClaudeSettingSources,
        getAdapters: this.getAdapters,
        helpers: this.buildHelpers(),
      };
      return handler.execute(ctx);
    }

    // Unknown command
    return false;
  }
}
