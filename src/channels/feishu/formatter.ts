/**
 * Feishu message formatter - uses Card 2.0 JSON format.
 * Supports rich cards with headers, elements, and structured buttons.
 *
 * Main formatter delegates to specialized modules:
 * - format-home.ts: Home screen formatting
 * - format-permission.ts: Permission/question formatting
 * - format-progress.ts: Progress/timeline formatting
 */

import { MessageFormatter, type MessageLocale } from '../../formatting/message-formatter.js';
import { downgradeHeadings, splitLargeTables } from './markdown.js';
import { buildFeishuButtonElements, type FeishuCardElement } from './card-builder.js';
import type { FeishuRenderedMessage } from './types.js';
import type {
  NotificationData,
  HomeData,
  PermissionStatusData,
  TaskStartData,
  SessionsData,
  SessionDetailData,
  HelpData,
  NewSessionData,
  ProgressData,
  TaskSummaryData,
  PermissionData,
  QuestionData,
  DeferredToolInputData,
  CardResolutionData,
  VersionUpdateData,
  MultiSelectToggleData,
  StatusData,
} from '../../formatting/message-types.js';
import type { Button } from '../../ui/types.js';
import {
  permStatusButtons,
  taskStartButtons,
  taskSummaryButtons,
  helpButtons,
} from '../../ui/buttons.js';
import { truncate } from '../../utils/string.js';

// Import specialized formatters
import {
  sessionStatusLabel,
  mdElement,
  mdPanel,
  buildHomeElements,
  homeButtons,
} from './format-home.js';
import {
  buildPermissionElements,
  permissionFormatButtons,
  buildQuestionElements,
  buildDeferredToolElements,
  buildPermStatusElements,
  permStatusButtonsForMode,
  buildMultiSelectElements,
  buildMultiSelectButtons,
} from './format-permission.js';
import {
  buildProgressTimelineElements,
  buildProgressContentElements,
  progressHeaderConfig,
} from './format-progress.js';

export class FeishuFormatter extends MessageFormatter<FeishuRenderedMessage> {
  constructor(locale: MessageLocale = 'zh') {
    super(locale);
  }

  protected formatMarkdown(_text: string): string {
    throw new Error('Use createCardMessage for Feishu');
  }

  protected supportsButtons(): boolean {
    return true;
  }

  protected createMessage(chatId: string, text: string, buttons?: Button[]): FeishuRenderedMessage {
    const msg: FeishuRenderedMessage = { chatId, text };
    if (buttons) {
      msg.buttons = buttons;
    }
    return msg;
  }

  protected createCardMessage(
    chatId: string,
    header: { template: string; title: string },
    elements: FeishuCardElement[],
    buttons?: Button[]
  ): FeishuRenderedMessage {
    const allElements = [...elements];
    if (buttons && buttons.length > 0) {
      allElements.push(...buildFeishuButtonElements(buttons));
    }
    return {
      chatId,
      text: '',
      feishuHeader: header,
      feishuElements: allElements,
    };
  }

  private md(content: string): FeishuCardElement {
    return mdElement(content);
  }

  // --- Override all formatting methods for Feishu Card format ---

