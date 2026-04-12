// Engine module entry point - re-exports for backwards compatibility

// State management
export { SessionStateManager } from './state/session-state.js';
export { WorkspaceStateManager } from './state/workspace-state.js';
export { InteractionState } from './state/interaction-state.js';
export { SessionStaleError } from './state/session-stale-error.js';

// Utilities
export { ChannelRouter } from './utils/router.js';
export { ConversationEngine } from './utils/conversation.js';
export { CostTracker } from './utils/cost-tracker.js';
export { areHooksPaused, pauseHooks, resumeHooks } from './utils/hooks-state.js';
export { checkForUpdates, getCurrentVersion, isVersionNotified, markVersionNotified } from './utils/version-checker.js';

// SDK
export { SDKEngine } from './sdk/engine.js';
export { SDKPermissionHandler } from './sdk/permission-handler.js';
export { SDKAskQuestionHandler } from './sdk/ask-question-handler.js';

// Coordinators
export { BridgeManager } from './coordinators/bridge-manager.js';
export { PermissionCoordinator } from './coordinators/permission.js';
export { QueryOrchestrator } from './coordinators/query.js';
export { IngressCoordinator } from './coordinators/ingress.js';
export { MessageLoopCoordinator } from './coordinators/message-loop.js';

// Messages
export { MessageRenderer } from './messages/renderer.js';
export { TextDispatcher } from './messages/text-dispatcher.js';
export { handleCallbackMessage } from './messages/callback-dispatcher.js';
export { HookNotificationDispatcher } from './messages/hook-notification.js';
export * from './messages/presenter.js';
export { QueryExecutionPresenter } from './messages/query-presenter.js';
export { ProgressContentBuilder } from './messages/progress-builder.js';

// Automation
export { WebhookServer } from './automation/webhook.js';
export { CronScheduler } from './automation/cron.js';
export { isCronApiRequest, handleCronApiRequest } from './automation/cron-api.js';

// Commands (new - open-closed principle)
export { commandRegistry, CommandRegistry, registerAllCommands } from './commands/index.js';
export type { CommandHandler, CommandContext, HelpEntry } from './commands/index.js';