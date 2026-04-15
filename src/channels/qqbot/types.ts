/** QQBot rendered message - uses markdown formatting */
export interface QQBotRenderedMessage {
  chatId: string;
  /** Markdown text content */
  text?: string;
  /** HTML content (converted to QQBot markdown via markdownToQQBot) */
  html?: string;
  /** Keyboard buttons (QQBot supports buttons via keyboard) */
  buttons?: import('../../ui/types.js').Button[];
  /** Media attachment */
  media?: import('../media-types.js').MediaAttachment;
}