  override formatStatus(chatId: string, data: StatusData): FeishuRenderedMessage {
    const status = data.healthy ? '🟢 运行中' : '🔴 已断开';
    const channelDetails = data.channelInfo?.map(ch => {
      if (ch.name) return `${ch.type} (@${ch.name})`;
      if (ch.id) return `${ch.type} (${ch.id})`;
      return ch.type;
    }) || data.channels;

    const elements: FeishuCardElement[] = [
      this.md(`**状态**\n${status}`),
      this.md(`**通道**\n${channelDetails.join('\n') || '无'}`),
    ];

    if (data.activeSessions !== undefined) {
      const total = (data.activeSessions || 0) + (data.idleSessions || 0);
      const sessionHeader = `${data.activeSessions} 活跃` +
        (data.idleSessions ? ` / ${data.idleSessions} 空闲` : '') +
        ` (共 ${total})`;

      if (data.sessionSnapshots?.length) {
        const now = Date.now();
        const lines = data.sessionSnapshots.map(s => {
          const { icon: stateIcon, text: stateText } = sessionStatusLabel(s.isTurnActive, s.isAlive);
          const ago = this.formatElapsed(now - s.lastActiveAt);
          const dir = s.workdir.replace(/^\/home\/[^/]+\//, '~/');
          const sid = s.sessionKey.length > 12 ? `…${s.sessionKey.slice(-8)}` : s.sessionKey;
          return `${stateIcon} **${stateText}** \`${sid}\`\n📁 \`${dir}\` · ${ago}前活跃`;
        });
        elements.push({
          tag: 'collapsible_panel',
          expanded: false,
          header: { title: { tag: 'plain_text', content: `📡 会话 ${sessionHeader}` } },
          elements: [mdPanel(lines.join('\n\n'))],
        } as FeishuCardElement);
      } else {
        elements.push(this.md(`**会话**\n${sessionHeader}`));
      }
    }

    if (data.memoryUsage) {
      elements.push(this.md(`**内存**\n${data.memoryUsage}`));
    }
    if (data.uptimeSeconds !== undefined) {
      elements.push(this.md(`**运行时长**\n${this.formatUptime(data.uptimeSeconds)}`));
    }
    if (data.version) {
      elements.push(this.md(`**版本**\n\`v${data.version}\``));
    }
    if (data.cwd) {
      elements.push(this.md(`**目录**\n\`${data.cwd}\``));
    }

    return this.createCardMessage(chatId,
      { template: 'blue', title: '📊 TLive 状态' },
      elements
    );
  }

  protected override formatUptime(seconds: number): string {
    if (seconds < 60) return `${seconds}秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`;
    if (seconds < 86400) {
      const hours = Math.floor(seconds / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      return `${hours}小时${mins}分钟`;
    }
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    return `${days}天${hours}小时`;
  }

  private formatElapsed(ms: number): string {
    return this.formatUptime(Math.floor(ms / 1000));
  }

  override formatPermission(chatId: string, data: PermissionData): FeishuRenderedMessage {
    const elements = buildPermissionElements({ chatId, data, locale: this.locale });
    const buttons = permissionFormatButtons(data, this.locale);
    return this.createCardMessage(chatId,
      { template: 'orange', title: '🔐 待审批动作' },
      elements,
      buttons
    );
  }

  override formatQuestion(chatId: string, data: QuestionData): FeishuRenderedMessage {
    const elements = buildQuestionElements({ chatId, data });
    return this.createCardMessage(chatId,
      { template: 'blue', title: '❓ 等待回答' },
      elements,
      undefined
    );
  }

  override formatDeferredToolInput(chatId: string, data: DeferredToolInputData): FeishuRenderedMessage {
    const elements = buildDeferredToolElements({ chatId, data });
    return this.createCardMessage(chatId,
      { template: 'purple', title: '⏳ 等待输入' },
      elements,
      undefined
    );
  }

  override formatNotification(chatId: string, data: NotificationData): FeishuRenderedMessage {
    const templateMap = { stop: 'green', idle_prompt: 'yellow', generic: 'blue' };
    const emojiMap = { stop: '✅', idle_prompt: '⏳', generic: '📢' };
    const template = templateMap[data.type];
    const emoji = emojiMap[data.type];

    const elements: FeishuCardElement[] = [];
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

  override formatHome(chatId: string, data: HomeData): FeishuRenderedMessage {
    const elements = buildHomeElements({
      chatId,
      data,
      locale: this.locale,
      md: this.md.bind(this),
      buildButtons: buildFeishuButtonElements,
    });
    const buttons = homeButtons(this.locale);
    return this.createCardMessage(chatId,
      { template: 'blue', title: '🏠 工作台' },
      elements,
      buttons
    );
  }

  override formatPermissionStatus(chatId: string, data: PermissionStatusData): FeishuRenderedMessage {
    const elements = buildPermStatusElements({ chatId, data, locale: this.locale });
    const buttons = permStatusButtonsForMode(data.mode, this.locale);
    return this.createCardMessage(chatId,
      { template: data.mode === 'on' ? 'orange' : 'grey', title: '🔐 权限状态' },
      elements,
      buttons
    );
  }

  override formatTaskStart(chatId: string, data: TaskStartData): FeishuRenderedMessage {
    const title = data.isNewSession ? '🔄 会话已重置' : '🚀 开始执行';
    const elements: FeishuCardElement[] = [
      this.md(`**当前配置**\n目录：${data.cwd}\n权限：${data.permissionMode === 'on' ? '开启审批' : '关闭审批'}`),
    ];
    if (data.previousSessionPreview) {
      elements.push(this.md(`**上次会话**\n${truncate(data.previousSessionPreview, 100)}`));
    }
    elements.push(this.md('💡 任务已开始执行。如需调整配置，点击下方按钮。'));
    return this.createCardMessage(chatId,
      { template: 'blue', title },
      elements,
      taskStartButtons(this.locale)
    );
  }

  override formatTaskSummary(chatId: string, data: TaskSummaryData): FeishuRenderedMessage {
    const elements: FeishuCardElement[] = [
      this.md(`**结果摘要**\n${data.summary}`),
      this.md(`**执行结果**\n改动文件：${data.changedFiles}\n权限审批：${data.permissionRequests}\n状态：${data.hasError ? '有错误' : '已完成'}`),
    ];
    if (data.footerLine) {
      elements.push(this.md(`<font color='grey'>${data.footerLine}</font>`));
    }
    return this.createCardMessage(chatId,
      { template: data.hasError ? 'red' : 'green', title: data.hasError ? '⚠️ 任务结束' : '✅ 任务摘要' },
      elements,
      taskSummaryButtons(this.locale)
    );
  }

  override formatSessions(chatId: string, data: SessionsData): FeishuRenderedMessage {
    const showAll = data.showAll ?? false;
    const title = showAll ? '📋 所有会话' : '📋 最近会话';
    const subtitle = showAll ? '(全局)' : '(当前工作区)';
    const elements: FeishuCardElement[] = [
      this.md(`**${title}** ${subtitle}`),
    ];

    const toggleButton: Button = showAll
      ? { label: '📋 最近会话', callbackData: 'cmd:sessions', style: 'primary', row: 0 }
      : { label: '📋 所有会话', callbackData: 'cmd:sessions --all', style: 'default', row: 0 };
    elements.push(...buildFeishuButtonElements([toggleButton]));

    for (const s of data.sessions) {
      const marker = s.isCurrent ? ' ◀ 当前' : '';
      const cwdDisplay = showAll ? `**目录**\n\`${s.cwd}\`\n` : '';
      const headerText = `${s.index}. ${s.date} · ${truncate(s.preview, 35)}${marker}`;
      const panelContent: FeishuCardElement[] = [
        this.md(`${cwdDisplay}**时间**\n${s.date}\n**大小**\n${s.size}\n**预览**\n${truncate(s.preview, 200)}`),
      ];
      const switchBtn: Button = {
        label: `▶️ 切换到 #${s.index}`,
        callbackData: `cmd:session ${s.index}`,
        style: s.isCurrent ? 'primary' : 'default',
        row: 0,
      };
      panelContent.push(...buildFeishuButtonElements([switchBtn]));
      elements.push({
        tag: 'collapsible_panel',
        expanded: s.isCurrent,
        header: { title: { tag: 'plain_text', content: headerText } },
        elements: panelContent,
      } as FeishuCardElement);
    }

    const formElements: FeishuCardElement[] = [
      {
        tag: 'input',
        name: '_session_idx',
        placeholder: { tag: 'plain_text', content: '输入编号切换其他会话' },
        required: false,
      } as FeishuCardElement,
    ];
    const formButtons: Button[] = [
      { label: '✅ 切换', callbackData: 'form:session_select', style: 'primary', row: 0 },
    ];
    const formContainer: FeishuCardElement = {
      tag: 'form',
      name: 'form_session_select',
      elements: [
        ...formElements as unknown as { tag: string; content: string }[],
        ...buildFeishuButtonElements(formButtons) as unknown as { tag: string; content: string }[],
      ],
    };
    elements.push(formContainer);

    return this.createCardMessage(chatId,
      { template: 'blue', title },
      elements,
      undefined
    );
  }

  override formatSessionDetail(chatId: string, data: SessionDetailData): FeishuRenderedMessage {
    const elements: FeishuCardElement[] = [
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

  override formatHelp(chatId: string, data: HelpData): FeishuRenderedMessage {
    const lines = data.commands.map(cmd => `/${cmd.cmd} — ${cmd.desc}`);
    const elements: FeishuCardElement[] = [
      this.md(`**命令列表**\n${lines.join('\n')}`),
    ];
    return this.createCardMessage(chatId,
      { template: 'blue', title: '❓ 常用帮助' },
      elements,
      helpButtons(this.locale)
    );
  }

  override formatNewSession(chatId: string, data: NewSessionData): FeishuRenderedMessage {
    const cwdLabel = data.cwd ? ` in \`${data.cwd}\`` : '';
    return this.createCardMessage(chatId,
      { template: 'green', title: '✅ 新会话' },
      [this.md(`已创建新会话${cwdLabel}`)]
    );
  }

  override formatProgress(chatId: string, data: ProgressData): FeishuRenderedMessage {
    const headerConfig = progressHeaderConfig(data);
    const elements: FeishuCardElement[] = [];

    // Timeline elements
    elements.push(...buildProgressTimelineElements({ chatId, data, md: this.md.bind(this) }));

    // Content elements (after timeline)
    elements.push(...buildProgressContentElements({ chatId, data, md: this.md.bind(this) }));

    const buttons = data.actionButtons?.length ? data.actionButtons : this.defaultProgressButtons(data.phase);
    return this.createCardMessage(chatId, headerConfig, elements, buttons);
  }

  override formatCardResolution(chatId: string, data: CardResolutionData): FeishuRenderedMessage {
    const templateMap: Record<CardResolutionData['resolution'], string> = {
      approved: 'green',
      denied: 'red',
      skipped: 'grey',
      answered: 'green',
      selected: 'green',
    };
    const template = templateMap[data.resolution] ?? 'grey';
    const title = data.contextSuffix ? `${data.label}${data.contextSuffix}` : data.label;
    const elements: FeishuCardElement[] = data.originalText
      ? [this.md(`${data.originalText}\n\n${data.label}`)]
      : [this.md(data.label)];
    return this.createCardMessage(chatId, { template, title }, elements, data.buttons);
  }

  override formatVersionUpdate(chatId: string, data: VersionUpdateData): FeishuRenderedMessage {
    const dateStr = data.publishedAt
      ? new Date(data.publishedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
      : '';
    const elements: FeishuCardElement[] = [
      this.md(`**当前版本**\nv${data.current}`),
      this.md(`**最新版本**\nv${data.latest}`),
    ];
    if (dateStr) {
      elements.push(this.md(`**发布时间**\n${dateStr}`));
    }
    const buttons: Button[] = [
      { label: '⬆️ 立即升级', callbackData: `cmd:upgrade confirm:${data.latest}`, style: 'primary' },
    ];
    return this.createCardMessage(chatId,
      { template: 'blue', title: '🔄 发现新版本' },
      elements,
      buttons
    );
  }

  override formatMultiSelectToggle(chatId: string, data: MultiSelectToggleData): FeishuRenderedMessage {
    const elements = buildMultiSelectElements({ chatId, data });
    const buttons = buildMultiSelectButtons(data.permId, data.sessionId, data.options);
    buttons.forEach((btn, idx) => {
      if (idx < data.options.length) {
        btn.label = `${data.selectedIndices.has(idx) ? '☑' : '☐'} ${data.options[idx].label}`;
      }
    });
    return this.createCardMessage(chatId,
      { template: 'blue', title: '❓ 等待回答' },
      elements,
      buttons
    );
  }
}