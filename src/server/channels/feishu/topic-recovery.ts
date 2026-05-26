import type { Client } from '@larksuiteoapi/node-sdk';
import type { PinnedTopicMetadata } from '../types.js';
import { findTliveTopicMetadata, type TliveTopicMetadata } from '../../../shared/topic-metadata.js';
import { Logger } from '../../../shared/logger.js';

interface FeishuPinItem {
  message_id?: string;
  chat_id?: string;
  create_time?: string;
}

interface FeishuMessageItem {
  message_id?: string;
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
  chat_id?: string;
  body?: {
    content?: string;
  };
}

export async function findPinnedFeishuTopicMetadata(
  client: Client | null,
  chatId: string,
  threadId: string,
): Promise<PinnedTopicMetadata | null> {
  if (!client) return null;

  let pageToken: string | undefined;
  try {
    do {
      const result = await client.im.pin.list({
        params: {
          chat_id: chatId,
          page_size: 50,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      const pins = (result?.data?.items ?? []) as FeishuPinItem[];
      for (const pin of pins) {
        if (!pin.message_id) continue;
        const message = await getFeishuMessage(client, pin.message_id);
        const metadata = extractFeishuMessageTopicMetadata(message?.body?.content);
        if (!message || !metadata) continue;
        const messageThreadId = message.thread_id || metadata.threadId;
        if (messageThreadId !== threadId) continue;
        if (message.chat_id && message.chat_id !== chatId) continue;

        return {
          chatId,
          threadId,
          messageId: message.message_id || pin.message_id,
          rootMessageId: message.root_id || message.message_id || metadata.rootMessageId,
          createTime: pin.create_time,
          metadata: {
            ...metadata,
            threadId: metadata.threadId || threadId,
            rootMessageId: metadata.rootMessageId || message.root_id || message.message_id,
            entryMessageId: metadata.entryMessageId || message.message_id || pin.message_id,
          },
        };
      }

      pageToken = result?.data?.has_more ? result.data.page_token : undefined;
    } while (pageToken);
  } catch (err) {
    console.warn(`[feishu] pinned topic metadata recovery failed: ${Logger.formatError(err)}`);
  }

  return null;
}

export function extractFeishuMessageTopicMetadata(
  rawContent: string | undefined,
): TliveTopicMetadata | undefined {
  if (!rawContent) return undefined;

  const direct = findTliveTopicMetadata(rawContent);
  if (direct) return direct;

  try {
    return findTliveTopicMetadata(JSON.parse(rawContent));
  } catch {
    return undefined;
  }
}

async function getFeishuMessage(
  client: Client,
  messageId: string,
): Promise<FeishuMessageItem | undefined> {
  const result = await client.im.message.get({
    path: { message_id: messageId },
  });
  return (result?.data?.items?.[0] ?? undefined) as FeishuMessageItem | undefined;
}
