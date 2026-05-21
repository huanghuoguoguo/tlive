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

const MAX_HOME_TOPICS = 5;

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

  elements.push(mdElement(`**当前目录** \`${data.workspace.cwd}\``));

  elements.push({
    tag: 'collapsible_panel',
    expanded: false,
    header: { title: { tag: 'plain_text', content: '🧰 操作' } },
    elements: buildWorkbenchControlButtons(data, locale, buildButtons),
  } as FeishuCardElement);
  elements.push(buildWorkbenchCommandForm(buildButtons));

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
              label: '继续',
              callbackData: `cmd:continue ${topic.provider ? `${topic.provider}:` : ''}${topic.sdkSessionId}`,
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
        title: { tag: 'plain_text', content: `💬 最近对话 (${data.session.topics.length})` },
      },
      elements: topicPanelElements,
    } as FeishuCardElement);
  }

  return elements;
}

export function homeButtons(
  _locale: Locale,
  _providers: readonly NewSessionButtonProvider[] = [],
): Button[] {
  return [];
}

function buildWorkbenchControlButtons(
  data: HomeData,
  locale: Locale,
  buildButtons: (buttons: Button[]) => FeishuCardElement[],
): FeishuCardElement[] {
  const nextPermMode = data.permission.mode === 'on' ? 'off' : 'on';
  const buttons: Button[] = [
    { label: '状态', callbackData: 'cmd:status', row: 0 },
    { label: '会话', callbackData: 'cmd:session', row: 0 },
    { label: '目录', callbackData: 'cmd:pwd', row: 0 },
    {
      label: data.permission.mode === 'on' ? '权限关' : '权限开',
      callbackData: `cmd:perm ${nextPermMode}`,
      style: data.permission.mode === 'on' ? 'danger' : 'primary',
      row: 0,
    },
    ...newSessionButtons(locale, data.providers?.available ?? [], 1),
  ];

  return buildButtons(buttons);
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
          content: '输入 TLive 命令，例如 cd /repo、bash pwd、session --all',
        },
        required: false,
      },
      ...(buildButtons([
        { label: '执行', callbackData: 'form:tlive_command', style: 'primary', row: 0 },
      ]) as unknown as { tag: string; content: string }[]),
    ],
  } as FeishuCardElement;
}
