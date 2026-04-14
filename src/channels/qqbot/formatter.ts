/**
 * QQBot message formatter - uses markdown formatting.
 * Similar to Telegram but without HTML conversion.
 */

import { MessageFormatter, type MessageLocale } from '../../formatting/message-formatter.js';
import { markdownToQQBot } from './markdown.js';
import type { QQBotRenderedMessage } from './types.js';
import type { ProgressData } from '../../formatting/message-types.js';
import { truncate } from '../../utils/string.js';

export class QQBotFormatter extends MessageFormatter<QQBotRenderedMessage> {
  constructor(locale: MessageLocale = 'zh') {
    super(locale);
  }

  protected formatMarkdown(text: string): string {
    return markdownToQQBot(text);
  }

  protected supportsButtons(): boolean {
    return false;
  }

  protected createMessage(chatId: string, text: string): QQBotRenderedMessage {
    return {
      chatId,
      text,
    };
  }

  override formatProgress(chatId: string, data: ProgressData): QQBotRenderedMessage {
    if (data.renderedText?.trim()) {
      return this.createMessage(chatId, data.renderedText);
    }

    const phaseLabels = {
      starting: this.t('progress.starting'),
      executing: this.t('progress.executing'),
      waiting_permission: this.t('progress.waitingPermission'),
      completed: this.t('progress.completed'),
      failed: this.t('progress.failed'),
    };

    const lines = [
      phaseLabels[data.phase],
      '',
      `${this.t('progress.taskLabel')}: ${truncate(data.taskSummary, 100)}`,
      `${this.t('progress.timeLabel')}: ${data.elapsedSeconds}s`,
    ];

    return this.createMessage(chatId, lines.join('\n'));
  }
}