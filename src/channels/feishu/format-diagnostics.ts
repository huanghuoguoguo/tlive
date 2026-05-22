import type { DiagnoseData } from '../../formatting/message-types.js';
import { t, type Locale } from '../../i18n/index.js';
import type { FeishuCardElement } from './card-builder.js';
import { markdownElement } from './card-elements.js';

export function buildDiagnoseElements(data: DiagnoseData, locale: Locale): {
  elements: FeishuCardElement[];
  saturatedSessions: number;
} {
  const totalCapacity = data.queueStats.reduce((sum, stat) => sum + stat.maxDepth, 0);
  const totalDepth = data.queueStats.reduce((sum, stat) => sum + stat.depth, 0);
  const queueUtilizationRatio =
    data.queueUtilizationRatio ?? (totalCapacity > 0 ? totalDepth / totalCapacity : undefined);
  const saturatedSessions =
    data.saturatedSessions ?? data.queueStats.filter((stat) => stat.depth >= stat.maxDepth).length;
  const busiestSession =
    data.busiestSession ??
    (data.queueStats.length > 0
      ? data.queueStats.reduce((max, stat) => {
          const ratio = stat.maxDepth > 0 ? stat.depth / stat.maxDepth : 0;
          const maxRatio = max.maxDepth > 0 ? max.depth / max.maxDepth : 0;
          return ratio > maxRatio ? stat : max;
        }, data.queueStats[0])
      : undefined);
  const lines = [
    `**${t(locale, 'diagnose.labelSessions')}** ${t(locale, 'format.statusActive')} ${data.activeSessions}, ${t(locale, 'format.statusIdle')} ${data.idleSessions}`,
    `**${t(locale, 'diagnose.labelQueuedMessages')}** ${data.totalQueuedMessages}`,
    `**${t(locale, 'diagnose.labelProcessingChats')}** ${data.processingChats}`,
    `**${t(locale, 'diagnose.labelBubbleMappings')}** ${data.totalBubbleMappings}`,
  ];
  if (data.persistedTopicSessions !== undefined) {
    const currentChat =
      data.persistedTopicSessionsInChat !== undefined
        ? ` (${t(locale, 'diagnose.labelCurrentChat')} ${data.persistedTopicSessionsInChat})`
        : '';
    lines.push(
      `**${t(locale, 'diagnose.labelPersistedTopicSessions')}** ${data.persistedTopicSessions}${currentChat}`,
    );
  }
  if (data.persistedBindings !== undefined) {
    lines.push(`**${t(locale, 'diagnose.labelPersistedBindings')}** ${data.persistedBindings}`);
  }
  if (queueUtilizationRatio !== undefined) {
    lines.push(`**${t(locale, 'diagnose.labelQueueUtilization')}** ${Math.round(queueUtilizationRatio * 100)}%`);
  }
  if (saturatedSessions > 0) {
    lines.push(`**${t(locale, 'diagnose.labelSaturatedSessions')}** ${saturatedSessions}`);
  }
  if (busiestSession) {
    lines.push(`**${t(locale, 'diagnose.labelBusiestSession')}** ${busiestSession.depth}/${busiestSession.maxDepth}`);
  }
  if (data.memoryUsage) {
    lines.push(`**${t(locale, 'format.labelMemory')}** ${data.memoryUsage}`);
  }
  const elements: FeishuCardElement[] = [markdownElement(lines.join('\n'))];
  if (data.queueStats.length > 0) {
    elements.push(
      markdownElement(
        `**${t(locale, 'diagnose.labelQueueDetail')}**\n${data.queueStats
          .map((stat) => `- \`${stat.sessionKey}\` ${stat.depth}/${stat.maxDepth}`)
          .join('\n')}`,
      ),
    );
  }
  return { elements, saturatedSessions };
}
