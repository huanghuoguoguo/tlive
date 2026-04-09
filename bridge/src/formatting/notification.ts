import type { ChannelType, OutboundMessage } from '../channels/types.js';
import type { NotificationData } from './types.js';
import { markdownToTelegram } from '../markdown/telegram.js';
import { downgradeHeadings } from '../markdown/feishu.js';
import { truncate } from '../utils/string.js';

interface NotificationMessage {
  text?: string;
  html?: string;
  buttons?: OutboundMessage['buttons'];
  feishuHeader?: { template: string; title: string };
  /** Feishu Card 2.0: structured elements for richer layout */
  feishuElements?: Array<Record<string, unknown>>;
}

const HEADER_MAP: Record<NotificationData['type'], string> = {
  stop: 'green',
  idle_prompt: 'yellow',
  generic: 'blue',
};

const EMOJI_MAP: Record<NotificationData['type'], string> = {
  stop: '✅',
  idle_prompt: '⏳',
  generic: '📢',
};

export function formatNotification(data: NotificationData, channelType: ChannelType): NotificationMessage {
  const summary = data.summary ? truncate(data.summary, 3000) : undefined;
  const emoji = EMOJI_MAP[data.type];

  switch (channelType) {
    case 'telegram': {
      // Build everything as markdown, then convert to Telegram HTML in one pass
      const mdParts = [`**${emoji} ${data.title}**`];
      if (summary) mdParts.push('', summary.slice(0, 3000));
      const result: NotificationMessage = {};
      if (data.terminalUrl) {
        const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/.test(data.terminalUrl);
        if (isLocalhost) {
          // localhost: Telegram URL buttons reject localhost, use inline markdown link
          mdParts.push('', `🔗 [Open Terminal](${data.terminalUrl})`);
        } else {
          // Public domain: use URL inline button (works with both http and https)
          result.buttons = [{ label: '🔗 Open Terminal', callbackData: '_', url: data.terminalUrl }];
        }
      }
      result.html = markdownToTelegram(mdParts.join('\n'));
      return result;
    }

    case 'feishu': {
      const elements: Array<Record<string, unknown>> = [];
      if (summary) {
        // Downgrade ## headings to bold — Card renders headings too large
        elements.push({ tag: 'markdown', content: downgradeHeadings(summary) });
      }
      if (data.terminalUrl) {
        elements.push({ tag: 'hr' });
        elements.push({
          tag: 'markdown',
          content: `<font color='grey'>🔗 [Open Terminal](${data.terminalUrl})</font>`,
        });
      }
      return {
        text: summary || '',
        feishuHeader: { template: HEADER_MAP[data.type], title: data.title ? `${emoji} ${data.title}` : emoji },
        feishuElements: elements,
      };
    }

    case 'qqbot': {
      const parts = [`**${emoji} ${data.title}**`];
      if (summary) parts.push('', summary.slice(0, 2000));
      if (data.terminalUrl) {
        parts.push('', `🔗 [Open Terminal](${data.terminalUrl})`);
      }
      return {
        text: parts.join('\n'),
      };
    }
  }
}
