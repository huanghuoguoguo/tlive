/**
 * Feishu message formatter - uses Card 2.0 JSON format.
 * Supports rich cards with headers, elements, and structured buttons.
 */

import { MessageFormatter, type MessageLocale } from './message-formatter.js';
import { downgradeHeadings } from '../markdown/feishu.js';
import type { OutboundMessage, Button } from '../channels/types.js';
import type {
  NotificationData,
  HomeData,
  SessionsData,
  SessionDetailData,
  HelpData,
  NewSessionData,
  ProgressData,
  PermissionData,
  QuestionData,
  CardResolutionData,
  VersionUpdateData,
  MultiSelectToggleData,
} from './message-types.js';
import { truncate } from '../utils/string.js';
import { buildFeishuButtonElements } from './feishu-card.js';

type FeishuElement = { tag: string; [key: string]: unknown };

export class FeishuFormatter extends MessageFormatter {
  constructor(locale: MessageLocale = 'zh') {
    super(locale);
  }

  protected formatMarkdown(_text: string): string {
    // Feishu uses markdown directly in card elements
    throw new Error('Use createCardMessage for Feishu');
  }

  protected supportsButtons(): boolean {
    return true;
  }

  protected createMessage(chatId: string, text: string, buttons?: Button[]): OutboundMessage {
    // Simple text message (no card)
    const msg: OutboundMessage = { chatId, text };
    if (buttons) {
      msg.buttons = buttons;
    }
    return msg;
  }

  protected createCardMessage(
    chatId: string,
    header: { template: string; title: string },
    elements: FeishuElement[],
    buttons?: Button[]
  ): OutboundMessage {
    const allElements = [...elements];
    if (buttons && buttons.length > 0) {
      allElements.push(...buildFeishuButtonElements(buttons));
    }
    return {
      chatId,
      text: '', // Text is in elements
      feishuHeader: header,
      feishuElements: allElements,
    };
  }

  private md(content: string): FeishuElement {
    return { tag: 'markdown', content: downgradeHeadings(content) };
  }

  // --- Override all formatting methods for Feishu Card format ---

  override formatStatus(chatId: string, data: { healthy: boolean; channels: string[]; cwd?: string; sessionId?: string }): OutboundMessage {
    const status = data.healthy ? '🟢 运行中' : '🔴 已断开';
    const channelList = data.channels.join(', ') || '无';
    const elements: FeishuElement[] = [
      this.md(`**状态**\n${status}`),
      this.md(`**通道**\n${channelList}`),
    ];
    if (data.cwd) {
      elements.push(this.md(`**目录**\n\`${data.cwd}\``));
    }
    return this.createCardMessage(chatId,
      { template: 'blue', title: '📊 TLive 状态' },
      elements
    );
  }

  override formatPermission(chatId: string, data: PermissionData): OutboundMessage {
    const input = truncate(data.toolInput, 300);
    const expires = data.expiresInMinutes ?? 5;
    const elements: FeishuElement[] = [
      this.md(`**工具**\n${data.toolName}`),
      this.md(`**输入**\n\`\`\`\n${input}\n\`\`\``),
      this.md(`⏱ ${expires} 分钟内处理`),
    ];
    if (data.terminalUrl) {
      elements.push(this.md(`🔗 [Open Terminal](${data.terminalUrl})`));
    }
    elements.push(this.md('💬 也可以直接回复 **allow** / **deny**。'));

    const buttons: Button[] = [
      { label: '✅ 允许', callbackData: `perm:allow:${data.permissionId}`, style: 'primary' },
      { label: '❌ 拒绝', callbackData: `perm:deny:${data.permissionId}`, style: 'danger' },
    ];

    return this.createCardMessage(chatId,
      { template: 'orange', title: '🔐 待审批动作' },
      elements,
      buttons
    );
  }

  override formatQuestion(chatId: string, data: QuestionData): OutboundMessage {
    const { question, options, multiSelect, permId, sessionId } = data;

    const optionsList = options
      .map((opt, i) => `${i + 1}. **${opt.label}**${opt.description ? ` — ${opt.description}` : ''}`)
      .join('\n');

    const buttons: Button[] = multiSelect
      ? this.buildMultiSelectButtons(permId, sessionId, options)
      : this.buildSingleSelectButtons(permId, options);

    const hint = multiSelect
      ? '点击选项切换勾选，然后点 Submit；也可以直接回复文字。'
      : '可直接点选，也可以直接回复文字。';

    const elements: FeishuElement[] = [
      this.md(`**问题**\n${question}`),
      this.md(`**选项**\n${optionsList}`),
      this.md(`**说明**\n${hint}`),
    ];

    return this.createCardMessage(chatId,
      { template: 'blue', title: '❓ 等待回答' },
      elements,
      buttons
    );
  }

