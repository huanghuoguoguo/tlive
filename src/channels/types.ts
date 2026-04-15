export type ChannelType = 'telegram' | 'feishu' | 'qqbot';

// Import FileAttachment for use in InboundMessage
import type { FileAttachment } from './media-types.js';

export interface InboundMessage {
  channelType: ChannelType;
  chatId: string;
  userId: string;
  text: string;
  attachments?: FileAttachment[];
  callbackData?: string;
  messageId: string;
  replyToMessageId?: string;
}

// Re-export media types from separate file to avoid circular imports
export type { FileAttachment, MediaAttachment } from './media-types.js';

// --- Platform-specific rendered message types ---
// Re-exported from platforms for convenience

/** Union type for all platform-specific rendered messages */
export type RenderedMessage =
  | import('./telegram/types.js').TelegramRenderedMessage
  | import('./feishu/types.js').FeishuRenderedMessage
  | import('./qqbot/types.js').QQBotRenderedMessage;

/** Legacy type alias for backwards compatibility - will be removed */
export type OutboundMessage = RenderedMessage;

export interface SendResult {
  messageId: string;
  success: boolean;
}

export interface StreamingCardSession {
  start(initialText?: string): Promise<string>;
  update(fullText: string): Promise<void>;
  close(options?: { finalText?: string; header?: { template: string; title: string } }): Promise<void>;
  /** Current message ID (for Feishu streaming cards) */
  currentMessageId?: string;
}
