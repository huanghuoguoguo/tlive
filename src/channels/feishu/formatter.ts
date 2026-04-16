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
import { t } from '../../i18n/index.js';
import { downgradeHeadings } from './markdown.js';
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
  taskStartButtons,
  taskSummaryButtons,
  helpButtons,
} from '../../ui/buttons.js';
import { truncate } from '../../core/string.js';

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
    const status = data.healthy
      ? `🟢 ${t(this.locale, 'format.statusRunning')}`
      : `🔴 ${t(this.locale, 'format.statusDisconnected')}`;
    const channelDetails = data.channelInfo?.map(ch => {
      if (ch.name) return `${ch.type} (@${ch.name})`;
      if (ch.id) return `${ch.type} (${ch.id})`;
      return ch.type;
    }) || data.channels;

    const elements: FeishuCardElement[] = [
      this.md(`**${t(this.locale, 'format.labelStatus')}**\n${status}`),
      this.md(`**${t(this.locale, 'format.labelChannel')}**\n${channelDetails.join('\n') || t(this.locale, 'home.labelNone')}`),
    ];

    if (data.activeSessions !== undefined) {
      const total = (data.activeSessions || 0) + (data.idleSessions || 0);
      const sessionHeader = `${data.activeSessions} ${t(this.locale, 'format.statusActive')}` +
        (data.idleSessions ? ` / ${data.idleSessions} ${t(this.locale, 'format.statusIdle')}` : '') +
        ` (${t(this.locale, 'format.statusTotal')} ${total})`;

      if (data.sessionSnapshots?.length) {
        const now = Date.now();
        const lines = data.sessionSnapshots.map(s => {
          const { icon: stateIcon, text: stateText } = sessionStatusLabel(this.locale, s.isTurnActive, s.isAlive);
          const ago = this.formatElapsed(now - s.lastActiveAt);
          const dir = s.workdir.replace(/^\/home\/[^/]+\//, '~/');
          const sid = s.sessionKey.length > 12 ? `…${s.sessionKey.slice(-8)}` : s.sessionKey;
          return `${stateIcon} **${stateText}** \`${sid}\`\n📁 \`${dir}\` · ${ago}${t(this.locale, 'format.activeAgo')}`;
        });
        elements.push({
          tag: 'collapsible_panel',
          expanded: false,
          header: { title: { tag: 'plain_text', content: `📡 ${t(this.locale, 'format.labelSession')} ${sessionHeader}` } },
          elements: [mdPanel(lines.join('\n\n'))],
        } as FeishuCardElement);
      } else {
        elements.push(this.md(`**${t(this.locale, 'format.labelSession')}**\n${sessionHeader}`));
      }
    }

    if (data.memoryUsage) {
      elements.push(this.md(`**${t(this.locale, 'format.labelMemory')}**\n${data.memoryUsage}`));
    }
    if (data.uptimeSeconds !== undefined) {
      elements.push(this.md(`**${t(this.locale, 'format.labelUptime')}**\n${this.formatUptime(data.uptimeSeconds)}`));
    }
    if (data.version) {
      elements.push(this.md(`**${t(this.locale, 'format.labelVersion')}**\n\`v${data.version}\``));
    }
    if (data.cwd) {
      elements.push(this.md(`**${t(this.locale, 'format.labelDirectory')}**\n\`${data.cwd}\``));
    }

    return this.createCardMessage(chatId,
      { template: 'blue', title: t(this.locale, 'format.titleStatus') },
      elements
    );
  }

  protected override formatUptime(seconds: number): string {
    if (seconds < 60) return `${seconds}${t(this.locale, 'format.seconds')}`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}${t(this.locale, 'format.minutes')}`;
    if (seconds < 86400) {
      const hours = Math.floor(seconds / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      return `${hours}${t(this.locale, 'format.hours')}${mins}${t(this.locale, 'format.minutes')}`;
    }
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    return `${days}${t(this.locale, 'format.days')}${hours}${t(this.locale, 'format.hours')}`;
  }

  private formatElapsed(ms: number): string {
    return this.formatUptime(Math.floor(ms / 1000));
  }

  override formatPermission(chatId: string, data: PermissionData): FeishuRenderedMessage {
    const elements = buildPermissionElements({ chatId, data, locale: this.locale });
    const buttons = permissionFormatButtons(data, this.locale);
    return this.createCardMessage(chatId,
      { template: 'orange', title: t(this.locale, 'format.titlePermission') },
      elements,
      buttons
    );
  }

  override formatQuestion(chatId: string, data: QuestionData): FeishuRenderedMessage {
    const elements = buildQuestionElements({ chatId, data, locale: this.locale });
    return this.createCardMessage(chatId,
      { template: 'blue', title: t(this.locale, 'format.titleQuestion') },
      elements,
      undefined
    );
  }

  override formatDeferredToolInput(chatId: string, data: DeferredToolInputData): FeishuRenderedMessage {
    const elements = buildDeferredToolElements({ chatId, data, locale: this.locale });
    return this.createCardMessage(chatId,
      { template: 'purple', title: t(this.locale, 'format.titleDeferredInput') },
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
      { template: 'blue', title: t(this.locale, 'format.titleHome') },
      elements,
      buttons
    );
  }

  override formatPermissionStatus(chatId: string, data: PermissionStatusData): FeishuRenderedMessage {
    const elements = buildPermStatusElements({ chatId, data, locale: this.locale });
    const buttons = permStatusButtonsForMode(data.mode, this.locale);
    return this.createCardMessage(chatId,
      { template: data.mode === 'on' ? 'orange' : 'grey', title: t(this.locale, 'format.titlePermissionStatus') },
      elements,
      buttons
    );
  }

  override formatTaskStart(chatId: string, data: TaskStartData): FeishuRenderedMessage {
    const title = data.isNewSession
      ? t(this.locale, 'format.titleTaskReset')
      : t(this.locale, 'format.titleTaskStart');
    const elements: FeishuCardElement[] = [
      this.md(`**${t(this.locale, 'format.labelCurrentConfig')}**\n${t(this.locale, 'format.labelDirectory')}：${data.cwd}\n${t(this.locale, 'home.labelPermission')}：${data.permissionMode === 'on' ? t(this.locale, 'perm.labelModeOn') : t(this.locale, 'perm.labelModeOff')}`),
    ];
    if (data.previousSessionPreview) {
      elements.push(this.md(`**${t(this.locale, 'format.labelPreviousSession')}**\n${truncate(data.previousSessionPreview, 100)}`));
    }
    elements.push(this.md(t(this.locale, 'format.taskStartHint')));
    return this.createCardMessage(chatId,
      { template: 'blue', title },
      elements,
      taskStartButtons(this.locale)
    );
  }

  override formatTaskSummary(chatId: string, data: TaskSummaryData): FeishuRenderedMessage {
    const elements: FeishuCardElement[] = [
      this.md(`**${t(this.locale, 'format.labelResultSummary')}**\n${data.summary}`),
      this.md(`**${t(this.locale, 'taskSummary.labelResult')}**\n${t(this.locale, 'format.labelChangedFiles')}：${data.changedFiles}\n${t(this.locale, 'format.labelPermissionRequests')}：${data.permissionRequests}\n${t(this.locale, 'home.labelStatus')}：${data.hasError ? t(this.locale, 'taskSummary.statusError') : t(this.locale, 'taskSummary.statusDone')}`),
    ];
    if (data.footerLine) {
      elements.push(this.md(`<font color='grey'>${data.footerLine}</font>`));
    }
    return this.createCardMessage(chatId,
      { template: data.hasError ? 'red' : 'green', title: data.hasError ? t(this.locale, 'format.titleTaskEnd') : t(this.locale, 'format.titleTaskSummary') },
      elements,
      taskSummaryButtons(this.locale)
    );
  }

  override formatSessions(chatId: string, data: SessionsData): FeishuRenderedMessage {
    const showAll = data.showAll ?? false;
    const title = showAll ? t(this.locale, 'sessions.btnAll') : t(this.locale, 'sessions.btnRecent');
    const subtitle = showAll ? t(this.locale, 'sessions.subtitleAll') : t(this.locale, 'sessions.subtitleRecent');
    const elements: FeishuCardElement[] = [
      this.md(`**${title}** ${subtitle}`),
    ];

    const toggleButton: Button = showAll
      ? { label: t(this.locale, 'sessions.btnRecent'), callbackData: 'cmd:sessions', style: 'primary', row: 0 }
      : { label: t(this.locale, 'sessions.btnAll'), callbackData: 'cmd:sessions --all', style: 'default', row: 0 };
    elements.push(...buildFeishuButtonElements([toggleButton]));

    for (const s of data.sessions) {
      const marker = s.isCurrent ? t(this.locale, 'sessions.currentMarker') : '';
      const cwdDisplay = showAll ? `**${t(this.locale, 'sessions.labelDirectory')}**\n\`${s.cwd}\`\n` : '';
      const headerText = `${s.index}. ${s.date} · ${truncate(s.preview, 35)}${marker}`;
      const panelContent: FeishuCardElement[] = [
        this.md(`${cwdDisplay}**${t(this.locale, 'sessions.labelTime')}**\n${s.date}\n**${t(this.locale, 'sessions.labelSize')}**\n${s.size}\n**${t(this.locale, 'sessions.labelPreview')}**\n${truncate(s.preview, 200)}`),
      ];
      const switchBtn: Button = {
        label: `${t(this.locale, 'sessions.switchTo')} #${s.index}`,
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
        placeholder: { tag: 'plain_text', content: t(this.locale, 'sessions.inputPlaceholder') },
        required: false,
      } as FeishuCardElement,
    ];
    const formButtons: Button[] = [
      { label: t(this.locale, 'sessions.btnConfirmSwitch'), callbackData: 'form:session_select', style: 'primary', row: 0 },
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
      this.md(`**${t(this.locale, 'sessions.labelDirectory')}**\n\`${data.cwd}\``),
      this.md(`**${t(this.locale, 'sessions.labelTime')}**\n${data.date}`),
      this.md(`**${t(this.locale, 'sessions.labelSize')}**\n${data.size}`),
      this.md(`**${t(this.locale, 'sessions.labelPreview')}**\n${data.preview}`),
    ];
    if (data.transcript.length > 0) {
      const transcriptLines = data.transcript.slice(0, 4).map(t => {
        const role = t.role === 'user' ? '👤' : '🤖';
        return `${role} ${truncate(t.text, 100)}`;
      });
      elements.push(this.md(`**${t(this.locale, 'home.labelRecentChat')}**\n${transcriptLines.join('\n')}`));
    }
    return this.createCardMessage(chatId,
      { template: 'blue', title: `📋 ${t(this.locale, 'sessions.btnList')} #${data.index}` },
      elements
    );
  }

  override formatHelp(chatId: string, data: HelpData): FeishuRenderedMessage {
    const elements: FeishuCardElement[] = [];

    // Group commands by category
    const categories: Record<string, Array<{ cmd: string; desc: string; detail?: string; example?: string }>> = {
      会话管理: [],
      状态查看: [],
      系统控制: [],
      其他: [],
    };

    // Categorize commands
    for (const cmd of data.commands) {
      if (['new', 'session', 'sessions', 'sessioninfo', 'cd', 'pwd', 'bash'].includes(cmd.cmd)) {
        categories.会话管理.push(cmd);
      } else if (['status', 'home', 'queue', 'hooks', 'perm', 'project'].includes(cmd.cmd)) {
        categories.状态查看.push(cmd);
      } else if (['stop', 'restart', 'upgrade', 'diagnose', 'approve', 'pairings'].includes(cmd.cmd)) {
        categories.系统控制.push(cmd);
      } else {
        categories.其他.push(cmd);
      }
    }

    // Build panels for each category
    for (const [category, commands] of Object.entries(categories)) {
      if (commands.length === 0) continue;

      const panelElements: FeishuCardElement[] = [];
      for (const cmd of commands) {
        let text = `**/${cmd.cmd}** — ${cmd.desc}`;
        if (cmd.detail) {
          text += `\n${cmd.detail}`;
        }
        if (cmd.example) {
          text += `\n📌 示例: \`${cmd.example}\``;
        }
        panelElements.push(this.md(text));
        panelElements.push(this.md('---'));
      }
      // Remove last separator
      panelElements.pop();

      elements.push({
        tag: 'collapsible_panel',
        expanded: category === '会话管理', // Expand session management by default
        header: { title: { tag: 'plain_text', content: `📁 ${category}` } },
        elements: panelElements,
      } as FeishuCardElement);
    }

    return this.createCardMessage(chatId,
      { template: 'blue', title: t(this.locale, 'home.btnHelp') },
      elements,
      helpButtons(this.locale)
    );
  }

  override formatNewSession(chatId: string, data: NewSessionData): FeishuRenderedMessage {
    const cwdLabel = data.cwd ? ` in \`${data.cwd}\`` : '';
    return this.createCardMessage(chatId,
      { template: 'green', title: t(this.locale, 'newSession.title') },
      [this.md(`${t(this.locale, 'newSession.title')}${cwdLabel}`)]
    );
  }

  override formatProgress(chatId: string, data: ProgressData): FeishuRenderedMessage {
    const headerConfig = progressHeaderConfig(this.locale, data);
    const elements: FeishuCardElement[] = [];

    // Timeline elements
    elements.push(...buildProgressTimelineElements({ chatId, data, md: this.md.bind(this), locale: this.locale }));

    // Content elements (after timeline)
    elements.push(...buildProgressContentElements({ chatId, data, md: this.md.bind(this), locale: this.locale }));

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
      ? new Date(data.publishedAt).toLocaleDateString(this.locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric' })
      : '';
    const elements: FeishuCardElement[] = [
      this.md(`**${t(this.locale, 'version.title').replace('🔄 **', '').replace('**', '')}**\nv${data.current}`),
      this.md(`**${t(this.locale, 'version.released')}**\nv${data.latest}`),
    ];
    if (dateStr) {
      elements.push(this.md(`**${t(this.locale, 'version.released')}**\n${dateStr}`));
    }
    const buttons: Button[] = [
      { label: `⬆️ ${t(this.locale, 'home.labelSwitch')}`, callbackData: `cmd:upgrade confirm:${data.latest}`, style: 'primary' },
    ];
    return this.createCardMessage(chatId,
      { template: 'blue', title: t(this.locale, 'version.title') },
      elements,
      buttons
    );
  }

  override formatMultiSelectToggle(chatId: string, data: MultiSelectToggleData): FeishuRenderedMessage {
    const elements = buildMultiSelectElements({ chatId, data, locale: this.locale });
    const buttons = buildMultiSelectButtons(data.permId, data.sessionId, data.options, this.locale);
    buttons.forEach((btn, idx) => {
      if (idx < data.options.length) {
        btn.label = `${data.selectedIndices.has(idx) ? '☑' : '☐'} ${data.options[idx].label}`;
      }
    });
    return this.createCardMessage(chatId,
      { template: 'blue', title: t(this.locale, 'format.titleQuestion') },
      elements,
      buttons
    );
  }
}