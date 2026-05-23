/**
 * Feishu message formatter - uses Card 2.0 JSON format.
 * Supports rich cards with headers, elements, and structured buttons.
 *
 * Main formatter delegates to specialized modules:
 * - format-home.ts: Home screen formatting
 * - format-interactions.ts: user input cards
 * - format-permission-status.ts: permission status card
 * - format-progress.ts: Progress/timeline formatting
 */

import type {
  MessageFormatter,
  MessageFormatterOptions,
} from '../../formatting/message-formatter.js';
import { t, type Locale } from '../../i18n/index.js';
import type { FeishuCardElement } from './card-builder.js';
import type { FeishuRenderedMessage } from './types.js';
import type {
  HomeData,
  PermissionStatusData,
  SessionListData,
  TaskStartData,
  HelpData,
  TopicCommandPaletteData,
  NewSessionData,
  ProgressData,
  TaskSummaryData,
  QuestionData,
  DeferredToolInputData,
  CardResolutionData,
  VersionUpdateData,
  MultiSelectToggleData,
  StatusData,
  DiagnoseData,
  FormattableMessage,
} from '../../formatting/message-types.js';
import type { Button } from '../../ui/types.js';
import {
  DEFAULT_DONE_BUTTONS,
  progressDoneButtons,
  progressRunningButtons,
  taskStartButtons,
  taskSummaryButtons,
  helpButtons,
  topicCommandPaletteButtons,
  type QuickButtonName,
} from '../../ui/buttons.js';
import { truncate } from '../../core/string.js';

// Import specialized formatters
import { buildHomeElements, homeButtons } from './format-home.js';
import {
  buildQuestionElements,
  buildDeferredToolElements,
  buildMultiSelectElements,
  buildMultiSelectButtons,
} from './format-interactions.js';
import { buildPermStatusElements, permStatusButtonsForMode } from './format-permission-status.js';
import {
  buildProgressTimelineElements,
  buildProgressContentElements,
  progressHeaderConfig,
} from './format-progress.js';
import { buildStatusElements } from './format-status.js';
import { actionCallback } from '../../core/callbacks.js';
import { buildHelpElements } from './format-help.js';
import { buildDiagnoseElements } from './format-diagnostics.js';
import { buildSessionListElements } from './format-session-list.js';
import { buttonElements, collapsiblePanel, markdownElement } from './card-elements.js';

export class FeishuFormatter implements MessageFormatter<FeishuRenderedMessage> {
  constructor(
    private readonly locale: Locale = 'zh',
    private readonly options: MessageFormatterOptions = {},
  ) {}

  getLocale(): Locale {
    return this.locale;
  }

  format(msg: FormattableMessage): FeishuRenderedMessage {
    const { type, chatId } = msg;
    switch (type) {
      case 'status':
        return this.formatStatus(chatId, msg.data);
      case 'question':
        return this.formatQuestion(chatId, msg.data);
      case 'deferredToolInput':
        return this.formatDeferredToolInput(chatId, msg.data);
      case 'home':
        return this.formatHome(chatId, msg.data);
      case 'permissionStatus':
        return this.formatPermissionStatus(chatId, msg.data);
      case 'taskStart':
        return this.formatTaskStart(chatId, msg.data);
      case 'help':
        return this.formatHelp(chatId, msg.data);
      case 'sessionList':
        return this.formatSessionList(chatId, msg.data);
      case 'topicCommandPalette':
        return this.formatTopicCommandPalette(chatId, msg.data);
      case 'newSession':
        return this.formatNewSession(chatId, msg.data);
      case 'error':
        return this.formatError(chatId, msg.data);
      case 'progress':
        return this.formatProgress(chatId, msg.data);
      case 'taskSummary':
        return this.formatTaskSummary(chatId, msg.data);
      case 'cardResolution':
        return this.formatCardResolution(chatId, msg.data);
      case 'versionUpdate':
        return this.formatVersionUpdate(chatId, msg.data);
      case 'multiSelectToggle':
        return this.formatMultiSelectToggle(chatId, msg.data);
      case 'diagnose':
        return this.formatDiagnose(chatId, msg.data);
    }
  }

