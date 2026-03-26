import type { ChannelType, OutboundMessage } from '../channels/types.js';
import type { PermissionCardData } from './types.js';

interface PermissionMessage {
  text?: string;
  html?: string;
  embed?: OutboundMessage['embed'];
  buttons: OutboundMessage['buttons'];
  /** Feishu card header (caller passes to buildFeishuCard) */
  feishuHeader?: { template: string; title: string };
}

function truncateInput(input: string, max = 300): string {
  return input.length > max ? input.slice(0, max - 3) + '...' : input;
}

function makeButtons(permissionId: string): NonNullable<OutboundMessage['buttons']> {
  // Telegram enforces 64-byte callback_data limit; longest pattern is "perm:allow_session:ID"
  const maxIdBytes = 64 - Buffer.byteLength('perm:allow_session:', 'utf8');
  const safeId = Buffer.byteLength(permissionId, 'utf8') > maxIdBytes
    ? permissionId.slice(0, maxIdBytes)
    : permissionId;
  return [
    { label: '\u2705 Allow', callbackData: `perm:allow:${safeId}`, style: 'primary' as const },
    { label: '\uD83D\uDCCC Always', callbackData: `perm:allow_session:${safeId}`, style: 'default' as const },
    { label: '\u274C Deny', callbackData: `perm:deny:${safeId}`, style: 'danger' as const },
  ];
}

export function formatPermissionCard(data: PermissionCardData, channelType: ChannelType): PermissionMessage {
  const input = truncateInput(data.toolInput);
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
      parts.push('', `💬 Or reply <b>allow</b> / <b>deny</b>`);
      return { html: parts.join('\n'), buttons };
    }

    case 'discord': {
      const fields: Array<{ name: string; value: string; inline?: boolean }> = [
        { name: '🔧 Tool', value: `\`${data.toolName}\``, inline: true },
        { name: '⏱ Expires', value: `${expires} min`, inline: true },
      ];
      if (data.terminalUrl) {
        fields.push({ name: '🔗 Terminal', value: `[Open](${data.terminalUrl})`, inline: true });
      }
      return {
        embed: {
          title: '🔐 Permission Required',
          color: 0xFFA500,
          description: `\`\`\`\n${input}\n\`\`\`\n💬 Or reply \`allow\` / \`deny\``,
          fields,
        },
        buttons,
      };
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
      return {
        text: parts.join('\n'),
        feishuHeader: { template: 'orange', title: '\uD83D\uDD10 Permission Required' },
        buttons,
      };
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
