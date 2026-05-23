import type { StatusData } from '../../formatting/message-types.js';
import { t, type Locale } from '../../i18n/index.js';
import type { FeishuCardElement } from './card-builder.js';
import { collapsiblePanel, markdownElement } from './card-elements.js';
import { sessionStatusLabel } from './format-home.js';

function formatFeishuUptime(_locale: Locale, seconds: number): string {
  if (seconds < 60) return `${seconds}${t('format.seconds')}`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}${t('format.minutes')}`;
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}${t('format.hours')}${mins}${t('format.minutes')}`;
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return `${days}${t('format.days')}${hours}${t('format.hours')}`;
}

function formatElapsed(locale: Locale, ms: number): string {
  return formatFeishuUptime(locale, Math.floor(ms / 1000));
}

export function buildStatusElements(data: StatusData, locale: Locale): FeishuCardElement[] {
  const status = data.healthy
    ? `🟢 ${t('format.statusRunning')}`
    : `🔴 ${t('format.statusDisconnected')}`;
  const channelDetails =
    data.channelInfo?.map((ch) => {
      if (ch.name) return `${ch.type} (@${ch.name})`;
      if (ch.appId) return `${ch.type} (${ch.appId})`;
      return ch.type;
    }) || data.channels;

  const elements: FeishuCardElement[] = [
    markdownElement(`**${t('format.labelStatus')}**\n${status}`),
    markdownElement(
      `**${t('format.labelChannel')}**\n${channelDetails.join('\n') || t('home.labelNone')}`,
    ),
  ];

  if (data.activeSessions !== undefined) {
    const total = (data.activeSessions || 0) + (data.idleSessions || 0);
    const sessionHeader =
      `${data.activeSessions} ${t('format.statusActive')}` +
      (data.idleSessions ? ` / ${data.idleSessions} ${t('format.statusIdle')}` : '') +
      ` (${t('format.statusTotal')} ${total})`;

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
        return `${stateIcon} **${stateText}** \`${sid}\`\n📁 \`${dir}\` · ${ago}${t('format.activeAgo')}`;
      });
      elements.push(
        collapsiblePanel(`📡 ${t('format.labelSession')} ${sessionHeader}`, [
          markdownElement(lines.join('\n\n')),
        ]),
      );
    } else {
      elements.push(markdownElement(`**${t('format.labelSession')}**\n${sessionHeader}`));
    }
  }

  if (data.memoryUsage) {
    elements.push(markdownElement(`**${t('format.labelMemory')}**\n${data.memoryUsage}`));
  }
  if (data.uptimeSeconds !== undefined) {
    elements.push(
      markdownElement(
        `**${t('format.labelUptime')}**\n${formatFeishuUptime(locale, data.uptimeSeconds)}`,
      ),
    );
  }
  if (data.version) {
    elements.push(markdownElement(`**${t('format.labelVersion')}**\n\`v${data.version}\``));
  }
  if (data.cwd) {
    elements.push(markdownElement(`**${t('format.labelDirectory')}**\n\`${data.cwd}\``));
  }

  return elements;
}
