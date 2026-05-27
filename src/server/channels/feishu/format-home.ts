/**
 * Feishu home screen formatting - extracted from main formatter.
 */

import type { Locale } from '../../../shared/i18n/index.js';
import { t } from '../../../shared/i18n/index.js';
import type { FeishuCardElement } from './card-builder.js';
import type {
  HomeClientEntry,
  HomeData,
  HomeSessionEntry,
  HomeTopicEntry,
} from '../../../shared/formatting/message-types.js';
import type { Button } from '../../../shared/ui/types.js';
import type { NewSessionButtonProvider } from '../../../shared/ui/buttons.js';
import { truncate } from '../../../shared/core/string.js';
import { actionCallback } from '../../../shared/core/callbacks.js';
import {
  buttonElements,
  collapsiblePanel,
  markdownElement,
} from './card-elements.js';

const MAX_HOME_TOPICS = 3;
const MAX_HISTORY_SESSIONS = 2;

/** Unified session status label for consistent display across /status and /home */
export function sessionStatusLabel(
  _locale: Locale,
  isTurnActive: boolean,
  isAlive: boolean,
): { icon: string; text: string } {
  if (isTurnActive) return { icon: '⏳', text: t('home.statusExecuting') };
  if (isAlive) return { icon: '🟢', text: t('home.statusActive') };
  return { icon: '💤', text: t('home.statusIdle') };
}

export interface FormatHomeParams {
  chatId: string;
  data: HomeData;
  locale: Locale;
}

export function buildHomeElements(params: FormatHomeParams): FeishuCardElement[] {
  const { data } = params;
  const elements: FeishuCardElement[] = [];

  elements.push(
    markdownElement(
      `**工作台**\n默认执行节点: ${data.clients?.defaultClientId ? `\`${data.clients.defaultClientId}\`` : '未选择'}`,
    ),
  );
  elements.push(...buildClientControls(data));

  const recentPanelElements = buildRecentSessionControls(data);
  if (recentPanelElements.length) {
    elements.push(collapsiblePanel('💬 最近会话', recentPanelElements));
  }

  elements.push(collapsiblePanel('❔ 帮助', buildHelpControls()));

  return elements;
}

export function homeButtons(
  _locale: Locale,
  _providers: readonly NewSessionButtonProvider[] = [],
): Button[] {
  return [];
}

function buildClientControls(data: HomeData): FeishuCardElement[] {
  const clients = data.clients?.entries ?? [];
  if (!clients.length) {
    return [
      markdownElement('⚠️ 当前没有可用执行节点。请启动 `tlive client`。'),
    ];
  }

  const elements: FeishuCardElement[] = [];
  for (const client of clients) {
    const title = `${client.online ? '🟢' : '🔴'} ${client.name || client.clientId}${client.isDefault ? ' ◀' : ''}`;
    const workspace =
      client.workspaces.find((entry) => entry.isDefault)?.path ?? client.workspaces[0]?.path ?? '-';
    const providers = client.providers
      .filter((provider) => provider.available)
      .map((provider) => provider.displayName)
      .join(' / ') || 'none';
    const detailLines = [
      `ID: \`${client.clientId}\`${client.isLocal ? ' · local' : ''}`,
      client.note ? `备注: ${client.note}` : undefined,
      `Provider: ${providers}`,
      `默认目录: \`${workspace}\``,
      clientShortcutLine(client, workspace),
      client.activeTurns > 0 ? `运行中: ${client.activeTurns} 个任务` : undefined,
      client.version ? `版本: ${client.version}` : undefined,
    ].filter((line): line is string => Boolean(line));
    const body: FeishuCardElement[] = [
      markdownElement(detailLines.join('\n')),
    ];
    const leadingButtons: Button[] = [];
    if (!client.isDefault) {
      leadingButtons.push({
        label: '设为默认',
        callbackData: actionCallback('use', client.clientId),
        style: 'primary',
        row: 0,
      });
    }
    leadingButtons.push({
      label: '查看节点历史',
      callbackData: actionCallback('home-history', client.clientId),
      row: 0,
    });
    const newSessionRowOffset = leadingButtons.length ? 1 : 0;
    const buttons: Button[] = [
      ...leadingButtons,
      ...client.providers
        .filter((provider) => provider.available)
        .map((provider, index) => ({
          label: `新建 ${provider.displayName}`,
          callbackData: actionCallback('new', provider.kind, client.clientId),
          style: 'default' as const,
          row: Math.floor(index / 2) + newSessionRowOffset,
        })),
    ];
    body.push(...buttonElements(buttons));
    elements.push(collapsiblePanel(title, body));
  }

  return elements;
}

