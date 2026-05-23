import type { DiagnoseData } from '../../formatting/message-types.js';
import { t, type Locale } from '../../i18n/index.js';
import type { FeishuCardElement } from './card-builder.js';
import { markdownElement } from './card-elements.js';

export function buildDiagnoseElements(
  data: DiagnoseData,
  _locale: Locale,
): {
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
    `**${t('diagnose.labelSessions')}** ${t('format.statusActive')} ${data.activeSessions}, ${t('format.statusIdle')} ${data.idleSessions}`,
    `**${t('diagnose.labelQueuedMessages')}** ${data.totalQueuedMessages}`,
    `**${t('diagnose.labelProcessingChats')}** ${data.processingChats}`,
    `**${t('diagnose.labelBubbleMappings')}** ${data.totalBubbleMappings}`,
  ];
  if (data.persistedTopicSessions !== undefined) {
    const currentChat =
      data.persistedTopicSessionsInChat !== undefined
        ? ` (${t('diagnose.labelCurrentChat')} ${data.persistedTopicSessionsInChat})`
        : '';
    lines.push(
      `**${t('diagnose.labelPersistedTopicSessions')}** ${data.persistedTopicSessions}${currentChat}`,
    );
  }
  if (data.persistedBindings !== undefined) {
    lines.push(`**${t('diagnose.labelPersistedBindings')}** ${data.persistedBindings}`);
  }
  if (queueUtilizationRatio !== undefined) {
    lines.push(
      `**${t('diagnose.labelQueueUtilization')}** ${Math.round(queueUtilizationRatio * 100)}%`,
    );
  }
  if (saturatedSessions > 0) {
    lines.push(`**${t('diagnose.labelSaturatedSessions')}** ${saturatedSessions}`);
  }
  if (busiestSession) {
    lines.push(
      `**${t('diagnose.labelBusiestSession')}** ${busiestSession.depth}/${busiestSession.maxDepth}`,
    );
  }
  if (data.memoryUsage) {
    lines.push(`**${t('format.labelMemory')}** ${data.memoryUsage}`);
  }
  const elements: FeishuCardElement[] = [markdownElement(lines.join('\n'))];
  if (data.queueStats.length > 0) {
    elements.push(
      markdownElement(
        `**${t('diagnose.labelQueueDetail')}**\n${data.queueStats
          .map((stat) => `- \`${stat.sessionKey}\` ${stat.depth}/${stat.maxDepth}`)
          .join('\n')}`,
      ),
    );
  }
  return { elements, saturatedSessions };
}
