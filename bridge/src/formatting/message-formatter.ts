/**
 * Base message formatter with platform-aware formatting.
 * Adapters can override specific methods for custom rendering.
 */

import type { OutboundMessage, Button } from '../channels/types.js';
import type {
  StatusData,
  PermissionData,
  QuestionData,
  NotificationData,
  HomeData,
  SessionsData,
  SessionDetailData,
  HelpData,
  NewSessionData,
  ErrorData,
  ProgressData,
} from './message-types.js';
import { truncate } from '../utils/string.js';
import { escapeHtml } from './escape.js';

/** Language preference for messages */
export type MessageLocale = 'en' | 'zh';

export abstract class MessageFormatter {
  constructor(protected locale: MessageLocale = 'en') {}

  // --- Abstract methods that subclasses must implement ---

  /** Format markdown content for this platform (e.g., HTML for Telegram) */
  protected abstract formatMarkdown(text: string): string;

  /** Check if platform supports native buttons */
  protected abstract supportsButtons(): boolean;

  // --- Public formatting methods ---

  formatStatus(chatId: string, data: StatusData): OutboundMessage {
    const status = data.healthy ? '🟢 running' : '🔴 disconnected';
    const channelList = data.channels.join(', ') || 'none';
    const lines = [
      `**TLive Status**`,
      ``,
      `State: ${status}`,
      `Channels: ${channelList}`,
    ];
    if (data.cwd) lines.push(`Directory: \`${data.cwd}\``);
    if (data.sessionId) lines.push(`Session: #${data.sessionId.slice(-6)}`);

    return this.createMessage(chatId, lines.join('\n'));
  }

  formatPermission(chatId: string, data: PermissionData): OutboundMessage {
    const input = truncate(data.toolInput, 300);
    const expires = data.expiresInMinutes ?? 5;
    const buttons: Button[] = [
      { label: '✅ Yes', callbackData: `perm:allow:${data.permissionId}`, style: 'primary' },
      { label: '❌ No', callbackData: `perm:deny:${data.permissionId}`, style: 'danger' },
    ];

    const lines = [
      `🔐 **Permission Required**`,
      ``,
      `**Tool:** \`${data.toolName}\``,
      '```',
      input,
      '```',
      ``,
      `⏱ Expires in ${expires} minutes`,
    ];
    if (data.terminalUrl) {
      lines.push(`🔗 [Open Terminal](${data.terminalUrl})`);
    }
    lines.push('', `💬 Or reply **allow** / **deny**`);

    const msg = this.createMessage(chatId, lines.join('\n'), buttons);
    return msg;
  }

  formatQuestion(chatId: string, data: QuestionData): OutboundMessage {
    const { question, header, options, multiSelect, permId, sessionId } = data;

    const headerLine = header ? `📋 **${header}**\n\n` : '';
    const optionsList = options
      .map((opt, i) => `${i + 1}. **${opt.label}**${opt.description ? ` — ${opt.description}` : ''}`)
      .join('\n');
    const text = `${headerLine}${question}\n\n${optionsList}`;

    const buttons: Button[] = multiSelect
      ? this.buildMultiSelectButtons(permId, sessionId, options)
      : this.buildSingleSelectButtons(permId, options);

    const hint = multiSelect
      ? (this.locale === 'zh' ? '\n\n💬 点击选项切换，然后按 Submit 确认' : '\n\n💬 Tap options to toggle, then Submit')
      : (this.locale === 'zh' ? '\n\n💬 回复数字选择，或直接输入内容' : '\n\n💬 Reply with number to select, or type your answer');

    return this.createMessage(chatId, text + hint, buttons);
  }

  formatNotification(chatId: string, data: NotificationData): OutboundMessage {
    const emojiMap = { stop: '✅', idle_prompt: '⏳', generic: '📢' };
    const emoji = emojiMap[data.type];
    const summary = data.summary ? truncate(data.summary, 3000) : undefined;

    const lines = [`**${emoji} ${data.title}**`];
    if (summary) lines.push('', summary);
    if (data.terminalUrl) lines.push('', `🔗 [Open Terminal](${data.terminalUrl})`);

    return this.createMessage(chatId, lines.join('\n'));
  }

  formatHome(chatId: string, data: HomeData): OutboundMessage {
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

    return this.createMessage(chatId, lines.join('\n'));
  }

