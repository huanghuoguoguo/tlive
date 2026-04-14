import type { BaseChannelAdapter } from '../../channels/base.js';
import type { ChannelBinding } from '../../store/interface.js';
import type { ClaudeSettingSource } from '../../config.js';

/**
 * Minimal interface for automation components (WebhookServer, CronScheduler).
 * This interface allows automation systems to interact with the bridge
 * without depending on the full BridgeManager implementation.
 */
export interface AutomationBridge {
  /** Get adapter for a specific channel type */
  getAdapter(channelType: string): BaseChannelAdapter | undefined;

  /** Get all registered adapters */
  getAdapters(): BaseChannelAdapter[];

  /** Get the last active chatId for a channel type (for hook routing) */
  getLastChatId(channelType: string): string;

  /** Inject a prompt from automation (webhook/cron) */
  injectAutomationPrompt(options: {
    channelType: string;
    chatId: string;
    text: string;
    requestId?: string;
    messageId?: string;
    userId?: string;
    workdir?: string;
    projectName?: string;
    claudeSettingSources?: ClaudeSettingSource[];
  }): Promise<{ sessionId?: string }>;

  /** Check if there's an active session for a channel/chat */
  hasActiveSession(channelType: string, chatId: string, workdir?: string): boolean;

  /** Get binding for a channel/chat */
  getBinding(channelType: string, chatId: string): Promise<ChannelBinding | null>;

  /** Get binding by session ID */
  getBindingBySessionId(sessionId: string): Promise<ChannelBinding | null>;
}