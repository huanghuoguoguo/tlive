import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import type { BridgeStore, ChannelBinding } from '../../store/interface.js';
import type { AgentProvider, QueryControls } from '../../providers/base.js';
import type { AgentProviderRegistry } from '../../providers/registry.js';
import type { SessionStateManager } from '../state/session-state.js';
import type { WorkspaceStateManager } from '../state/workspace-state.js';
import type { RecentProjectsManager } from '../state/recent-projects.js';
import type { ChannelRouter } from '../../utils/router.js';
import type { SDKEngine, SessionCleanupReason } from '../sdk/engine.js';
import type { PermissionCoordinator } from '../coordinators/permission.js';
import type { AgentSettingSource, ProjectsValidationResult } from '../../config.js';
import type { HelpCommandEntry, HomeClientEntry, HomeData } from '../../formatting/message-types.js';
import type { Locale } from '../../i18n/index.js';
import type { HelpCategoryId } from './help-categories.js';
import type { TopicSessionManager } from '../state/topic-sessions.js';
import type { ConversationSurface } from '../conversations/surface-policy.js';

/** Router helpers - encapsulates complex internal operations */
export interface RouterHelpers {
  /** Reset session context (cleanup + rebind) */
  resetSessionContext(
    channelType: string,
    chatId: string,
    reason: SessionCleanupReason,
    opts?: {
      previousCwd?: string;
      clearProject?: boolean;
      clearLastActive?: boolean;
      binding?: ChannelBinding | null;
    },
  ): Promise<{ hadActiveSession: boolean; binding: ChannelBinding | null }>;
  /** Build home screen payload */
  buildHomePayload(channelType: string, chatId: string, locale?: Locale): Promise<HomeData>;
  /** Update workspace binding from path (find git root) */
  updateWorkspaceBindingFromPath(channelType: string, chatId: string, cwd: string): void;
  /** Get settings preset name from sources */
  getSettingsPreset(sources: AgentSettingSource[]): string;
  /** Cached projects config */
  projectsConfig: ProjectsValidationResult | null;
  /** Default provider setting sources */
  defaultAgentSettingSources: AgentSettingSource[];
}

/** Stable service dependencies shared across all commands */
export interface CommandServices {
  store: BridgeStore;
  router: ChannelRouter;
  state: SessionStateManager;
  workspace: WorkspaceStateManager;
  recentProjects: RecentProjectsManager;
  permissions: PermissionCoordinator;
  sdkEngine?: SDKEngine;
  llm: AgentProvider;
  providers: AgentProviderRegistry;
  activeControls: Map<string, QueryControls>;
  defaultWorkdir: string;
  defaultAgentSettingSources: AgentSettingSource[];
  getAdapters: () => Map<string, BaseChannelAdapter>;
  topicSessions?: TopicSessionManager;
  getExecutionClients?: () => HomeClientEntry[];
}

/** Context passed to each command handler */
export interface CommandContext {
  adapter: BaseChannelAdapter;
  msg: InboundMessage;
  /** Logical state/session scope. For Feishu topics this is chat_id + thread_id. */
  scopeId: string;
  /** Product surface for command rules: main-chat workbench or topic conversation. */
  surface: ConversationSurface;
  parts: string[];
  services: CommandServices;
  /** Router helpers for complex operations */
  helpers: RouterHelpers;
  /** Locale for i18n (derived from adapter or default 'zh') */
  locale: Locale;
}

/** Command handler interface - implements open-closed principle */
export interface CommandHandler {
  /** Command name (e.g., '/status', '/new') */
  readonly name: string;
  /** Whether this is a quick command (doesn't block message loop) */
  readonly quick: boolean;
  /** Help category used by /home and /help. */
  readonly helpCategory: HelpCategoryId;
  /** Short description for /home summary */
  readonly description?: string;
  /** Detailed description for /help (Chinese) */
  readonly helpDesc?: string;
  /** Example usage */
  readonly helpExample?: string;
  /** Execute the command */
  execute(ctx: CommandContext): Promise<boolean>;
}

/** Help command entry for display */
export type HelpEntry = HelpCommandEntry;