function buildRecentSessionControls(data: HomeData): FeishuCardElement[] {
  const elements: FeishuCardElement[] = [];
  const topicSdkSessionIds = new Set(
    (data.session.topics ?? [])
      .map((topic) => topic.sdkSessionId)
      .filter((id): id is string => Boolean(id)),
  );
  let index = 1;

  for (const topic of (data.session.topics ?? []).slice(0, MAX_HOME_TOPICS)) {
    elements.push(...topicSessionElements(topic, index++));
  }

  const recoverableSessions = (data.session.recent ?? [])
    .filter((session) => session.sdkSessionId && !topicSdkSessionIds.has(session.sdkSessionId))
    .slice(0, MAX_HISTORY_SESSIONS);
  for (const session of recoverableSessions) {
    elements.push(...historySessionElements(session, index++));
  }

  if (elements.length || data.session.recent?.some((session) => session.sdkSessionId)) {
    elements.push(...buttonElements([{ label: '更多', callbackData: actionCallback('home-history'), row: 0 }]));
  }

  return elements;
}

function topicSessionElements(topic: HomeTopicEntry, index: number): FeishuCardElement[] {
  const status = topic.isActive ? '⏳ 执行中' : '✅ 可继续';
  const currentMark = topic.isCurrent ? ' ◀' : '';
  const sdkShort = topic.sdkSessionId ? topic.sdkSessionId.slice(0, 8) : '-';
  const providerLabel = topic.providerDisplayName ?? 'Agent';
  const clientLabel = topic.clientId ? `\`${topic.clientId}\`` : '未记录';
  const elements = [
    markdownElement(
      `**${index}. ${status} ${truncate(topic.title, 36)}${currentMark}**\n节点: ${clientLabel} · ${providerLabel} \`${sdkShort}\` · \`${topic.cwd}\` · ${topic.updatedAt}\n${truncate(topic.preview, 90)}`,
    ),
  ];
  if (!topic.sdkSessionId) return elements;
  return [
    ...elements,
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
  ];
}

function historySessionElements(session: HomeSessionEntry, index: number): FeishuCardElement[] {
  const providerLabel = session.providerDisplayName ?? 'Agent';
  const sdkShort = session.sdkSessionId ? session.sdkSessionId.slice(0, 8) : '-';
  const elements = [
    markdownElement(
      `**${index}. ${providerLabel} \`${sdkShort}\` · ${session.date}**\n节点: \`${session.clientId ?? '-'}\` · \`${session.cwd}\`\n${truncate(session.preview, 80)}`,
    ),
  ];
  if (!session.sdkSessionId) return elements;
  return [
    ...elements,
    ...buttonElements([
      {
        label: session.topic ? '回到话题' : '恢复到话题',
        callbackData: actionCallback(
          'continue',
          `${session.provider ? `${session.provider}:` : ''}${session.sdkSessionId}`,
        ),
        style: session.isCurrent ? 'default' : 'primary',
        row: 0,
      },
    ]),
  ];
}

function clientShortcutLine(client: HomeClientEntry, defaultPath: string): string | undefined {
  const shortcuts = uniqueNonEmpty(
    client.workspaces.map((workspace) => workspace.path).filter((path) => path !== defaultPath),
  );
  if (!shortcuts.length) return undefined;
  return `快捷目录: ${shortcuts.map((path) => `\`${path}\``).join(' · ')}`;
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())))];
}

function buildHelpControls(): FeishuCardElement[] {
  return buttonElements([
    { label: '使用帮助', callbackData: actionCallback('help'), row: 0 },
    { label: 'Bridge 状态', callbackData: actionCallback('status'), row: 0 },
    { label: '内部诊断', callbackData: actionCallback('diagnose'), row: 1 },
  ]);
}
