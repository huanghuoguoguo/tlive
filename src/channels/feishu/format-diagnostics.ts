import { truncate } from '../../core/string.js';
import { AVERAGE_TURN_SECONDS } from '../../core/timing.js';
import type { DiagnoseData, QueueStatusData } from '../../formatting/message-types.js';
import type { FeishuCardElement } from './card-builder.js';
import { mdElement } from './format-home.js';

export function buildQueueStatusElements(data: QueueStatusData): FeishuCardElement[] {
  const saturationRatio = data.saturationRatio ?? (data.maxDepth > 0 ? data.depth / data.maxDepth : 0);
  const oldestQueuedAgeSeconds =
    data.oldestQueuedAgeSeconds ??
    (data.queuedMessages?.length
      ? Math.max(
          0,
          Math.floor((Date.now() - Math.min(...data.queuedMessages.map((item) => item.timestamp))) / 1000),
        )
      : undefined);
  const estimatedWaitSeconds =
    data.estimatedWaitSeconds ?? (data.depth > 0 ? data.depth * AVERAGE_TURN_SECONDS : undefined);
  const state =
    data.depth === 0
      ? '空闲'
      : saturationRatio >= 1
        ? '已满'
        : saturationRatio >= 0.8
          ? '偏高'
          : '正常';
  const lines = [
    `**Session** \`${data.sessionKey}\``,
    `**Depth** ${data.depth}/${data.maxDepth}`,
    `**State** ${state}`,
  ];
  if (oldestQueuedAgeSeconds !== undefined && data.depth > 0) {
    lines.push(`**Oldest queued** ${Math.ceil(oldestQueuedAgeSeconds / 60)} min ago`);
  }
  if (estimatedWaitSeconds && data.depth > 0) {
    lines.push(`**Estimated wait** ${Math.ceil(estimatedWaitSeconds / 60)} min`);
  }
  const elements: FeishuCardElement[] = [mdElement(lines.join('\n'))];
  if (data.queuedMessages?.length) {
    elements.push(
      mdElement(
        `**Queued messages**\n${data.queuedMessages
          .map((message, index) => `${index + 1}. ${truncate(message.preview, 80)}`)
          .join('\n')}`,
      ),
    );
  }
  return elements;
}

export function buildDiagnoseElements(data: DiagnoseData): {
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
    `**Sessions** active ${data.activeSessions}, idle ${data.idleSessions}`,
    `**Queued messages** ${data.totalQueuedMessages}`,
    `**Processing chats** ${data.processingChats}`,
    `**Bubble mappings** ${data.totalBubbleMappings}`,
  ];
  if (queueUtilizationRatio !== undefined) {
    lines.push(`**Queue utilization** ${Math.round(queueUtilizationRatio * 100)}%`);
  }
  if (saturatedSessions > 0) {
    lines.push(`**Saturated sessions** ${saturatedSessions}`);
  }
  if (busiestSession) {
    lines.push(`**Busiest session** ${busiestSession.depth}/${busiestSession.maxDepth}`);
  }
  if (data.memoryUsage) {
    lines.push(`**Memory** ${data.memoryUsage}`);
  }
  const elements: FeishuCardElement[] = [mdElement(lines.join('\n'))];
  if (data.queueStats.length > 0) {
    elements.push(
      mdElement(
        `**Queue detail**\n${data.queueStats
          .map((stat) => `- \`${stat.sessionKey}\` ${stat.depth}/${stat.maxDepth}`)
          .join('\n')}`,
      ),
    );
  }
  return { elements, saturatedSessions };
}

