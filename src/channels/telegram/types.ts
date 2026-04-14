/** Telegram rendered message - uses HTML formatting */
export interface TelegramRenderedMessage {
  chatId: string;
  /** Plain text (used when html is not provided) */
  text?: string;
  /** HTML-formatted content (Telegram's native format) */
  html?: string;
  /** Inline keyboard buttons */
  buttons?: import('../../ui/types.js').Button[];
  /** Reply to a specific message */
  replyToMessageId?: string;
  /** Media attachment */
  media?: import('../../channels/types.js').MediaAttachment;
}