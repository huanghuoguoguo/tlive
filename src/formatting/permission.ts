import type { ChannelType, OutboundMessage } from '../channels/types.js';
import type { PermissionCardData } from './types.js';
import { escapeHtml } from './escape.js';
import { truncate } from '../utils/string.js';

interface PermissionMessage {
  text?: string;
  html?: string;
  buttons?: OutboundMessage['buttons'];
  feishuElements?: OutboundMessage['feishuElements'];
  /** Feishu card header (caller passes to buildFeishuCard) */
  feishuHeader?: { template: string; title: string };
}

function makeButtons(permissionId: string): NonNullable<OutboundMessage['buttons']> {
  // Telegram enforces 64-byte callback_data limit; longest pattern is "perm:allow_session:ID"
  const maxIdBytes = 64 - Buffer.byteLength('perm:allow_session:', 'utf8');
  const safeId = Buffer.byteLength(permissionId, 'utf8') > maxIdBytes
    ? permissionId.slice(0, maxIdBytes)
    : permissionId;
  return [
    { label: '✅ Allow', callbackData: `perm:allow:${safeId}`, style: 'primary' as const, row: 0 },
    { label: '📌 Always', callbackData: `perm:allow_session:${safeId}`, style: 'default' as const, row: 0 },
    { label: '❌ Deny', callbackData: `perm:deny:${safeId}`, style: 'danger' as const, row: 1 },
  ];
}

export function formatPermissionCard(data: PermissionCardData, channelType: ChannelType): PermissionMessage {
  const input = truncate(data.toolInput, 300);
  const expires = data.expiresInMinutes ?? 5;
  const buttons = makeButtons(data.permissionId);

  switch (channelType) {
    case 'telegram': {
      const parts = [
        `\uD83D\uDD10 <b>Permission Required</b>`,
        '',
        `<b>Tool:</b> <code>${escapeHtml(data.toolName)}</code>`,
        `<pre>${escapeHtml(input)}</pre>`,
        '',
        `\u23F1 Expires in ${expires} minutes`,
      ];
      if (data.terminalUrl) {
        parts.push(`\uD83D\uDD17 <a href="${data.terminalUrl}">Open Terminal</a>`);
      }
      parts.push('', `💬 Or reply <b>allow</b> / <b>deny</b> / <b>always</b>`);
      return { html: parts.join('\n'), buttons };
    }

    case 'feishu': {
      const parts = [
        `**Tool:** ${data.toolName}`,
        `\`\`\`\n${input}\n\`\`\``,
        `\u23F1 Expires in ${expires} minutes`,
      ];
      if (data.terminalUrl) {
        parts.push(`\uD83D\uDD17 [Open Terminal](${data.terminalUrl})`);
      }
      parts.push('', '💬 回复 **allow** / **deny** / **always** 审批');
      return {
        text: parts.join('\n'),
        feishuElements: [
          { tag: 'markdown', content: `**待审批动作**\n${data.toolName}\n\n\`\`\`\n${input}\n\`\`\`\n\n⏱ ${expires} 分钟内处理` },
          ...(data.terminalUrl ? [{ tag: 'markdown', content: `🔗 [Open Terminal](${data.terminalUrl})` }] : []),
          { tag: 'markdown', content: '💬 也可以直接回复 **allow** / **deny** / **always**。' },
        ],
        feishuHeader: { template: 'orange', title: '\uD83D\uDD10 Permission Required' },
        buttons,
      };
    }

    case 'qqbot': {
      const parts = [
        `**\uD83D\uDD10 Permission Required**`,
        '',
        `**Tool:** \`${data.toolName}\``,
        '```',
        input,
        '```',
        '',
        `\u23F1 Expires in ${expires} minutes`,
      ];
      if (data.terminalUrl) {
        parts.push(`\uD83D\uDD17 [Open Terminal](${data.terminalUrl})`);
      }
      parts.push('', '💬 回复 **allow** / **deny** / **always**');
      return {
        text: parts.join('\n'),
      };
    }
  }
}
