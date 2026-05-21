/**
 * Feishu message formatter - uses Card 2.0 JSON format.
 * Supports rich cards with headers, elements, and structured buttons.
 *
 * Main formatter delegates to specialized modules:
 * - format-home.ts: Home screen formatting
 * - format-permission.ts: Permission/question formatting
 * - format-progress.ts: Progress/timeline formatting
 */

import {
  MessageFormatter,
  type MessageFormatterOptions,
} from '../../formatting/message-formatter.js';
import { t, type Locale } from '../../i18n/index.js';
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
  QueueStatusData,
  DiagnoseData,
} from '../../formatting/message-types.js';
import type { Button } from '../../ui/types.js';
import { taskStartButtons, taskSummaryButtons, helpButtons } from '../../ui/buttons.js';
import { truncate } from '../../core/string.js';

// Import specialized formatters
import { mdElement, buildHomeElements, homeButtons } from './format-home.js';
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
import { buildStatusElements, formatFeishuUptime } from './format-status.js';
import { buildSessionDetailElements, buildSessionsElements } from './format-sessions.js';
import { buildHelpElements } from './format-help.js';
import { buildDiagnoseElements, buildQueueStatusElements } from './format-diagnostics.js';

export class FeishuFormatter extends MessageFormatter<FeishuRenderedMessage> {
  constructor(locale: Locale = 'zh', options: MessageFormatterOptions = {}) {
    super(locale, options);
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
    buttons?: Button[],
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

  private footerActionPanel(footerLine: string, buttons: Button[]): FeishuCardElement {
    const panelElements = buttons.length
      ? buildFeishuButtonElements(buttons)
      : [this.md(`<font color='grey'>${footerLine}</font>`)];

    return {
      tag: 'collapsible_panel',
      expanded: false,
      header: { title: { tag: 'plain_text', content: footerLine } },
      elements: panelElements,
    } as FeishuCardElement;
  }

  private shouldNestDoneButtons(
    phase: ProgressData['phase'],
    footerLine?: string,
  ): footerLine is string {
    return Boolean(footerLine) && (phase === 'completed' || phase === 'failed');
  }

  private md(content: string): FeishuCardElement {
    return mdElement(content);
  }

  // --- Override all formatting methods for Feishu Card format ---

  override formatStatus(chatId: string, data: StatusData): FeishuRenderedMessage {
    return this.createCardMessage(
      chatId,
      { template: 'blue', title: t(this.locale, 'format.titleStatus') },
      buildStatusElements(data, this.locale),
    );
  }

  protected override formatUptime(seconds: number): string {
    return formatFeishuUptime(this.locale, seconds);
  }

  override formatPermission(chatId: string, data: PermissionData): FeishuRenderedMessage {
    const elements = buildPermissionElements({ chatId, data, locale: this.locale });
    const buttons = permissionFormatButtons(data, this.locale);
    return this.createCardMessage(
      chatId,
      { template: 'orange', title: t(this.locale, 'format.titlePermission') },
      elements,
      buttons,
    );
  }

  override formatQuestion(chatId: string, data: QuestionData): FeishuRenderedMessage {
    const elements = buildQuestionElements({ chatId, data, locale: this.locale });
    return this.createCardMessage(
      chatId,
      { template: 'blue', title: t(this.locale, 'format.titleQuestion') },
      elements,
      undefined,
    );
  }

  override formatDeferredToolInput(
    chatId: string,
    data: DeferredToolInputData,
  ): FeishuRenderedMessage {
    const elements = buildDeferredToolElements({ chatId, data, locale: this.locale });
    return this.createCardMessage(
      chatId,
      { template: 'purple', title: t(this.locale, 'format.titleDeferredInput') },
      elements,
      undefined,
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

    return this.createCardMessage(chatId, { template, title: `${emoji} ${data.title}` }, elements);
  }

  override formatHome(chatId: string, data: HomeData): FeishuRenderedMessage {
    const elements = buildHomeElements({
      chatId,
      data,
      locale: this.locale,
      buildButtons: buildFeishuButtonElements,
    });
    const buttons = homeButtons(this.locale, data.providers?.available ?? []);
    return this.createCardMessage(
      chatId,
      { template: 'blue', title: t(this.locale, 'format.titleHome') },
      elements,
      buttons,
    );
  }

  override formatPermissionStatus(
    chatId: string,
    data: PermissionStatusData,
  ): FeishuRenderedMessage {
    const elements = buildPermStatusElements({ chatId, data, locale: this.locale });
    const buttons = permStatusButtonsForMode(data.mode, this.locale);
    return this.createCardMessage(
      chatId,
      {
        template: data.mode === 'on' ? 'orange' : 'grey',
        title: t(this.locale, 'format.titlePermissionStatus'),
      },
      elements,
      buttons,
    );
  }

  override formatTaskStart(chatId: string, data: TaskStartData): FeishuRenderedMessage {
    const title = data.isNewSession
      ? t(this.locale, 'format.titleTaskReset')
      : t(this.locale, 'format.titleTaskStart');
    const elements: FeishuCardElement[] = [
      this.md(
        `**${t(this.locale, 'format.labelCurrentConfig')}**\n${t(this.locale, 'format.labelDirectory')}：${data.cwd}\n${t(this.locale, 'home.labelPermission')}：${data.permissionMode === 'on' ? t(this.locale, 'perm.labelModeOn') : t(this.locale, 'perm.labelModeOff')}`,
      ),
    ];
    if (data.previousSessionPreview) {
      elements.push(
        this.md(
          `**${t(this.locale, 'format.labelPreviousSession')}**\n${truncate(data.previousSessionPreview, 100)}`,
        ),
      );
    }
    elements.push(this.md(t(this.locale, 'format.taskStartHint')));
    return this.createCardMessage(
      chatId,
      { template: 'blue', title },
      elements,
      taskStartButtons(this.locale),
    );
  }

  override formatTaskSummary(chatId: string, data: TaskSummaryData): FeishuRenderedMessage {
    const elements: FeishuCardElement[] = [
      this.md(`**${t(this.locale, 'format.labelResultSummary')}**\n${data.summary}`),
      this.md(
        `**${t(this.locale, 'taskSummary.labelResult')}**\n${t(this.locale, 'format.labelChangedFiles')}：${data.changedFiles}\n${t(this.locale, 'format.labelPermissionRequests')}：${data.permissionRequests}\n${t(this.locale, 'home.labelStatus')}：${data.hasError ? t(this.locale, 'taskSummary.statusError') : t(this.locale, 'taskSummary.statusDone')}`,
      ),
    ];
    const buttons = data.actionButtons ?? taskSummaryButtons(this.locale, this.getDoneButtons());
    if (data.footerLine) {
      elements.push(this.footerActionPanel(data.footerLine, buttons));
      return this.createCardMessage(
        chatId,
        {
          template: data.hasError ? 'red' : 'green',
          title: data.hasError
            ? t(this.locale, 'format.titleTaskEnd')
            : t(this.locale, 'format.titleTaskSummary'),
        },
        elements,
      );
    }
    return this.createCardMessage(
      chatId,
      {
        template: data.hasError ? 'red' : 'green',
        title: data.hasError
          ? t(this.locale, 'format.titleTaskEnd')
          : t(this.locale, 'format.titleTaskSummary'),
      },
      elements,
      buttons,
    );
  }

  override formatSessions(chatId: string, data: SessionsData): FeishuRenderedMessage {
    const showAll = data.showAll ?? false;
    const title = showAll
      ? t(this.locale, 'sessions.btnAll')
      : t(this.locale, 'sessions.btnRecent');

    return this.createCardMessage(
      chatId,
      { template: 'blue', title },
      buildSessionsElements(data, this.locale),
      undefined,
    );
  }

  override formatSessionDetail(chatId: string, data: SessionDetailData): FeishuRenderedMessage {
    return this.createCardMessage(
      chatId,
      { template: 'blue', title: `📋 ${t(this.locale, 'sessions.btnList')} #${data.index}` },
      buildSessionDetailElements(data, this.locale),
    );
  }

  override formatHelp(chatId: string, data: HelpData): FeishuRenderedMessage {
    return this.createCardMessage(
      chatId,
      { template: 'blue', title: t(this.locale, 'home.btnHelp') },
      buildHelpElements(data),
      data.actionButtons ?? helpButtons(this.locale),
    );
  }

  override formatNewSession(chatId: string, data: NewSessionData): FeishuRenderedMessage {
    const cwdLabel = data.cwd ? ` in \`${data.cwd}\`` : '';
    return this.createCardMessage(
      chatId,
      { template: 'green', title: t(this.locale, 'newSession.title') },
      [this.md(`${t(this.locale, 'newSession.title')}${cwdLabel}`)],
    );
  }

  override formatError(
    chatId: string,
    data: { title: string; message: string },
  ): FeishuRenderedMessage {
    return this.createCardMessage(chatId, { template: 'red', title: `❌ ${data.title}` }, [
      this.md(data.message),
    ]);
  }

  override formatProgress(chatId: string, data: ProgressData): FeishuRenderedMessage {
    const headerConfig = progressHeaderConfig(this.locale, data);
    const elements: FeishuCardElement[] = [];

    // Timeline elements
    elements.push(
      ...buildProgressTimelineElements({
        chatId,
        data,
        md: this.md.bind(this),
        locale: this.locale,
      }),
    );

    // Content elements (after timeline)
    elements.push(
      ...buildProgressContentElements({
        chatId,
        data,
        md: this.md.bind(this),
        locale: this.locale,
      }),
    );

    const buttons = data.actionButtons?.length
      ? data.actionButtons
      : this.defaultProgressButtons(data.phase);
    if (this.shouldNestDoneButtons(data.phase, data.footerLine)) {
      elements.push(this.footerActionPanel(data.footerLine, buttons));
      return this.createCardMessage(chatId, headerConfig, elements);
    }
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
      ? new Date(data.publishedAt).toLocaleDateString(this.locale === 'zh' ? 'zh-CN' : 'en-US', {
          month: 'short',
          day: 'numeric',
        })
      : '';
    const elements: FeishuCardElement[] = [
      this.md(
        `**${t(this.locale, 'version.title').replace('🔄 **', '').replace('**', '')}**\nv${data.current}`,
      ),
      this.md(`**${t(this.locale, 'version.released')}**\nv${data.latest}`),
    ];
    if (dateStr) {
      elements.push(this.md(`**${t(this.locale, 'version.released')}**\n${dateStr}`));
    }
    const buttons: Button[] = [
      {
        label: `⬆️ ${t(this.locale, 'home.labelSwitch')}`,
        callbackData: `cmd:upgrade confirm:${data.latest}`,
        style: 'primary',
      },
    ];
    return this.createCardMessage(
      chatId,
      { template: 'blue', title: t(this.locale, 'version.title') },
      elements,
      buttons,
    );
  }

  override formatMultiSelectToggle(
    chatId: string,
    data: MultiSelectToggleData,
  ): FeishuRenderedMessage {
    const elements = buildMultiSelectElements({ chatId, data, locale: this.locale });
    const buttons = buildMultiSelectButtons(data.permId, data.sessionId, data.options, this.locale);
    buttons.forEach((btn, idx) => {
      if (idx < data.options.length) {
        btn.label = `${data.selectedIndices.has(idx) ? '☑' : '☐'} ${data.options[idx].label}`;
      }
    });
    return this.createCardMessage(
      chatId,
      { template: 'blue', title: t(this.locale, 'format.titleQuestion') },
      elements,
      buttons,
    );
  }

  override formatQueueStatus(chatId: string, data: QueueStatusData): FeishuRenderedMessage {
    return this.createCardMessage(
      chatId,
      { template: data.depth > 0 ? 'yellow' : 'green', title: '📥 Queue Status' },
      buildQueueStatusElements(data),
    );
  }

  override formatDiagnose(chatId: string, data: DiagnoseData): FeishuRenderedMessage {
    const { elements, saturatedSessions } = buildDiagnoseElements(data);
    return this.createCardMessage(
      chatId,
      { template: saturatedSessions > 0 ? 'orange' : 'blue', title: '🩺 Diagnose' },
      elements,
    );
  }
}