  formatContent(chatId: string, content: string, buttons?: Button[]): FeishuRenderedMessage {
    return this.createMessage(chatId, content, buttons);
  }

  private createMessage(chatId: string, text: string, buttons?: Button[]): FeishuRenderedMessage {
    const msg: FeishuRenderedMessage = { chatId, text };
    if (buttons) {
      msg.buttons = buttons;
    }
    return msg;
  }

  private createCardMessage(
    chatId: string,
    header: { template: string; title: string },
    elements: FeishuCardElement[],
    buttons?: Button[],
  ): FeishuRenderedMessage {
    const allElements = [...elements];
    if (buttons && buttons.length > 0) {
      allElements.push(...buttonElements(buttons));
    }
    return {
      chatId,
      text: '',
      feishuHeader: header,
      feishuElements: allElements,
    };
  }

  private footerActionPanel(footerLine: string, buttons: Button[]): FeishuCardElement {
    return collapsiblePanel(t('formatter.runInfo'), [
      this.md(`<font color='grey'>${footerLine}</font>`),
      ...buttonElements(buttons),
    ]);
  }

  private shouldNestDoneButtons(
    phase: ProgressData['phase'],
    footerLine?: string,
  ): footerLine is string {
    return Boolean(footerLine) && (phase === 'completed' || phase === 'failed');
  }

  private md(content: string): FeishuCardElement {
    return markdownElement(content);
  }

  private defaultProgressButtons(phase: ProgressData['phase']): Button[] {
    if (phase === 'completed' || phase === 'failed') {
      return progressDoneButtons(this.locale, this.getDoneButtons());
    }
    return progressRunningButtons(this.locale);
  }

  private getDoneButtons(): readonly QuickButtonName[] {
    return this.options.doneButtons ?? DEFAULT_DONE_BUTTONS;
  }

  formatStatus(chatId: string, data: StatusData): FeishuRenderedMessage {
    return this.createCardMessage(
      chatId,
      { template: 'blue', title: t('format.titleStatus') },
      buildStatusElements(data, this.locale),
    );
  }

  formatQuestion(chatId: string, data: QuestionData): FeishuRenderedMessage {
    const elements = buildQuestionElements({ chatId, data, locale: this.locale });
    return this.createCardMessage(
      chatId,
      { template: 'blue', title: t('format.titleQuestion') },
      elements,
      undefined,
    );
  }

  formatDeferredToolInput(chatId: string, data: DeferredToolInputData): FeishuRenderedMessage {
    const elements = buildDeferredToolElements({ chatId, data, locale: this.locale });
    return this.createCardMessage(
      chatId,
      { template: 'purple', title: t('format.titleDeferredInput') },
      elements,
      undefined,
    );
  }

  formatHome(chatId: string, data: HomeData): FeishuRenderedMessage {
    const elements = buildHomeElements({
      chatId,
      data,
      locale: this.locale,
    });
    const buttons = homeButtons(this.locale, data.providers?.available ?? []);
    return this.createCardMessage(
      chatId,
      { template: 'blue', title: t('format.titleHome') },
      elements,
      buttons,
    );
  }

  formatPermissionStatus(chatId: string, data: PermissionStatusData): FeishuRenderedMessage {
    const elements = buildPermStatusElements({ chatId, data, locale: this.locale });
    const buttons = permStatusButtonsForMode(data.mode, this.locale, data.route);
    return this.createCardMessage(
      chatId,
      {
        template: data.mode === 'on' ? 'orange' : 'grey',
        title: t('format.titlePermissionStatus'),
      },
      elements,
      buttons,
    );
  }

  formatSessionList(chatId: string, data: SessionListData): FeishuRenderedMessage {
    return this.createCardMessage(
      chatId,
      { template: 'blue', title: data.title },
      buildSessionListElements(data),
    );
  }

