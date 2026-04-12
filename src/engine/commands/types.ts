import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import type { BridgeStore } from '../../store/interface.js';
import type { LLMProvider, QueryControls } from '../../providers/base.js';
import type { SessionStateManager } from '../state/session-state.js';
import type { WorkspaceStateManager } from '../state/workspace-state.js';
import type { ChannelRouter } from '../utils/router.js';
import type { SDKEngine } from '../sdk/engine.js';
import type { PermissionCoordinator } from '../coordinators/permission.js';

/** Context passed to each command handler */
export interface CommandContext {
  adapter: BaseChannelAdapter;
  msg: InboundMessage;
  parts: string[];
  store: BridgeStore;
  router: ChannelRouter;
  state: SessionStateManager;
  workspace: WorkspaceStateManager;
  permissions: PermissionCoordinator;
  sdkEngine?: SDKEngine;
  llm: LLMProvider;
  activeControls: Map<string, QueryControls>;
  defaultWorkdir: string;
  defaultClaudeSettingSources: string[];
  getAdapters: () => Map<string, BaseChannelAdapter>;
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