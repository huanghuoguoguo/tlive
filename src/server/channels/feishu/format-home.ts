/**
 * Feishu home screen formatting - extracted from main formatter.
 */

import type { Locale } from '../../../shared/i18n/index.js';
import { t } from '../../../shared/i18n/index.js';
import type { FeishuCardElement } from './card-builder.js';
import type { HomeData } from '../../../shared/formatting/message-types.js';
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
      `**工作台**\n默认执行节点: ${data.clients?.defaultClientId ? `\`${data.clients.defaultClientId}\`` : '未选择'} · 默认工作区: \`${data.workspace.cwd}\``,
    ),
  );
  elements.push(...buildClientControls(data));

  // Recent topic-backed conversations.
  if (data.session.topics?.length) {
    const topicPanelElements: FeishuCardElement[] = [];
    for (const topic of data.session.topics.slice(0, MAX_HOME_TOPICS)) {
      const status = topic.isActive ? '⏳ 执行中' : '✅ 可继续';
      const currentMark = topic.isCurrent ? ' ◀' : '';
      const sdkShort = topic.sdkSessionId ? topic.sdkSessionId.slice(0, 8) : '-';
      const providerLabel = topic.providerDisplayName ?? 'Agent';
      const clientLabel = topic.clientId ? `\`${topic.clientId}\`` : '未记录';
      topicPanelElements.push(
        markdownElement(
          `**${topic.index}. ${status} ${truncate(topic.title, 36)}${currentMark}**\n节点: ${clientLabel} · ${providerLabel} \`${sdkShort}\` · \`${topic.cwd}\` · ${topic.updatedAt}\n${truncate(topic.preview, 90)}`,
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
    data.session.recent?.filter((session) => session.sdkSessionId) ?? [];
  const recoverableSessions = recoverableHistorySessions.slice(0, MAX_HISTORY_SESSIONS);
  if (recoverableSessions.length) {
    const historyElements: FeishuCardElement[] = [];
    for (const session of recoverableSessions) {
      const providerLabel = session.providerDisplayName ?? 'Agent';
      const sdkShort = session.sdkSessionId ? session.sdkSessionId.slice(0, 8) : '-';
      historyElements.push(
        markdownElement(
          `**${session.index}. ${providerLabel} \`${sdkShort}\` · ${session.date}**\n节点: \`${session.clientId ?? '-'}\` · \`${session.cwd}\`\n${truncate(session.preview, 80)}`,
        ),
      );
      if (session.sdkSessionId) {
        historyElements.push(
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
        );
      }
    }
    elements.push(collapsiblePanel('🧭 最近会话', historyElements));
  }

  elements.push(collapsiblePanel('🛠️ 诊断', buildDiagnosticsControls()));

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
    const status = client.activeTurns > 0 ? `执行中 ${client.activeTurns}` : '空闲';
    const body: FeishuCardElement[] = [
      markdownElement(
        `ID: \`${client.clientId}\`${client.isLocal ? ' · local' : ''}\nProvider: ${providers}\n工作区: \`${workspace}\`\n状态: ${status}${client.version ? ` · ${client.version}` : ''}`,
      ),
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

  const buttons: Button[] = [
    {
      label: '查看最近会话',
      callbackData: actionCallback('home-history'),
      row: 0,
    },
  ];
  elements.push(...buttonElements(buttons));
  return elements;
}

function buildDiagnosticsControls(): FeishuCardElement[] {
  return buttonElements([
    { label: 'Bridge 状态', callbackData: actionCallback('status'), row: 0 },
    { label: '内部诊断', callbackData: actionCallback('diagnose'), row: 0 },
  ]);
}
