import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import type { SessionStateManager } from './state/session-state.js';
import type { WorkspaceStateManager } from './state/workspace-state.js';
import type { RecentProjectsManager } from './state/recent-projects.js';
import type { ChannelRouter } from '../utils/router.js';
import type { QueryControls } from '../providers/base.js';
import type { ClaudeSDKProvider } from '../providers/claude-sdk.js';
import type { SDKEngine, SessionCleanupReason } from './sdk/engine.js';
import type { ProjectsValidationResult, ClaudeSettingSource } from '../config.js';
import type { BridgeStore, ChannelBinding } from '../store/interface.js';
import type { HomeData } from '../formatting/message-types.js';
import type { RouterHelpers, CommandServices } from './commands/types.js';
import type { PermissionCoordinator } from './coordinators/permission.js';
import type { Locale } from '../i18n/index.js';
import { commandRegistry, registerAllCommands } from './commands/index.js';
import { DEFAULT_CLAUDE_SETTING_SOURCES } from '../config.js';
import { findGitRoot } from '../utils/repo.js';
import { generateSessionId } from '../utils/id.js';
import { HomePayloadBuilder } from './presenters/home-payload-builder.js';

// Register all commands on module load
registerAllCommands();

export class CommandRouter {
  private projectsConfig: ProjectsValidationResult | undefined;
  private services: CommandServices;
  private homePayloadBuilder: HomePayloadBuilder;

  constructor(
    private state: SessionStateManager,
    private workspace: WorkspaceStateManager,
    recentProjects: RecentProjectsManager,
    getAdapters: () => Map<string, BaseChannelAdapter>,
    router: ChannelRouter,
    private store: BridgeStore,
    defaultWorkdir: string,
    llm: ClaudeSDKProvider,
    activeControls: Map<string, QueryControls>,
    permissions: PermissionCoordinator,
    private defaultClaudeSettingSources: ClaudeSettingSource[] = DEFAULT_CLAUDE_SETTING_SOURCES,
    private sdkEngine?: SDKEngine,
    projectsConfig?: ProjectsValidationResult,
  ) {
    this.projectsConfig = projectsConfig;
    this.services = {
      store, router, state, workspace, recentProjects, permissions, sdkEngine, llm,
      activeControls, defaultWorkdir, defaultClaudeSettingSources, getAdapters,
    };
    this.homePayloadBuilder = new HomePayloadBuilder({
      store,
      state,
      workspace,
      sdkEngine,
      permissions,
      activeControls,
      getAdapters,
      defaultWorkdir,
    });
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

  private async buildHomePayload(channelType: string, chatId: string, locale: Locale = 'zh'): Promise<HomeData> {
    const data = await this.homePayloadBuilder.build(channelType, chatId, locale);
    // Add help entries from registry
    return {
      ...data,
      help: {
        entries: commandRegistry.getHelpEntries(),
        recentSummary: data.help?.recentSummary,
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
      const locale = typeof adapter.getLocale === 'function' ? adapter.getLocale() : 'zh';
      const ctx = {
        adapter,
        msg,
        parts,
        services: this.services,
        helpers: this.buildHelpers(),
        locale,
      };
      return handler.execute(ctx);
    }

    // Unknown command
    return false;
  }
}