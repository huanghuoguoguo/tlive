import type { BaseChannelAdapter } from '../../channels/base.js';
import type { DeliveryRoute } from '../../channels/delivery-route.js';
import type { ChannelBinding } from '../../store/interface.js';
import type {
  AutomationPromptOptions,
  AutomationPromptResult,
} from '../automation/prompt-injector.js';

export interface AutomationDeliveryTarget extends DeliveryRoute {
  cwd?: string;
  sessionKey?: string;
}

/**
 * Minimal interface for automation components such as WebhookServer.
 * This interface allows automation systems to interact with the bridge
 * without depending on the full BridgeManager implementation.
 */
export interface AutomationBridge {
  /** Get adapter for a specific channel type */
  getAdapter(channelType: string): BaseChannelAdapter | undefined;

  /** Get all registered adapters */
  getAdapters(): BaseChannelAdapter[];

  /** Get the last active chatId for a channel type. */
  getLastChatId(channelType: string): string;

  /** Resolve a per-turn file delivery token issued by the active query path. */
  resolveFileDeliveryToken?(token: string): AutomationDeliveryTarget | undefined;

  /** Inject a prompt from automation webhooks */
  injectAutomationPrompt(options: AutomationPromptOptions): Promise<AutomationPromptResult>;

  /** Check if there's an active session for a channel/chat */
  hasActiveSession(channelType: string, chatId: string, workdir?: string): boolean;

  /** Get binding for a channel/chat */
  getBinding(channelType: string, chatId: string): Promise<ChannelBinding | null>;

  /** Get binding by session ID */
  getBindingBySessionId(sessionId: string): Promise<ChannelBinding | null>;
}