  override formatNotification(chatId: string, data: NotificationData): OutboundMessage {
    const templateMap = { stop: 'green', idle_prompt: 'yellow', generic: 'blue' };
    const emojiMap = { stop: '✅', idle_prompt: '⏳', generic: '📢' };
    const template = templateMap[data.type];
    const emoji = emojiMap[data.type];

    const elements: FeishuElement[] = [];
    if (data.summary) {
      elements.push(this.md(downgradeHeadings(truncate(data.summary, 3000))));
    }
    if (data.terminalUrl) {
      elements.push({ tag: 'hr' });
      elements.push(this.md(`<font color='grey'>🔗 [Open Terminal](${data.terminalUrl})</font>`));
    }

    return this.createCardMessage(chatId,
      { template, title: `${emoji} ${data.title}` },
      elements
    );
  }

  override formatHome(chatId: string, data: HomeData): OutboundMessage {
    const statusText = data.hasActiveTask
      ? '有任务正在执行，通常更适合先回到最近会话继续处理。'
      : '当前没有执行中的任务，可从最近会话继续，也可开始新会话。';

    const elements: FeishuElement[] = [
      this.md(`**当前状态**\n${statusText}`),
      this.md(`**项目目录**\n${data.cwd}`),
      this.md(data.recentSummary
        ? `**最近一次任务**\n${truncate(data.recentSummary, 180)}`
        : '**最近一次任务**\n暂无历史任务摘要'
      ),
      this.md('**说明**\n"新会话"会清空当前飞书侧会话绑定；如果你只是想接着电脑上的工作做，优先用"最近会话"或"会话列表"。'),
    ];

    const buttons: Button[] = [
      { label: '🕘 最近会话', callbackData: 'cmd:sessions --all', style: 'primary', row: 0 },
      { label: '🆕 新会话', callbackData: 'cmd:new', style: 'default', row: 0 },
      { label: '❓ 帮助', callbackData: 'cmd:help', style: 'default', row: 1 },
    ];

    return this.createCardMessage(chatId,
      { template: 'indigo', title: '🏠 TLive 工作台' },
      elements,
      buttons
    );
  }

  override formatSessions(chatId: string, data: SessionsData): OutboundMessage {
    const lines: string[] = [];
    for (const s of data.sessions) {
      const marker = s.isCurrent ? ' ◀' : '';
      lines.push(`${s.index}. ${s.date} · ${s.cwd} · ${s.size} · ${s.preview}${marker}`);
    }

    const elements: FeishuElement[] = [
      this.md(`**会话列表** ${data.filterHint}\n${lines.join('\n')}`),
      this.md('可直接点击"继续"或"详情"，也可以手输 /session <n>。'),
    ];

    const buttons: Button[] = [];
    for (let i = 0; i < Math.min(data.sessions.length, 5); i++) {
      buttons.push(
        { label: `▶️ 继续 #${i + 1}`, callbackData: `cmd:session ${i + 1}`, style: 'primary', row: i },
        { label: `ℹ️ 详情 #${i + 1}`, callbackData: `cmd:sessioninfo ${i + 1}`, style: 'default', row: i }
      );
    }

    return this.createCardMessage(chatId,
      { template: 'blue', title: '📋 会话列表' },
      elements,
      buttons.length > 0 ? buttons : undefined
    );
  }

  override formatSessionDetail(chatId: string, data: SessionDetailData): OutboundMessage {
    const elements: FeishuElement[] = [
      this.md(`**目录**\n\`${data.cwd}\``),
      this.md(`**时间**\n${data.date}`),
      this.md(`**大小**\n${data.size}`),
      this.md(`**预览**\n${data.preview}`),
    ];

    if (data.transcript.length > 0) {
      const transcriptLines = data.transcript.slice(0, 4).map(t => {
        const role = t.role === 'user' ? '👤' : '🤖';
        return `${role} ${truncate(t.text, 100)}`;
      });
      elements.push(this.md(`**最近消息**\n${transcriptLines.join('\n')}`));
    }

    return this.createCardMessage(chatId,
      { template: 'blue', title: `📋 会话 #${data.index}` },
      elements
    );
  }

