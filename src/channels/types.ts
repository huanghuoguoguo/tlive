export const FEISHU_CHANNEL = 'feishu' as const;
export type ChannelType = typeof FEISHU_CHANNEL;

// Import FileAttachment for use in InboundMessage
import type { FileAttachment } from './media-types.js';

export interface InboundMessage {
  channelType: ChannelType;
  /** Real platform chat id used for sending messages. */
  chatId: string;
  /** Logical chat/session scope. Defaults to chatId when omitted. */
  scopeId?: string;
  /** Platform topic/thread id, when the inbound message belongs to one. */
  threadId?: string;
  /** Root message id for the platform topic/thread, when available. */
  threadRootMessageId?: string;
  /** Parent message id for the platform topic/thread, when available. */
  threadParentMessageId?: string;
  /** Whether replies should be posted back into the platform topic/thread. */
  replyInThread?: boolean;
  userId: string;
  text: string;
  attachments?: FileAttachment[];
  callbackData?: string;
  messageId: string;
  /** Platform message id to reply to when sending a response. */
  replyTargetMessageId?: string;
  /** Message id whose progress bubble maps back to a TLive session. */
  replyToMessageId?: string;
}

// Re-export media types from separate file to avoid circular imports
export type { FileAttachment, MediaAttachment } from './media-types.js';

// --- Platform-specific rendered message types ---
// Re-exported from platforms for convenience

/** Union type for all platform-specific rendered messages */
export type RenderedMessage = import('./feishu/types.js').FeishuRenderedMessage;

/** Legacy type alias for backwards compatibility - will be removed */
export type OutboundMessage = RenderedMessage;

export interface SendResult {
  messageId: string;
  success: boolean;
}

export interface ThreadStartResult {
  threadId: string;
  /** Root message that owns the platform topic title, when distinct. */
  rootMessageId?: string;
  /** First bot reply inside the topic. */
  messageId: string;
}

export interface StreamingCardSession {
  start(initialText?: string): Promise<string>;
  update(fullText: string): Promise<void>;
  close(options?: { finalText?: string; header?: { template: string; title: string } }): Promise<void>;
  /** Current message ID (for Feishu streaming cards) */
  currentMessageId?: string;
}
