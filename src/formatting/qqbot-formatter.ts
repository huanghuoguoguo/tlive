/**
 * QQBot message formatter - uses markdown formatting.
 * Similar to Telegram but without HTML conversion.
 */

import { MessageFormatter, type MessageLocale } from './message-formatter.js';
import { markdownToQQBot } from '../markdown/qqbot.js';
import type { OutboundMessage } from '../channels/types.js';

export class QQBotFormatter extends MessageFormatter {
  constructor(locale: MessageLocale = 'zh') {
    super(locale);
  }

  protected formatMarkdown(text: string): string {
    return markdownToQQBot(text);
  }

  protected supportsButtons(): boolean {
    return false;
  }

  protected createMessage(chatId: string, text: string): OutboundMessage {
    return {
      chatId,
      text,
    };
  }
}
