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
import { downgradeHeadings, splitLargeTables } from './markdown.js';
import { actionCallback } from '../../core/callbacks.js';

const MAX_HOME_TOPICS = 2;
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

/** Shared helper for creating markdown elements with table handling */
export function mdElement(content: string): FeishuCardElement {
  return { tag: 'markdown', content: downgradeHeadings(splitLargeTables(content)) };
}

/** Shared helper for panel content */
export function mdPanel(content: string): { tag: string; content: string } {
  return { tag: 'markdown', content: downgradeHeadings(splitLargeTables(content)) };
}

export interface FormatHomeParams {
  chatId: string;
  data: HomeData;
  locale: Locale;
  buildButtons: (buttons: Button[]) => FeishuCardElement[];
}

export function buildHomeElements(params: FormatHomeParams): FeishuCardElement[] {
  const { data, locale, buildButtons } = params;
  const elements: FeishuCardElement[] = [];

  elements.push(
    mdElement(
      `**新会话默认工作区**\n\`${data.workspace.cwd}\`\n**新会话默认工具审批**\n${defaultPermissionLabel(data.permission.mode)}`,
    ),
  );
  elements.push(...buildNewSessionControls(data, locale, buildButtons));

  // Recent topic-backed conversations.
  if (data.session.topics?.length) {
    const topicPanelElements: FeishuCardElement[] = [];
    for (const topic of data.session.topics.slice(0, MAX_HOME_TOPICS)) {
      const status = topic.isActive ? '⏳ 执行中' : '✅ 可继续';
      const currentMark = topic.isCurrent ? ' ◀' : '';
      const sdkShort = topic.sdkSessionId ? topic.sdkSessionId.slice(0, 8) : '-';
      const providerLabel = topic.providerDisplayName ?? 'Agent';
      topicPanelElements.push(
        mdPanel(
          `**${topic.index}. ${status} ${truncate(topic.title, 36)}${currentMark}**\n${providerLabel} \`${sdkShort}\` · \`${topic.cwd}\` · ${topic.updatedAt}\n${truncate(topic.preview, 90)}`,
        ),
      );
      if (topic.sdkSessionId) {
        topicPanelElements.push(
          ...buildButtons([
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
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: { tag: 'plain_text', content: `💬 最近会话话题 (${data.session.topics.length})` },
      },
      elements: topicPanelElements,
    } as FeishuCardElement);
  }

  const recoverableSessions =
    data.session.recent
      ?.filter((session) => session.sdkSessionId && !session.topic)
      .slice(0, MAX_HISTORY_SESSIONS) ?? [];
  if (recoverableSessions.length) {
    const historyElements: FeishuCardElement[] = [];
    for (const session of recoverableSessions) {
      const providerLabel = session.providerDisplayName ?? 'Agent';
      const sdkShort = session.sdkSessionId ? session.sdkSessionId.slice(0, 8) : '-';
      historyElements.push(
        mdPanel(
          `**${session.index}. ${providerLabel} \`${sdkShort}\` · ${session.date}**\n\`${session.cwd}\`\n${truncate(session.preview, 80)}`,
        ),
      );
      if (session.sdkSessionId) {
        historyElements.push(
          ...buildButtons([
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
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: { title: { tag: 'plain_text', content: '🧭 本地历史会话' } },
      elements: historyElements,
    } as FeishuCardElement);
  }

  elements.push({
    tag: 'collapsible_panel',
    expanded: false,
    header: { title: { tag: 'plain_text', content: '🛠️ 诊断' } },
    elements: buildDiagnosticsControls(buildButtons),
  } as FeishuCardElement);
  elements.push(buildWorkbenchCommandForm(buildButtons));

  return elements;
}

export function homeButtons(
  _locale: Locale,
  _providers: readonly NewSessionButtonProvider[] = [],
): Button[] {
  return [];
}

function defaultPermissionLabel(mode: HomeData['permission']['mode']): string {
  return mode === 'on' ? '需要确认工具调用' : '自动允许工具调用';
}

function buildNewSessionControls(
  data: HomeData,
  locale: Locale,
  buildButtons: (buttons: Button[]) => FeishuCardElement[],
): FeishuCardElement[] {
  const nextPermMode = data.permission.mode === 'on' ? 'off' : 'on';
  const buttons: Button[] = [
    ...newSessionButtons(locale, data.providers?.available ?? [], 0),
    {
      label: data.permission.mode === 'on' ? '改为自动允许' : '改为需要确认',
      callbackData: actionCallback('perm', nextPermMode),
      row: 1,
    },
  ];

  return buildButtons(buttons);
}

function buildDiagnosticsControls(
  buildButtons: (buttons: Button[]) => FeishuCardElement[],
): FeishuCardElement[] {
  return buildButtons([
    { label: '状态', callbackData: actionCallback('status'), row: 0 },
    { label: '运行诊断', callbackData: actionCallback('diagnose'), row: 0 },
  ]);
}

function buildWorkbenchCommandForm(
  buildButtons: (buttons: Button[]) => FeishuCardElement[],
): FeishuCardElement {
  return {
    tag: 'form',
    name: 'form_tlive_command',
    elements: [
      {
        tag: 'input',
        name: '_tlive_command',
        placeholder: {
          tag: 'plain_text',
          content: '输入 TLive 命令，例如 cd /repo、bash pwd',
        },
        required: false,
      },
      ...buildButtons([
        { label: '执行', callbackData: 'form:tlive_command', style: 'primary', row: 0 },
      ]),
    ],
  } as FeishuCardElement;
}
