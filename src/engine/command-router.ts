import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import type { SessionStateManager } from './state/session-state.js';
import type { WorkspaceStateManager } from './state/workspace-state.js';
import type { RecentProjectsManager } from './state/recent-projects.js';
import type { ChannelRouter } from '../utils/router.js';
import type { AgentProvider, QueryControls } from '../providers/base.js';
import type { AgentProviderRegistry } from '../providers/registry.js';
import type { SDKEngine, SessionCleanupReason } from './sdk/engine.js';
import type { ProjectsValidationResult, AgentSettingSource } from '../config.js';
import type { BridgeStore, ChannelBinding } from '../store/interface.js';
import type {
  HomeClientEntry,
  HomeData,
  TopicCommandPaletteData,
} from '../formatting/message-types.js';
import type { RouterHelpers, CommandServices } from './commands/types.js';
import type { PermissionCoordinator } from './coordinators/permission.js';
import type { Locale } from '../i18n/index.js';
import type { TopicSessionManager } from './state/topic-sessions.js';
import { commandRegistry, registerAllCommands } from './commands/index.js';
import { isPublicTextCommand } from './commands/slash-policy.js';
import type { ActionCallback } from '../core/callbacks.js';
import { DEFAULT_AGENT_SETTING_SOURCES } from '../config.js';
import { findGitRoot } from '../utils/repo.js';
import { generateSessionId } from '../core/id.js';
import { HomePayloadBuilder } from './presenters/home-payload-builder.js';
import { conversationScopeId } from '../channels/conversation-context.js';
import { commandRejectionForSurface, conversationSurface } from './conversations/surface-policy.js';
import { withInboundReplyContext } from '../channels/reply-context.js';
import { t } from '../i18n/index.js';

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
    llm: AgentProvider,
    providers: AgentProviderRegistry,
    activeControls: Map<string, QueryControls>,
    permissions: PermissionCoordinator,
    private defaultAgentSettingSources: AgentSettingSource[] = DEFAULT_AGENT_SETTING_SOURCES,
    private sdkEngine?: SDKEngine,
    projectsConfig?: ProjectsValidationResult,
    topicSessions?: TopicSessionManager,
    getExecutionClients?: () => HomeClientEntry[],
  ) {
    this.projectsConfig = projectsConfig;
    this.services = {
      store,
      router,
      state,
      workspace,
      recentProjects,
      permissions,
      sdkEngine,
      llm,
      providers,
      activeControls,
      defaultWorkdir,
      defaultAgentSettingSources,
      getAdapters,
      topicSessions,
      getExecutionClients,
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
      providers,
      topicSessions,
      getExecutionClients,
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
      defaultAgentSettingSources: this.defaultAgentSettingSources,
    };
  }

  private getSettingsPreset(sources: AgentSettingSource[]): string {
    if (sources.length === 0) return 'isolated';
    if (sources.length === 1 && sources[0] === 'user') return 'user';
    if (
      sources.length === 3 &&
      sources[0] === 'user' &&
      sources[1] === 'project' &&
      sources[2] === 'local'
    ) {
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
    const binding = opts.binding ?? (await this.store.getBinding(channelType, chatId));
    const hadActiveSession = binding
      ? (this.sdkEngine?.hasSessionContext?.(channelType, chatId, binding.sessionId) ?? false) ||
        !!binding.sdkSessionId
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

  private async buildHomePayload(
    channelType: string,
    chatId: string,
    locale: Locale = 'zh',
  ): Promise<HomeData> {
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

  private async executeCommand(
    adapter: BaseChannelAdapter,
    msg: InboundMessage,
    parts: string[],
    opts: { requirePublicTextCommand: boolean },
  ): Promise<boolean> {
    const cmd = parts[0].toLowerCase();
    const scopeId = conversationScopeId(msg);
    const surface = conversationSurface({ threadId: msg.threadId, scopeId });
    const locale = adapter.getLocale();

    const handler = commandRegistry.get(cmd);
    if (handler) {
      if (opts.requirePublicTextCommand && !isPublicTextCommand(handler.name)) {
        await adapter.send(
          withInboundReplyContext(
            {
              chatId: msg.chatId,
              text: t('router.workbenchCommandHint').replace('{cmd}', handler.name),
            },
            msg,
          ),
        );
        return true;
      }
      const rejection = commandRejectionForSurface(cmd, surface, locale);
      if (rejection) {
        await adapter.send(withInboundReplyContext({ chatId: msg.chatId, text: rejection }, msg));
        return true;
      }

      const ctx = {
        adapter,
        msg,
        scopeId,
        surface,
        parts,
        services: this.services,
        helpers: this.buildHelpers(),
        locale,
      };
      return handler.execute(ctx);
    }

    if (!opts.requirePublicTextCommand) {
      await adapter.send(
        withInboundReplyContext(
          { chatId: msg.chatId, text: t('router.unknownCommand').replace('{cmd}', cmd) },
          msg,
        ),
      );
      return true;
    }

    // Unknown command
    return false;
  }

  /** Handle user text slash commands. */
  async handle(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    const scopeId = conversationScopeId(msg);
    const surface = conversationSurface({ threadId: msg.threadId, scopeId });

    if (!msg.internalCommand && msg.text.trim() === '/' && surface === 'topic') {
      await this.sendTopicCommandPalette(adapter, msg, scopeId);
      return true;
    }

    return this.executeCommand(adapter, msg, msg.text.split(' '), {
      requirePublicTextCommand: !msg.internalCommand,
    });
  }

  /** Handle typed card/workbench actions without replaying fake slash messages. */
  async handleAction(
    adapter: BaseChannelAdapter,
    msg: InboundMessage,
    action: ActionCallback,
  ): Promise<boolean> {
    return this.executeCommand(adapter, msg, [`/${action.name}`, ...action.args], {
      requirePublicTextCommand: false,
    });
  }

  private async sendTopicCommandPalette(
    adapter: BaseChannelAdapter,
    msg: InboundMessage,
    scopeId: string,
  ): Promise<void> {
    const binding = await this.store.getBinding(msg.channelType, scopeId);
    const providerKind = binding?.provider ?? this.services.providers.defaultProviderKind;
    const provider =
      this.services.providers.get(providerKind) ?? this.services.providers.defaultProvider;
    const descriptor = this.services.providers.descriptor(provider.kind);
    const sessionKey = this.state.stateKey(msg.channelType, scopeId);
    const data: TopicCommandPaletteData = {
      provider: provider.kind,
      providerDisplayName: descriptor?.displayName ?? provider.displayName,
      cwd: binding?.cwd ?? this.services.defaultWorkdir,
      sdkSessionId: binding?.sdkSessionId,
      isActive: this.services.activeControls.has(sessionKey),
      permissionMode: this.state.getPermMode(msg.channelType, scopeId, binding?.sessionId),
      route: {
        scopeId,
        threadId: msg.threadId,
        replyInThread: msg.replyInThread ?? !!msg.threadId,
      },
      capabilities: {
        runtimeMode: provider.capabilities.runtimeMode,
        nativeSteer: provider.capabilities.nativeSteer,
        nativeQueue: provider.capabilities.nativeQueue,
        interactivePermissions: provider.capabilities.interactivePermissions,
        sessionResume: provider.capabilities.sessionResume,
        imageInputs: provider.capabilities.imageInputs,
      },
    };
    const outMsg = adapter.format({ type: 'topicCommandPalette', chatId: msg.chatId, data });
    await adapter.send(withInboundReplyContext(outMsg, msg));
  }
}