  override formatHelp(chatId: string, data: HelpData): OutboundMessage {
    const lines = data.commands.map(cmd => `/${cmd.cmd} — ${cmd.desc}`);
    const elements: FeishuElement[] = [
      this.md(`**命令列表**\n${lines.join('\n')}`),
    ];

    const buttons: Button[] = [
      { label: '🆕 新会话', callbackData: 'cmd:new', style: 'primary', row: 0 },
      { label: '📋 会话列表', callbackData: 'cmd:sessions', style: 'default', row: 0 },
    ];

    return this.createCardMessage(chatId,
      { template: 'blue', title: '❓ 常用帮助' },
      elements,
      buttons
    );
  }

  override formatNewSession(chatId: string, data: NewSessionData): OutboundMessage {
    const cwdLabel = data.cwd ? ` in \`${data.cwd}\`` : '';
    return this.createCardMessage(chatId,
      { template: 'green', title: '✅ 新会话' },
      [this.md(`已创建新会话${cwdLabel}`)]
    );
  }

  override formatProgress(chatId: string, data: ProgressData): OutboundMessage {
    const headerConfig = data.phase === 'completed'
      ? { template: 'green' as const, title: '✅ 已完成' }
      : data.phase === 'failed'
        ? { template: 'red' as const, title: '⚠️ 已停止' }
        : data.phase === 'waiting_permission'
          ? { template: 'orange' as const, title: '🔐 等待权限' }
          : { template: 'blue' as const, title: data.phase === 'starting' ? '⏳ 准备开始' : '⏳ 执行中' };

    const elements: FeishuElement[] = [];
    const isDone = data.phase === 'completed' || data.phase === 'failed';

    if (isDone) {
      // Completed/failed: show response text directly, minimal chrome
      if (data.renderedText.trim()) {
        elements.push(this.md(downgradeHeadings(truncate(data.renderedText, 3000))));
      }
    } else if (data.phase === 'waiting_permission' && data.permission) {
      // Permission: show what's being waited on
      const extraQueue = data.permission.queueLength > 1 ? `\n待处理审批：${data.permission.queueLength} 个` : '';
      elements.push(this.md(
        `**当前等待**\n${data.permission.toolName}\n\`\`\`\n${truncate(data.permission.input, 260)}\n\`\`\`${extraQueue}`
      ));
      elements.push(this.md(`**运行时长** ${data.elapsedSeconds}s`));
    } else {
      // In-progress: nothing here — timeline handles the content below
      if (!data.timeline?.length) {
        // Fallback for no timeline data
        if (data.currentTool?.input) {
          const currentElapsed = data.currentTool.elapsed > 0 ? ` · ${data.currentTool.elapsed}s` : '';
          elements.push(this.md(`**最近动作**\n${data.currentTool.name}: ${truncate(data.currentTool.input, 140)}${currentElapsed}`));
        }
        elements.push(this.md(`**运行时长** ${data.elapsedSeconds}s`));
      }
    }

    // Todo progress
    if (data.todoItems.length > 0) {
      const done = data.todoItems.filter(item => item.status === 'completed').length;
      const todoLines = data.todoItems.slice(0, 5).map(item => {
        const icon = item.status === 'completed' ? '✅' : item.status === 'in_progress' ? '🔧' : '⬜';
        return `${icon} ${item.content}`;
      });
      elements.push(this.md(`**工作进度** (${done}/${data.todoItems.length})\n${todoLines.join('\n')}`));
    }

    // Timeline: interleaved thinking, text, and tool calls
    if (data.timeline?.length) {
      // Budget: limit total elements to avoid huge cards
      let budget = 3000;
      for (const entry of data.timeline) {
        if (budget <= 0) break;
        if (entry.kind === 'thinking' && entry.text?.trim()) {
          const content = truncate(entry.text.trim(), Math.min(budget, 1500));
          budget -= content.length;
          elements.push({
            tag: 'collapsible_panel',
            expanded: false,
            header: { title: { tag: 'plain_text', content: '💭 思考过程' } },
            elements: [{ tag: 'markdown', content }],
          });
        } else if (entry.kind === 'text' && entry.text?.trim()) {
          const content = truncate(downgradeHeadings(entry.text.trim()), Math.min(budget, 1500));
          budget -= content.length;
          elements.push(this.md(content));
        } else if (entry.kind === 'tool' && entry.toolName) {
          const icon = entry.isError ? '❌' : entry.toolResult !== undefined ? '✅' : '⏳';
          const resultLine = entry.toolResult ? `\n→ ${truncate(entry.toolResult, 120)}` : '';
          const content = `${truncate(entry.toolInput || '(no input)', 200)}${resultLine}`;
          budget -= content.length;
          elements.push({
            tag: 'collapsible_panel',
            expanded: false,
            header: { title: { tag: 'plain_text', content: `${icon} ${entry.toolName}` } },
            elements: [{ tag: 'markdown', content }],
          });
        }
      }
      // Status line at the bottom
      if (!isDone) {
        const statusParts: string[] = [];
        if (data.totalTools > 0) statusParts.push(`${data.totalTools} tools`);
        statusParts.push(`${data.elapsedSeconds}s`);
        elements.push(this.md(`⏳ ${statusParts.join(' · ')}`));
      }
    } else if (!data.timeline?.length) {
      // Legacy fallback: separate thinking + tool panels (when no timeline data)
      if (data.thinkingText?.trim()) {
        elements.push({
          tag: 'collapsible_panel',
          expanded: false,
          header: { title: { tag: 'plain_text', content: '💭 思考过程' } },
          elements: [{ tag: 'markdown', content: truncate(data.thinkingText.trim(), 1500) }],
        });
      }
      if (data.toolLogs?.length) {
        const logLines = data.toolLogs.map(log => {
          const icon = log.isError ? '❌' : '✅';
          const status = log.result !== undefined ? icon : '⏳';
          const resultLine = log.result ? `\n   → ${truncate(log.result, 120)}` : '';
          return `${status} **${log.name}**: ${truncate(log.input || '(no input)', 100)}${resultLine}`;
        });
        elements.push({
          tag: 'collapsible_panel',
          expanded: false,
          header: { title: { tag: 'plain_text', content: `🔧 工具调用 (${data.toolLogs.length})` } },
          elements: [{ tag: 'markdown', content: truncate(logLines.join('\n'), 2000) }],
        });
      }
    }

    const buttons = data.actionButtons?.length ? data.actionButtons : this.defaultProgressButtons(data.phase);
    return this.createCardMessage(chatId, headerConfig, elements, buttons);
  }

