/**
 * Telegram message formatter - uses HTML formatting.
 */

import { MessageFormatter, type MessageLocale } from '../../formatting/message-formatter.js';
import { markdownToTelegram } from './markdown.js';
import type { TelegramRenderedMessage } from './types.js';
import type { NotificationData, HomeData, SessionsData, ProgressData } from '../../formatting/message-types.js';
import type { Button } from '../../ui/types.js';
import { truncate } from '../../utils/string.js';

export class TelegramFormatter extends MessageFormatter<TelegramRenderedMessage> {
  constructor(locale: MessageLocale = 'en') {
    super(locale);
  }

  protected formatMarkdown(text: string): string {
    return markdownToTelegram(text);
  }

  protected supportsButtons(): boolean {
    return true;
  }

  protected createMessage(chatId: string, text: string, buttons?: Button[]): TelegramRenderedMessage {
    // Telegram prefers HTML over markdown
    const html = this.formatMarkdown(text);
    const msg: TelegramRenderedMessage = {
      chatId,
      html,
    };
    if (buttons) {
      msg.buttons = buttons;
    }
    return msg;
  }

  override formatNotification(chatId: string, data: NotificationData): TelegramRenderedMessage {
    const emojiMap = { stop: '✅', idle_prompt: '⏳', generic: '📢' };
    const emoji = emojiMap[data.type];
    const summary = data.summary ? truncate(data.summary, 3000) : undefined;

    const mdParts = [`**${emoji} ${data.title}**`];
    if (summary) mdParts.push('', summary);

    const msg: TelegramRenderedMessage = { chatId };

    if (data.terminalUrl) {
      const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/.test(data.terminalUrl);
      if (isLocalhost) {
        // Telegram URL buttons reject localhost, use inline markdown link
        mdParts.push('', `🔗 [Open Terminal](${data.terminalUrl})`);
      } else {
        // Public domain: use URL inline button
        msg.buttons = [{ label: '🔗 Open Terminal', callbackData: '_', url: data.terminalUrl }];
      }
    }

    msg.html = this.formatMarkdown(mdParts.join('\n'));
    return msg;
  }

  override formatHome(chatId: string, data: HomeData): TelegramRenderedMessage {
    const taskStatus = data.hasActiveTask
      ? (this.locale === 'zh' ? '有任务正在执行' : 'Task in progress')
      : (this.locale === 'zh' ? '无执行中任务' : 'No active task');

    const lines = [
      `🏠 **TLive**`,
      ``,
      `**Status:** ${taskStatus}`,
      `**Directory:** \`${data.cwd}\``,
    ];
    if (data.recentSummary) {
      lines.push(``, `**Recent:** ${truncate(data.recentSummary, 100)}`);
    }

    return { chatId, html: this.formatMarkdown(lines.join('\n')) };
  }

  override formatSessions(chatId: string, data: SessionsData): TelegramRenderedMessage {
    const lines = [`📋 **Sessions** ${data.filterHint}`, ''];
    for (const s of data.sessions) {
      const marker = s.isCurrent ? ' ◀' : '';
      lines.push(`${s.index}. ${s.date} · ${s.cwd} · ${s.size} · ${s.preview}${marker}`);
    }
    const footer = this.locale === 'zh' ? '\n使用 /session <n> 切换' : '\nUse /session <n> to switch';
    return { chatId, html: this.formatMarkdown(lines.join('\n') + footer) };
  }

  override formatProgress(chatId: string, data: ProgressData): TelegramRenderedMessage {
    if (data.renderedText?.trim()) {
      let text = data.renderedText;
      // Append session info on first render
      if (data.sessionInfo && (data.sessionInfo.skills?.length || data.sessionInfo.mcpServers?.length)) {
        const infoParts: string[] = [];
        if (data.sessionInfo.skills?.length) {
          infoParts.push(`Skills: ${data.sessionInfo.skills.join(', ')}`);
        }
        if (data.sessionInfo.mcpServers?.length) {
          const servers = data.sessionInfo.mcpServers.map(s => `${s.status === 'connected' ? '🟢' : '🔴'} ${s.name}`);
          infoParts.push(`MCP: ${servers.join(' · ')}`);
        }
        text = `🔌 ${infoParts.join(' | ')}\n\n${text}`;
      }
      // API retry indicator
      if (data.apiRetry) {
        text = `🔄 API retry ${data.apiRetry.attempt}/${data.apiRetry.maxRetries}${data.apiRetry.error ? ` (${data.apiRetry.error})` : ''}\n\n${text}`;
      }
      // Compaction indicator
      if (data.compacting) {
        text = `📦 Compacting context...\n\n${text}`;
      }
      const msg: TelegramRenderedMessage = { chatId, html: this.formatMarkdown(text) };
      const buttons = data.actionButtons?.length ? data.actionButtons : this.defaultProgressButtons(data.phase);
      if (buttons.length) msg.buttons = buttons;
      return msg;
    }
    const phaseLabels = {
      starting: '⏳ Starting',
      executing: '⏳ Running',
      waiting_permission: '🔐 Waiting for permission',
      completed: '✅ Completed',
      failed: '⚠️ Failed',
    };
    const label = phaseLabels[data.phase];
    const lines = [
      `${label}`,
      ``,
      `**Task:** ${truncate(data.taskSummary, 100)}`,
      `**Time:** ${data.elapsedSeconds}s`,
    ];
    const buttons = data.actionButtons?.length ? data.actionButtons : this.defaultProgressButtons(data.phase);
    const msg: TelegramRenderedMessage = { chatId, html: this.formatMarkdown(lines.join('\n')) };
    if (buttons.length) msg.buttons = buttons;
    return msg;
  }
}