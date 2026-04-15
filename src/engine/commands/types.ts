import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import type { BridgeStore, ChannelBinding } from '../../store/interface.js';
import type { QueryControls } from '../../providers/base.js';
import type { ClaudeSDKProvider } from '../../providers/claude-sdk.js';
import type { SessionStateManager } from '../state/session-state.js';
import type { WorkspaceStateManager } from '../state/workspace-state.js';
import type { ChannelRouter } from '../../utils/router.js';
import type { SDKEngine, SessionCleanupReason } from '../sdk/engine.js';
import type { PermissionCoordinator } from '../coordinators/permission.js';
import type { ClaudeSettingSource, ProjectsValidationResult } from '../../config.js';
import type { HomeData } from '../../formatting/message-types.js';
import type { Locale } from '../../i18n/index.js';

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
  getSettingsPreset(sources: ClaudeSettingSource[]): string;
  /** Cached projects config */
  projectsConfig: ProjectsValidationResult | null;
  /** Default Claude setting sources */
  defaultClaudeSettingSources: ClaudeSettingSource[];
}

/** Stable service dependencies shared across all commands */
export interface CommandServices {
  store: BridgeStore;
  router: ChannelRouter;
  state: SessionStateManager;
  workspace: WorkspaceStateManager;
  permissions: PermissionCoordinator;
  sdkEngine?: SDKEngine;
  llm: ClaudeSDKProvider;
  activeControls: Map<string, QueryControls>;
  defaultWorkdir: string;
  defaultClaudeSettingSources: ClaudeSettingSource[];
  getAdapters: () => Map<string, BaseChannelAdapter>;
}

/** Context passed to each command handler */
export interface CommandContext {
  adapter: BaseChannelAdapter;
  msg: InboundMessage;
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
  /** Description for /help output */
  readonly description?: string;
  /** Execute the command */
  execute(ctx: CommandContext): Promise<boolean>;
}

/** Help command entry for display */
export interface HelpEntry {
  cmd: string;
  desc: string;
}