  formatTaskStart(chatId: string, data: TaskStartData): FeishuRenderedMessage {
    const title = data.isNewSession
      ? t('format.titleTaskReset')
      : t('format.titleTaskStart');
    const elements: FeishuCardElement[] = [
      this.md(
        `**${t('format.labelCurrentConfig')}**\n${t('format.labelDirectory')}：${data.cwd}\n${t('home.labelPermission')}：${data.permissionMode === 'on' ? t('perm.labelModeOn') : t('perm.labelModeOff')}`,
      ),
    ];
    if (data.previousSessionPreview) {
      elements.push(
        this.md(
          `**${t('format.labelPreviousSession')}**\n${truncate(data.previousSessionPreview, 100)}`,
        ),
      );
    }
    elements.push(this.md(t('format.taskStartHint')));
    return this.createCardMessage(
      chatId,
      { template: 'blue', title },
      elements,
      taskStartButtons(this.locale),
    );
  }

  formatTaskSummary(chatId: string, data: TaskSummaryData): FeishuRenderedMessage {
    const elements: FeishuCardElement[] = [
      this.md(`**${t('format.labelResultSummary')}**\n${data.summary}`),
      this.md(
        `**${t('taskSummary.labelResult')}**\n${t('format.labelChangedFiles')}：${data.changedFiles}\n${t('format.labelPermissionRequests')}：${data.permissionRequests}\n${t('home.labelStatus')}：${data.hasError ? t('taskSummary.statusError') : t('taskSummary.statusDone')}`,
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
            ? t('format.titleTaskEnd')
            : t('format.titleTaskSummary'),
        },
        elements,
      );
    }
    return this.createCardMessage(
      chatId,
      {
        template: data.hasError ? 'red' : 'green',
        title: data.hasError
          ? t('format.titleTaskEnd')
          : t('format.titleTaskSummary'),
      },
      elements,
      buttons,
    );
  }

  formatHelp(chatId: string, data: HelpData): FeishuRenderedMessage {
    return this.createCardMessage(
      chatId,
      { template: 'blue', title: t('home.btnHelp') },
      buildHelpElements(data, this.locale),
      data.actionButtons ?? helpButtons(this.locale),
    );
  }

  formatTopicCommandPalette(chatId: string, data: TopicCommandPaletteData): FeishuRenderedMessage {
    const sdkSession = data.sdkSessionId
      ? data.sdkSessionId.slice(0, 8)
      : t('formatter.sessionNone');
    const status = data.isActive
      ? t('formatter.sessionRunningLabel')
      : t('formatter.sessionIdleLabel');
    const runtimeMode =
      data.capabilities.runtimeMode === 'interactive'
        ? t('formatter.interactiveMode')
        : t('formatter.turnBasedMode');
    const permissionStatus =
      data.permissionMode === 'on'
        ? t('formatter.toolApprovalRequired')
        : t('formatter.toolCallsAutoAllowed');
    const permissionLine = data.capabilities.interactivePermissions
      ? t('formatter.topicPermissionStatus').replace('{status}', permissionStatus)
      : data.provider === 'codex'
        ? t('formatter.codexPermissionNote')
        : '';
    const slashLine =
      data.provider === 'codex'
        ? t('formatter.codexSlashNote')
        : t('formatter.otherSlashPassThrough');
    const capabilityLabels = [
      data.capabilities.imageInputs ? t('formatter.imageInput') : undefined,
      data.capabilities.nativeSteer ? t('formatter.instantSteer') : undefined,
      data.capabilities.nativeQueue ? t('formatter.queueCapability') : undefined,
    ].filter(Boolean);

    const elements: FeishuCardElement[] = [
      this.md(
        `**${t('formatter.currentSession')}**\n${data.providerDisplayName} · ${runtimeMode} · \`${sdkSession}\` · ${status}`,
      ),
      this.md(`**${t('formatter.directory')}**\n\`${data.cwd}\``),
      this.md(
        `**${t('formatter.capabilities')}**\n${capabilityLabels.join(' · ') || t('formatter.basicChat')}`,
      ),
      this.md(`${slashLine}${permissionLine ? `\n${permissionLine}` : ''}`),
    ];

    return this.createCardMessage(
      chatId,
      { template: 'blue', title: t('formatter.sessionActions') },
      elements,
      topicCommandPaletteButtons(this.locale, {
        isActive: data.isActive,
        interactivePermissions: data.capabilities.interactivePermissions,
        route: data.route,
      }),
    );
  }

  formatNewSession(chatId: string, data: NewSessionData): FeishuRenderedMessage {
    const cwdLabel = data.cwd ? ` in \`${data.cwd}\`` : '';
    return this.createCardMessage(
      chatId,
      { template: 'green', title: t('newSession.title') },
      [this.md(`${t('newSession.title')}${cwdLabel}`)],
    );
  }

  formatError(chatId: string, data: { title: string; message: string }): FeishuRenderedMessage {
    return this.createCardMessage(chatId, { template: 'red', title: `❌ ${data.title}` }, [
      this.md(data.message),
    ]);
  }

  formatProgress(chatId: string, data: ProgressData): FeishuRenderedMessage {
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

    const buttons =
      data.actionButtons !== undefined
        ? data.actionButtons
        : this.defaultProgressButtons(data.phase);
    if (this.shouldNestDoneButtons(data.phase, data.footerLine)) {
      elements.push(this.footerActionPanel(data.footerLine, buttons));
      return this.createCardMessage(chatId, headerConfig, elements);
    }
    return this.createCardMessage(chatId, headerConfig, elements, buttons);
  }

  formatCardResolution(chatId: string, data: CardResolutionData): FeishuRenderedMessage {
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

  formatVersionUpdate(chatId: string, data: VersionUpdateData): FeishuRenderedMessage {
    const dateStr = data.publishedAt
      ? new Date(data.publishedAt).toLocaleDateString(this.locale === 'zh' ? 'zh-CN' : 'en-US', {
          month: 'short',
          day: 'numeric',
        })
      : '';
    const elements: FeishuCardElement[] = [
      this.md(
        `**${t('version.title').replace('🔄 **', '').replace('**', '')}**\nv${data.current}`,
      ),
      this.md(`**${t('version.released')}**\nv${data.latest}`),
    ];
    if (dateStr) {
      elements.push(this.md(`**${t('version.released')}**\n${dateStr}`));
    }
    const buttons: Button[] = [
      {
        label: `⬆️ ${t('home.labelSwitch')}`,
        callbackData: actionCallback('upgrade', `confirm:${data.latest}`),
        style: 'primary',
      },
    ];
    return this.createCardMessage(
      chatId,
      { template: 'blue', title: t('version.title') },
      elements,
      buttons,
    );
  }

  formatMultiSelectToggle(chatId: string, data: MultiSelectToggleData): FeishuRenderedMessage {
    const elements = buildMultiSelectElements({ chatId, data, locale: this.locale });
    const buttons = buildMultiSelectButtons(data.permId, data.sessionId, data.options, this.locale);
    buttons.forEach((btn, idx) => {
      if (idx < data.options.length) {
        btn.label = `${data.selectedIndices.has(idx) ? '☑' : '☐'} ${data.options[idx].label}`;
      }
    });
    return this.createCardMessage(
      chatId,
      { template: 'blue', title: t('format.titleQuestion') },
      elements,
      buttons,
    );
  }

  formatDiagnose(chatId: string, data: DiagnoseData): FeishuRenderedMessage {
    const { elements, saturatedSessions } = buildDiagnoseElements(data, this.locale);
    return this.createCardMessage(
      chatId,
      {
        template: saturatedSessions > 0 ? 'orange' : 'blue',
        title: t('format.titleDiagnose'),
      },
      elements,
    );
  }
}
