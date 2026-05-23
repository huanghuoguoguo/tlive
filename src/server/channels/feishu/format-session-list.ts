import { actionCallback } from '../../../shared/core/callbacks.js';
import { truncate } from '../../../shared/core/string.js';
import type { SessionListData, SessionListEntry } from '../../../shared/formatting/message-types.js';
import type { Button } from '../../../shared/ui/types.js';
import type { FeishuCardElement } from './card-builder.js';
import type { Locale } from '../../../shared/i18n/index.js';
import { t } from '../../../shared/i18n/index.js';
import { buttonElements, collapsiblePanel, markdownElement } from './card-elements.js';

function sessionIdLabel(sessionId?: string): string {
  if (!sessionId) return '-';
  if (sessionId.length <= 14) return sessionId;
  return `${sessionId.slice(0, 8)}...${sessionId.slice(-4)}`;
}

function providerToken(entry: SessionListEntry): string {
  return `${entry.provider ? `${entry.provider}:` : ''}${entry.sdkSessionId ?? ''}`;
}

function panelTitle(entry: SessionListEntry, _locale: Locale): string {
  const provider = entry.providerDisplayName ?? 'Agent';
  const state = entry.isActive
    ? t('sessionList.stateRunning')
    : entry.isCurrent
      ? t('sessionList.stateCurrent')
      : t('sessionList.stateCanContinue');
  const subject = truncate(entry.title || entry.preview, 28);
  const client = entry.clientId ? ` · 节点 ${entry.clientId}` : '';
  return `${entry.index}. ${state} ${provider}${client} ${sessionIdLabel(entry.sdkSessionId)} · ${entry.date} · ${subject}`;
}

function transcriptPreview(entry: SessionListEntry, _locale: Locale): string {
  const transcript = entry.transcript ?? [];
  if (!transcript.length) return '';
  const lines = transcript.slice(-4).map((message) => {
    const role =
      message.role === 'assistant'
        ? t('sessionList.roleAssistant')
        : t('sessionList.roleUser');
    return `- ${role}: ${truncate(message.text, 110)}`;
  });
  return `\n\n${t('sessionList.recentMessages')}\n${lines.join('\n')}`;
}

function panelBody(entry: SessionListEntry, locale: Locale): string {
  const titleLine = entry.title
    ? `${t('sessionList.topic')}\n${truncate(entry.title, 120)}\n\n`
    : '';
  const clientLine = entry.clientId
    ? `${t('sessionList.executionNode')}\n\`${entry.clientId}\`\n\n`
    : '';
  return [
    `${titleLine}${clientLine}${t('sessionList.workspace')}\n\`${entry.cwd}\``,
    `${t('sessionList.preview')}\n${truncate(entry.preview, 220)}${transcriptPreview(entry, locale)}`,
  ].join('\n\n');
}

function entryButton(entry: SessionListEntry): Button[] {
  if (!entry.sdkSessionId) return [];
  return [
    {
      label: entry.actionLabel,
      callbackData: actionCallback('continue', providerToken(entry)),
      style: entry.actionStyle ?? 'primary',
    },
  ];
}

function sessionPanel(entry: SessionListEntry, locale: Locale): FeishuCardElement {
  return collapsiblePanel(panelTitle(entry, locale), [
    markdownElement(panelBody(entry, locale)),
    ...buttonElements(entryButton(entry)),
  ]);
}

export function buildSessionListElements(
  data: SessionListData,
  locale: Locale = 'zh',
): FeishuCardElement[] {
  if (!data.entries.length) {
    return [markdownElement(data.emptyText)];
  }
  return data.entries.map((entry) => sessionPanel(entry, locale));
}
