import type { StatusData } from '../../formatting/message-types.js';
import { t, type Locale } from '../../i18n/index.js';
import type { FeishuCardElement } from './card-builder.js';
import { mdElement, mdPanel, sessionStatusLabel } from './format-home.js';

export function formatFeishuUptime(locale: Locale, seconds: number): string {
  if (seconds < 60) return `${seconds}${t(locale, 'format.seconds')}`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}${t(locale, 'format.minutes')}`;
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}${t(locale, 'format.hours')}${mins}${t(locale, 'format.minutes')}`;
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return `${days}${t(locale, 'format.days')}${hours}${t(locale, 'format.hours')}`;
}

function formatElapsed(locale: Locale, ms: number): string {
  return formatFeishuUptime(locale, Math.floor(ms / 1000));
}

export function buildStatusElements(data: StatusData, locale: Locale): FeishuCardElement[] {
  const status = data.healthy
    ? `🟢 ${t(locale, 'format.statusRunning')}`
    : `🔴 ${t(locale, 'format.statusDisconnected')}`;
  const channelDetails =
    data.channelInfo?.map((ch) => {
      if (ch.name) return `${ch.type} (@${ch.name})`;
      if (ch.id) return `${ch.type} (${ch.id})`;
      return ch.type;
    }) || data.channels;

  const elements: FeishuCardElement[] = [
    mdElement(`**${t(locale, 'format.labelStatus')}**\n${status}`),
    mdElement(
      `**${t(locale, 'format.labelChannel')}**\n${channelDetails.join('\n') || t(locale, 'home.labelNone')}`,
    ),
  ];

  if (data.activeSessions !== undefined) {
    const total = (data.activeSessions || 0) + (data.idleSessions || 0);
    const sessionHeader =
      `${data.activeSessions} ${t(locale, 'format.statusActive')}` +
      (data.idleSessions ? ` / ${data.idleSessions} ${t(locale, 'format.statusIdle')}` : '') +
      ` (${t(locale, 'format.statusTotal')} ${total})`;

    if (data.sessionSnapshots?.length) {
      const now = Date.now();
      const lines = data.sessionSnapshots.map((s) => {
        const { icon: stateIcon, text: stateText } = sessionStatusLabel(
          locale,
          s.isTurnActive,
          s.isAlive,
        );
        const ago = formatElapsed(locale, now - s.lastActiveAt);
        const dir = s.workdir.replace(/^\/home\/[^/]+\//, '~/');
        const sid = s.sessionKey.length > 12 ? `…${s.sessionKey.slice(-8)}` : s.sessionKey;
        return `${stateIcon} **${stateText}** \`${sid}\`\n📁 \`${dir}\` · ${ago}${t(locale, 'format.activeAgo')}`;
      });
      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: {
          title: {
            tag: 'plain_text',
            content: `📡 ${t(locale, 'format.labelSession')} ${sessionHeader}`,
          },
        },
        elements: [mdPanel(lines.join('\n\n'))],
      } as FeishuCardElement);
    } else {
      elements.push(mdElement(`**${t(locale, 'format.labelSession')}**\n${sessionHeader}`));
    }
  }

  if (data.memoryUsage) {
    elements.push(mdElement(`**${t(locale, 'format.labelMemory')}**\n${data.memoryUsage}`));
  }
  if (data.uptimeSeconds !== undefined) {
    elements.push(
      mdElement(`**${t(locale, 'format.labelUptime')}**\n${formatFeishuUptime(locale, data.uptimeSeconds)}`),
    );
  }
  if (data.version) {
    elements.push(mdElement(`**${t(locale, 'format.labelVersion')}**\n\`v${data.version}\``));
  }
  if (data.cwd) {
    elements.push(mdElement(`**${t(locale, 'format.labelDirectory')}**\n\`${data.cwd}\``));
  }

  return elements;
}
