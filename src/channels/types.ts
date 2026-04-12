export type ChannelType = 'telegram' | 'feishu' | 'qqbot';

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

export interface FileAttachment {
  type: 'image' | 'file';
  name: string;
  mimeType: string;
  base64Data: string;
  /** URL to fetch the file content (used when base64Data is empty) */
  url?: string;
}

/** Media attachment for outbound messages */
export interface MediaAttachment {
  type: 'image' | 'file';
  /** URL to fetch, or data URI (data:image/png;base64,...) */
  url?: string;
  /** Raw buffer data */
  buffer?: Buffer;
  /** Filename for file attachments */
  filename?: string;
  /** MIME type */
  mimeType?: string;
}

// --- Platform-specific rendered message types ---
// Re-exported from platforms for convenience

/** Union type for all platform-specific rendered messages */
export type RenderedMessage =
  | import('../platforms/telegram/types.js').TelegramRenderedMessage
  | import('../platforms/feishu/types.js').FeishuRenderedMessage
  | import('../platforms/qqbot/types.js').QQBotRenderedMessage;

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