  override formatCardResolution(chatId: string, data: CardResolutionData): OutboundMessage {
    const templateMap: Record<CardResolutionData['resolution'], string> = {
      approved: 'green',
      denied: 'red',
      skipped: 'grey',
      answered: 'green',
      selected: 'green',
    };
    const template = templateMap[data.resolution] ?? 'grey';
    const title = data.contextSuffix ? `${data.label}${data.contextSuffix}` : data.label;
    const elements: FeishuElement[] = data.originalText
      ? [this.md(`${data.originalText}\n\n${data.label}`)]
      : [this.md(data.label)];
    return this.createCardMessage(chatId, { template, title }, elements, data.buttons);
  }

  override formatVersionUpdate(chatId: string, data: VersionUpdateData): OutboundMessage {
    const dateStr = data.publishedAt
      ? new Date(data.publishedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
      : '';
    const elements: FeishuElement[] = [
      this.md(`**当前版本**\nv${data.current}`),
      this.md(`**最新版本**\nv${data.latest}`),
    ];
    if (dateStr) {
      elements.push(this.md(`**发布时间**\n${dateStr}`));
    }

    const buttons: Button[] = [
      { label: '⬆️ 立即升级', callbackData: `cmd:upgrade confirm:${data.latest}`, style: 'primary' },
      { label: '⏭️ 不再提示', callbackData: `cmd:upgrade skip:${data.latest}`, style: 'default' },
    ];

    return this.createCardMessage(chatId,
      { template: 'blue', title: '🔄 发现新版本' },
      elements,
      buttons
    );
  }

  override formatMultiSelectToggle(chatId: string, data: MultiSelectToggleData): OutboundMessage {
    const optionsList = data.options
      .map((opt, i) => `${data.selectedIndices.has(i) ? '☑' : '☐'} ${i + 1}. **${opt.label}**${opt.description ? ` — ${opt.description}` : ''}`)
      .join('\n');

    const buttons = this.buildMultiSelectButtons(data.permId, data.sessionId, data.options);
    buttons.forEach((btn, idx) => {
      if (idx < data.options.length) {
        btn.label = `${data.selectedIndices.has(idx) ? '☑' : '☐'} ${data.options[idx].label}`;
      }
    });

    const elements: FeishuElement[] = [
      this.md(`**问题**\n${data.question}`),
      this.md(`**选项**\n${optionsList}`),
      this.md('**说明**\n点击选项切换勾选，然后点 Submit；也可以直接回复文字。'),
    ];

    return this.createCardMessage(chatId,
      { template: 'blue', title: '❓ 等待回答' },
      elements,
      buttons
    );
  }
}