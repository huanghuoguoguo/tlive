/**
 * Semantic message formatter dispatch.
 *
 * TLive only ships a Feishu renderer today. This base class owns the shared
 * dispatch/configuration surface, while concrete formatters own every rendered
 * card shape explicitly.
 */

import type { Button } from '../ui/types.js';
import {
  DEFAULT_DONE_BUTTONS,
  progressDoneButtons,
  progressRunningButtons,
  type QuickButtonName,
} from '../ui/buttons.js';
import type {
  StatusData,
  PermissionData,
  QuestionData,
  DeferredToolInputData,
  NotificationData,
  HomeData,
  PermissionStatusData,
  TaskStartData,
  SessionsData,
  SessionDetailData,
  HelpData,
  NewSessionData,
  ErrorData,
  ProgressData,
  TaskSummaryData,
  CardResolutionData,
  VersionUpdateData,
  MultiSelectToggleData,
  QueueStatusData,
  DiagnoseData,
  FormattableMessage,
} from './message-types.js';
import { t, type Locale, type TranslationKey } from '../i18n/index.js';

export interface MessageFormatterOptions {
  doneButtons?: readonly QuickButtonName[];
}

export abstract class MessageFormatter<TRendered extends { chatId: string }> {
  constructor(
    protected locale: Locale = 'en',
    protected options: MessageFormatterOptions = {},
  ) {}

  protected t(key: TranslationKey): string {
    return t(this.locale, key);
  }

  protected abstract createMessage(chatId: string, text: string, buttons?: Button[]): TRendered;

  getLocale(): Locale {
    return this.locale;
  }

  format(msg: FormattableMessage): TRendered {
    const { type, chatId } = msg;
    switch (type) {
      case 'status':
        return this.formatStatus(chatId, msg.data);
      case 'permission':
        return this.formatPermission(chatId, msg.data);
      case 'question':
        return this.formatQuestion(chatId, msg.data);
      case 'deferredToolInput':
        return this.formatDeferredToolInput(chatId, msg.data);
      case 'notification':
        return this.formatNotification(chatId, msg.data);
      case 'home':
        return this.formatHome(chatId, msg.data);
      case 'permissionStatus':
        return this.formatPermissionStatus(chatId, msg.data);
      case 'taskStart':
        return this.formatTaskStart(chatId, msg.data);
      case 'sessions':
        return this.formatSessions(chatId, msg.data);
      case 'sessionDetail':
        return this.formatSessionDetail(chatId, msg.data);
      case 'help':
        return this.formatHelp(chatId, msg.data);
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
      case 'queueStatus':
        return this.formatQueueStatus(chatId, msg.data);
      case 'diagnose':
        return this.formatDiagnose(chatId, msg.data);
      default:
        throw new Error(`Unknown message type: ${(msg as any).type}`);
    }
  }

  abstract formatStatus(chatId: string, data: StatusData): TRendered;
  abstract formatPermission(chatId: string, data: PermissionData): TRendered;
  abstract formatQuestion(chatId: string, data: QuestionData): TRendered;
  abstract formatDeferredToolInput(chatId: string, data: DeferredToolInputData): TRendered;
  abstract formatNotification(chatId: string, data: NotificationData): TRendered;
  abstract formatHome(chatId: string, data: HomeData): TRendered;
  abstract formatPermissionStatus(chatId: string, data: PermissionStatusData): TRendered;
  abstract formatTaskStart(chatId: string, data: TaskStartData): TRendered;
  abstract formatSessions(chatId: string, data: SessionsData): TRendered;
  abstract formatSessionDetail(chatId: string, data: SessionDetailData): TRendered;
  abstract formatHelp(chatId: string, data: HelpData): TRendered;
  abstract formatNewSession(chatId: string, data: NewSessionData): TRendered;
  abstract formatError(chatId: string, data: ErrorData): TRendered;
  abstract formatProgress(chatId: string, data: ProgressData): TRendered;
  abstract formatTaskSummary(chatId: string, data: TaskSummaryData): TRendered;
  abstract formatCardResolution(chatId: string, data: CardResolutionData): TRendered;
  abstract formatVersionUpdate(chatId: string, data: VersionUpdateData): TRendered;
  abstract formatMultiSelectToggle(chatId: string, data: MultiSelectToggleData): TRendered;
  abstract formatQueueStatus(chatId: string, data: QueueStatusData): TRendered;
  abstract formatDiagnose(chatId: string, data: DiagnoseData): TRendered;

  protected formatUptime(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) {
      const hours = Math.floor(seconds / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      return `${hours}h${mins}m`;
    }
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    return `${days}d${hours}h`;
  }

  protected defaultProgressButtons(phase: ProgressData['phase']): Button[] {
    if (phase === 'completed' || phase === 'failed') {
      return progressDoneButtons(this.locale, this.getDoneButtons());
    }
    return progressRunningButtons(this.locale);
  }

  protected getDoneButtons(): readonly QuickButtonName[] {
    return this.options.doneButtons ?? DEFAULT_DONE_BUTTONS;
  }

  formatContent(chatId: string, content: string, buttons?: Button[]): TRendered {
    return this.createMessage(chatId, content, buttons);
  }
}