  formatSessions(chatId: string, data: SessionsData): OutboundMessage {
    const lines = [`📋 **Sessions** ${data.filterHint}`, ''];
    for (const s of data.sessions) {
      const marker = s.isCurrent ? ' ◀' : '';
      lines.push(`${s.index}. ${s.date} · ${s.cwd} · ${s.size} · ${s.preview}${marker}`);
    }
    const footer = this.locale === 'zh' ? '\n使用 /session <n> 切换' : '\nUse /session <n> to switch';
    return this.createMessage(chatId, lines.join('\n') + footer);
  }

  formatSessionDetail(chatId: string, data: SessionDetailData): OutboundMessage {
    const lines = [
      `📋 **Session #${data.index}**`,
      ``,
      `**Directory:** \`${data.cwd}\``,
      `**Date:** ${data.date}`,
      `**Size:** ${data.size}`,
      ``,
      `**Preview:** ${data.preview}`,
    ];
    if (data.transcript.length > 0) {
      lines.push(``, `**Recent messages:**`);
      for (const t of data.transcript.slice(0, 4)) {
        const role = t.role === 'user' ? '👤' : '🤖';
        lines.push(`${role} ${truncate(t.text, 100)}`);
      }
    }
    return this.createMessage(chatId, lines.join('\n'));
  }

  formatHelp(chatId: string, data: HelpData): OutboundMessage {
    const lines = [`📖 **Commands**`, ''];
    for (const cmd of data.commands) {
      lines.push(`/${cmd.cmd} — ${cmd.desc}`);
    }
    return this.createMessage(chatId, lines.join('\n'));
  }

  formatNewSession(chatId: string, data: NewSessionData): OutboundMessage {
    const cwdLabel = data.cwd ? ` in \`${data.cwd}\`` : '';
    const text = this.locale === 'zh'
      ? `✅ **新会话**${cwdLabel}`
      : `✅ **New Session**${cwdLabel}`;
    return this.createMessage(chatId, text);
  }

  formatError(chatId: string, data: ErrorData): OutboundMessage {
    const text = `❌ **${data.title}**\n\n${data.message}`;
    return this.createMessage(chatId, text);
  }

  formatProgress(chatId: string, data: ProgressData): OutboundMessage {
    const phaseEmoji = {
      starting: '⏳',
      executing: '⏳',
      waiting_permission: '🔐',
      completed: '✅',
      failed: '⚠️',
    };
    const emoji = phaseEmoji[data.phase];
    const lines = [
      `${emoji} **${data.taskSummary}**`,
      ``,
      `⏱ ${data.elapsedSeconds}s`,
    ];
    if (data.currentTool) {
      lines.push(``, `**Current:** ${data.currentTool.name}: ${truncate(data.currentTool.input, 100)}`);
    }
    return this.createMessage(chatId, lines.join('\n'));
  }

  // --- Helper methods ---

  protected createMessage(chatId: string, text: string, buttons?: Button[]): OutboundMessage {
    const msg: OutboundMessage = {
      chatId,
      text,
    };
    if (buttons && this.supportsButtons()) {
      msg.buttons = buttons;
    }
    return msg;
  }

  protected buildSingleSelectButtons(permId: string, options: Array<{ label: string }>): Button[] {
    return [
      ...options.map((opt, idx) => ({
        label: `${idx + 1}. ${opt.label}`,
        callbackData: `perm:allow:${permId}:askq:${idx}`,
        style: 'primary' as const,
      })),
      { label: '❌ Skip', callbackData: `perm:allow:${permId}:askq_skip`, style: 'danger' as const },
    ];
  }

  protected buildMultiSelectButtons(permId: string, sessionId: string, options: Array<{ label: string }>): Button[] {
    const buttons: Button[] = options.map((opt, idx) => ({
      label: `☐ ${opt.label}`,
      callbackData: `askq_toggle:${permId}:${idx}:${sessionId}`,
      style: 'primary' as const,
      row: idx,
    }));
    buttons.push(
      { label: '✅ Submit', callbackData: `askq_submit:${permId}:${sessionId}`, style: 'primary', row: options.length },
      { label: '❌ Skip', callbackData: `askq_skip:${permId}:${sessionId}`, style: 'danger', row: options.length }
    );
    return buttons;
  }
}