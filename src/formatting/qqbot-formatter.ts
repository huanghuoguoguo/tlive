/**
 * QQBot message formatter - uses markdown formatting.
 * Similar to Telegram but without HTML conversion.
 */

import { MessageFormatter, type MessageLocale } from './message-formatter.js';
import { markdownToQQBot } from '../markdown/qqbot.js';
import type { OutboundMessage } from '../channels/types.js';
import type { ProgressData } from './message-types.js';
import { truncate } from '../utils/string.js';

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

  override formatProgress(chatId: string, data: ProgressData): OutboundMessage {
    if (data.renderedText?.trim()) {
      return this.createMessage(chatId, data.renderedText);
    }

    const phaseLabels = this.locale === 'zh'
      ? {
          starting: '⏳ 准备开始',
          executing: '⏳ 执行中',
          waiting_permission: '🔐 等待权限',
          completed: '✅ 已完成',
          failed: '⚠️ 已停止',
        }
      : {
          starting: '⏳ Starting',
          executing: '⏳ Running',
          waiting_permission: '🔐 Waiting for permission',
          completed: '✅ Completed',
          failed: '⚠️ Failed',
        };

    const lines = [
      phaseLabels[data.phase],
      '',
      `${this.locale === 'zh' ? '任务' : 'Task'}: ${truncate(data.taskSummary, 100)}`,
      `${this.locale === 'zh' ? '耗时' : 'Time'}: ${data.elapsedSeconds}s`,
    ];

    return this.createMessage(chatId, lines.join('\n'));
  }
}
