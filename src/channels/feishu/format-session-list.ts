import { actionCallback } from '../../core/callbacks.js';
import { truncate } from '../../core/string.js';
import type { SessionListData, SessionListEntry } from '../../formatting/message-types.js';
import type { Button } from '../../ui/types.js';
import type { FeishuCardElement } from './card-builder.js';
import { buttonElements, collapsiblePanel, markdownElement } from './card-elements.js';

function sessionIdLabel(sessionId?: string): string {
  if (!sessionId) return '-';
  if (sessionId.length <= 14) return sessionId;
  return `${sessionId.slice(0, 8)}...${sessionId.slice(-4)}`;
}

function providerToken(entry: SessionListEntry): string {
  return `${entry.provider ? `${entry.provider}:` : ''}${entry.sdkSessionId ?? ''}`;
}

function panelTitle(entry: SessionListEntry): string {
  const provider = entry.providerDisplayName ?? 'Agent';
  const state = entry.isActive ? '执行中' : entry.isCurrent ? '当前' : '可继续';
  const subject = truncate(entry.title || entry.preview, 28);
  return `${entry.index}. ${state} ${provider} ${sessionIdLabel(entry.sdkSessionId)} · ${entry.date} · ${subject}`;
}

function transcriptPreview(entry: SessionListEntry): string {
  const transcript = entry.transcript ?? [];
  if (!transcript.length) return '';
  const lines = transcript.slice(-4).map((message) => {
    const role = message.role === 'assistant' ? '助手' : '用户';
    return `- ${role}: ${truncate(message.text, 110)}`;
  });
  return `\n\n**最近消息**\n${lines.join('\n')}`;
}

function panelBody(entry: SessionListEntry): string {
  const titleLine = entry.title ? `**话题**\n${truncate(entry.title, 120)}\n\n` : '';
  return [
    `${titleLine}**工作区**\n\`${entry.cwd}\``,
    `**更新预览**\n${truncate(entry.preview, 220)}${transcriptPreview(entry)}`,
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

function sessionPanel(entry: SessionListEntry): FeishuCardElement {
  return collapsiblePanel(panelTitle(entry), [
    markdownElement(panelBody(entry)),
    ...buttonElements(entryButton(entry)),
  ]);
}

export function buildSessionListElements(data: SessionListData): FeishuCardElement[] {
  if (!data.entries.length) {
    return [markdownElement(data.emptyText)];
  }
  return data.entries.map(sessionPanel);
}
