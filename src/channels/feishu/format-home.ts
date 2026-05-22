/**
 * Feishu home screen formatting - extracted from main formatter.
 */

import type { Locale } from '../../i18n/index.js';
import { t } from '../../i18n/index.js';
import type { FeishuCardElement } from './card-builder.js';
import type { HomeData } from '../../formatting/message-types.js';
import type { Button } from '../../ui/types.js';
import { newSessionButtons, type NewSessionButtonProvider } from '../../ui/buttons.js';
import { truncate } from '../../core/string.js';
import { actionCallback } from '../../core/callbacks.js';
import {
  buttonElements,
  collapsiblePanel,
  formElement,
  markdownElement,
} from './card-elements.js';

const MAX_HOME_TOPICS = 3;
const MAX_HISTORY_SESSIONS = 2;

/** Unified session status label for consistent display across /status and /home */
export function sessionStatusLabel(
  locale: Locale,
  isTurnActive: boolean,
  isAlive: boolean,
): { icon: string; text: string } {
  if (isTurnActive) return { icon: '⏳', text: t(locale, 'home.statusExecuting') };
  if (isAlive) return { icon: '🟢', text: t(locale, 'home.statusActive') };
  return { icon: '💤', text: t(locale, 'home.statusIdle') };
}

export interface FormatHomeParams {
  chatId: string;
  data: HomeData;
  locale: Locale;
}

export function buildHomeElements(params: FormatHomeParams): FeishuCardElement[] {
  const { data, locale } = params;
  const elements: FeishuCardElement[] = [];

  elements.push(
    markdownElement(
      `**新会话默认工作区**\n\`${data.workspace.cwd}\``,
    ),
  );
  elements.push(...buildNewSessionControls(data, locale));

  // Recent topic-backed conversations.
  if (data.session.topics?.length) {
    const topicPanelElements: FeishuCardElement[] = [];
    for (const topic of data.session.topics.slice(0, MAX_HOME_TOPICS)) {
      const status = topic.isActive ? '⏳ 执行中' : '✅ 可继续';
      const currentMark = topic.isCurrent ? ' ◀' : '';
      const sdkShort = topic.sdkSessionId ? topic.sdkSessionId.slice(0, 8) : '-';
      const providerLabel = topic.providerDisplayName ?? 'Agent';
      topicPanelElements.push(
        markdownElement(
          `**${topic.index}. ${status} ${truncate(topic.title, 36)}${currentMark}**\n${providerLabel} \`${sdkShort}\` · \`${topic.cwd}\` · ${topic.updatedAt}\n${truncate(topic.preview, 90)}`,
        ),
      );
      if (topic.sdkSessionId) {
        topicPanelElements.push(
          ...buttonElements([
            {
              label: '回到话题',
              callbackData: actionCallback(
                'continue',
                `${topic.provider ? `${topic.provider}:` : ''}${topic.sdkSessionId}`,
              ),
              style: topic.isCurrent ? 'default' : 'primary',
              row: 0,
            },
          ]),
        );
      }
    }
    elements.push(collapsiblePanel('💬 最近会话话题', topicPanelElements));
  }

  const recoverableHistorySessions =
    data.session.recent?.filter((session) => session.sdkSessionId && !session.topic) ?? [];
  const recoverableSessions = recoverableHistorySessions.slice(0, MAX_HISTORY_SESSIONS);
  if (recoverableSessions.length) {
    const historyElements: FeishuCardElement[] = [];
    for (const session of recoverableSessions) {
      const providerLabel = session.providerDisplayName ?? 'Agent';
      const sdkShort = session.sdkSessionId ? session.sdkSessionId.slice(0, 8) : '-';
      historyElements.push(
        markdownElement(
          `**${session.index}. ${providerLabel} \`${sdkShort}\` · ${session.date}**\n\`${session.cwd}\`\n${truncate(session.preview, 80)}`,
        ),
      );
      if (session.sdkSessionId) {
        historyElements.push(
          ...buttonElements([
            {
              label: '恢复到话题',
              callbackData: actionCallback(
                'continue',
                `${session.provider ? `${session.provider}:` : ''}${session.sdkSessionId}`,
              ),
              style: 'primary',
              row: 0,
            },
          ]),
        );
      }
    }
    elements.push(collapsiblePanel('🧭 最近本地会话', historyElements));
  }

  elements.push(collapsiblePanel('🛠️ 诊断', buildDiagnosticsControls()));
  elements.push(buildWorkbenchCommandForm());

  return elements;
}

export function homeButtons(
  _locale: Locale,
  _providers: readonly NewSessionButtonProvider[] = [],
): Button[] {
  return [];
}

function buildNewSessionControls(
  data: HomeData,
  locale: Locale,
): FeishuCardElement[] {
  const buttons: Button[] = [
    ...newSessionButtons(locale, data.providers?.available ?? [], 0),
    {
      label: '查看最近会话',
      callbackData: actionCallback('home-topics'),
      row: 1,
    },
    {
      label: '查看本地历史',
      callbackData: actionCallback('home-history'),
      row: 1,
    },
  ];

  return buttonElements(buttons);
}

function buildDiagnosticsControls(): FeishuCardElement[] {
  return buttonElements([
    { label: 'Bridge 状态', callbackData: actionCallback('status'), row: 0 },
    { label: '内部诊断', callbackData: actionCallback('diagnose'), row: 0 },
  ]);
}

function buildWorkbenchCommandForm(): FeishuCardElement {
  return formElement(
    'form_tlive_command',
    [
      {
        tag: 'input',
        name: '_tlive_command',
        placeholder: {
          tag: 'plain_text',
          content: '输入 TLive 命令，例如 cd /repo、bash pwd',
        },
        required: false,
      },
    ],
    [{ label: '执行', callbackData: 'form:tlive_command', style: 'primary', row: 0 }],
  );
}
