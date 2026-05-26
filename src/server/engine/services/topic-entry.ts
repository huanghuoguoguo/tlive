import type { BaseChannelAdapter } from '../../channels/base.js';
import type { TopicSessionRecord } from '../state/topic-sessions.js';
import { shortPath } from '../../../shared/core/path.js';
import { normalizeAgentProviderKind } from '../../../shared/providers/kinds.js';

export function buildTopicEntryText(record: TopicSessionRecord): string {
  const provider = normalizeAgentProviderKind(record.provider);
  const title = record.title?.trim() || 'TLive 会话';
  const details = [
    `执行: ${provider}`,
    record.sdkSessionId ? `会话: ${record.sdkSessionId.slice(0, 8)}` : undefined,
    record.clientId ? `节点: ${record.clientId}` : undefined,
    record.cwd ? `目录: ${shortPath(record.cwd)}` : undefined,
  ].filter((part): part is string => !!part);

  return [`💬 ${title}`, details.join(' · '), '继续在本话题内发送消息。']
    .filter(Boolean)
    .join('\n\n');
}

export async function updateTopicEntryMessage(
  adapter: BaseChannelAdapter,
  record: TopicSessionRecord,
): Promise<void> {
  const messageId = record.entryMessageId;
  if (!messageId) return;

  await adapter
    .editMessage(
      record.chatId,
      messageId,
      adapter.formatContent(record.chatId, buildTopicEntryText(record)),
    )
    .catch((err) => {
      console.warn(`[topic-session] Failed to update pinned topic entry: ${err}`);
    });
}
