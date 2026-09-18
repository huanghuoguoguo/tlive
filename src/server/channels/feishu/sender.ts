import type { Client } from '@larksuiteoapi/node-sdk';
import type { SendResult, ThreadStartResult } from '../types.js';
import type { BridgeError } from '../errors.js';
import {
  markdownToFeishu,
  downgradeHeadings,
  splitLargeTables,
  splitByTableCount,
  countMarkdownTables,
  MAX_TABLES_PER_CARD,
} from './markdown.js';
import { buildFeishuCard, buildFeishuButtonElements } from './card-builder.js';
import type { FeishuCardElement } from './card-builder.js';
import type { FeishuRenderedMessage } from './types.js';
import { getFeishuUploadKey } from './buffers.js';
import { Logger } from '../../../shared/logger.js';
import {
  chunkByParagraph,
  chunkByParagraphBytes,
} from '../../../shared/formatting/text-chunk.js';

const FEISHU_PROGRESS_SPLIT_BYTES = 27 * 1024;
const FEISHU_STRUCTURED_CHUNK_BYTES = 16 * 1024;
const FEISHU_STRUCTURED_CARD_BYTES = 20 * 1024;
/**
 * 单个气泡的文本内容上限（字符数）。
 * 飞书实际限制约 30KB，但进度卡片包含大量元数据（thinking、tool logs、timeline）。
 * 保守设为 12KB，确保 JSON 包装后不超限。
 */
const FEISHU_CHUNK_LIMIT = 12000;

/** Shape of the Feishu message.create/reply API response */
interface FeishuCreateMessageResult {
  code?: number;
  msg?: string;
  data?: { message_id?: string; thread_id?: string };
}

type ClassifyError = (err: unknown) => BridgeError;

interface OverflowMessageState {
  messageIds: string[];
}

const overflowMessagesByClient = new WeakMap<object, Map<string, OverflowMessageState>>();
const MAX_TRACKED_OVERFLOW_ROOTS = 256;

function overflowMessageMap(client: Client): Map<string, OverflowMessageState> {
  let states = overflowMessagesByClient.get(client as object);
  if (!states) {
    states = new Map();
    overflowMessagesByClient.set(client as object, states);
  }
  return states;
}

function rememberOverflowMessages(client: Client, rootMessageId: string, messageIds: string[]): void {
  if (!rootMessageId) return;
  const states = overflowMessageMap(client);
  if (messageIds.length === 0) {
    states.delete(rootMessageId);
    return;
  }
  states.delete(rootMessageId);
  states.set(rootMessageId, { messageIds });
  while (states.size > MAX_TRACKED_OVERFLOW_ROOTS) {
    const oldestKey = states.keys().next().value;
    if (!oldestKey) break;
    states.delete(oldestKey);
  }
}

function isMissingReplyTarget(err: unknown): boolean {
  const code = (err as any)?.code;
  return code === 230011 || code === 231003;
}

function isThreadReplyUnsupported(err: unknown): boolean {
  return (err as any)?.code === 230071;
}

function isFeishuRateLimit(err: unknown): boolean {
  const e = err as Record<string, any>;
  const statusCode = e?.statusCode ?? e?.status ?? e?.response?.statusCode ?? e?.response?.status;
  return e?.code === 230020 || e?.code === 99991400 || statusCode === 429;
}

export async function sendFeishuMessage(
  client: Client,
  message: FeishuRenderedMessage,
  classifyError: ClassifyError,
): Promise<SendResult> {
  const raw = message.text ? message.text : markdownToFeishu(message.html ?? '');

  if (message.media) {
    try {
      return await sendMediaMessage(client, message);
    } catch (err) {
      console.warn(`[feishu] media send failed: ${Logger.formatError(err)}`);
      throw classifyError(err);
    }
  }

  if (message.feishuElements) {
    const elementChunks = splitStructuredCardElements(
      message.feishuElements as FeishuCardElement[],
    );
    const messageIds: string[] = [];
    for (let i = 0; i < elementChunks.length; i++) {
      try {
        const chunkMessage = { ...message, feishuElements: elementChunks[i] };
        const cardContent = buildStructuredCardForMessage(chunkMessage);
        const result = await sendMessageContent(client, chunkMessage, 'interactive', cardContent);
        messageIds.push(String(result?.data?.message_id ?? ''));
      } catch (err) {
        throw classifyError(err);
      }
    }
    const firstMessageId = messageIds[0] ?? '';
    rememberOverflowMessages(client, firstMessageId, messageIds.slice(1).filter(Boolean));
    return { messageId: firstMessageId, success: true };
  }

  // Split large tables before counting them: one source table may become several Feishu tables.
  const normalized = splitLargeTables(raw);
  const tableChunks = splitByTableCount(normalized);

  // Step 2: within each table chunk, apply paragraph-based chunking
  // 使用 FEISHU_CHUNK_LIMIT (20KB) 而非 25KB，为 JSON 包装预留空间
  const allChunks: string[] = [];
  for (const tc of tableChunks) {
    const paraChunks = chunkByParagraph(tc, FEISHU_CHUNK_LIMIT);
    allChunks.push(...paraChunks);
  }

  if (allChunks.length === 1) {
    try {
      const cardContent = buildCardForMessage(message, allChunks[0]);
      const result = await sendMessageContent(client, message, 'interactive', cardContent);
      return { messageId: String(result?.data?.message_id ?? ''), success: true };
    } catch (err) {
      throw classifyError(err);
    }
  }

  const firstMessageId = await sendSingleFeishuMessage(
    client,
    message,
    allChunks[0],
    classifyError,
  );
  const overflowMessageIds: string[] = [];
  for (let i = 1; i < allChunks.length; i++) {
    const hint = `**气泡 ${i + 1}/${allChunks.length}**\n`;
    overflowMessageIds.push(
      await sendSingleFeishuMessage(client, message, hint + allChunks[i], classifyError),
    );
  }
  rememberOverflowMessages(client, firstMessageId, overflowMessageIds.filter(Boolean));
  return { messageId: firstMessageId, success: true };
}

async function sendSingleFeishuMessage(
  client: Client,
  message: FeishuRenderedMessage,
  text: string,
  classifyError: ClassifyError,
): Promise<string> {
  try {
    const cardContent = buildCardForMessage(message, text);
    const result = await sendMessageContent(client, message, 'interactive', cardContent);
    return String(result?.data?.message_id ?? '');
  } catch (err) {
    throw classifyError(err);
  }
}

export async function editFeishuMessage(
  client: Client | null,
  messageId: string,
  message: FeishuRenderedMessage,
  classifyError?: ClassifyError,
): Promise<void> {
  if (!client) return;
  const text = message.text ? message.text : markdownToFeishu(message.html ?? '');

  if (message.feishuElements) {
    const elementChunks = splitStructuredCardElements(
      message.feishuElements as FeishuCardElement[],
    );
    const cardContents = elementChunks.map((feishuElements) =>
      buildStructuredCardForMessage({ ...message, feishuElements }),
    );
    await editFeishuMessageChunks(client, messageId, message, cardContents, classifyError);
    return;
  }

  const normalized = splitLargeTables(text);
  const tableChunks = splitByTableCount(normalized);

  // Step 2: within each table chunk, apply paragraph-based chunking
  // 使用 FEISHU_CHUNK_LIMIT (20KB) 而非 25KB，为 JSON 包装预留空间
  const allChunks: string[] = [];
  for (const tc of tableChunks) {
    const paraChunks = chunkByParagraph(tc, FEISHU_CHUNK_LIMIT);
    allChunks.push(...paraChunks);
  }

  const cardContents = allChunks.map((chunk, index) => {
    const hint = index === 0 ? '' : `**气泡 ${index + 1}/${allChunks.length}**\n`;
    return buildPlainCard(hint + chunk, message.buttons, message.feishuHeader);
  });
  await editFeishuMessageChunks(client, messageId, message, cardContents, classifyError);
}

async function editFeishuMessageChunks(
  client: Client,
  rootMessageId: string,
  message: FeishuRenderedMessage,
  cardContents: string[],
  classifyError?: ClassifyError,
): Promise<void> {
  const states = overflowMessageMap(client);
  const existingIds = states.get(rootMessageId)?.messageIds ?? [];
  const nextIds: string[] = [];
  let createdCount = 0;

  try {
    await client.im.message.patch({
      path: { message_id: rootMessageId },
      data: { content: cardContents[0] },
    });

    for (let i = 1; i < cardContents.length; i++) {
      const existingId = existingIds[i - 1];
      if (existingId) {
        await client.im.message.patch({
          path: { message_id: existingId },
          data: { content: cardContents[i] },
        });
        nextIds.push(existingId);
        continue;
      }

      const result = await sendMessageContent(client, message, 'interactive', cardContents[i]);
      const createdId = String(result?.data?.message_id ?? '');
      if (createdId) {
        nextIds.push(createdId);
        createdCount++;
      }
    }

    const staleIds = existingIds.slice(Math.max(0, cardContents.length - 1));
    for (const staleId of staleIds) {
      await client.im.message.delete({ path: { message_id: staleId } }).catch((deleteErr) => {
        console.warn(
          `[feishu] failed to remove stale overflow message ${staleId}: ${Logger.formatError(deleteErr)}`,
        );
      });
    }
    rememberOverflowMessages(client, rootMessageId, nextIds);
    if (createdCount > 0 || staleIds.length > 0) {
      console.log(
        `[feishu] overflow topology root=${rootMessageId.slice(-8)} chunks=${cardContents.length} reused=${nextIds.length - createdCount} created=${createdCount} removed=${staleIds.length}`,
      );
    }
  } catch (err: any) {
    if (nextIds.length > 0) rememberOverflowMessages(client, rootMessageId, nextIds);
    if (classifyError && isFeishuRateLimit(err)) throw classifyError(err);
    console.warn(`[feishu] editMessage failed: ${err?.message ?? err}`);
    throw classifyError ? classifyError(err) : err;
  }
}

export async function startFeishuThreadFromMessage(
  client: Client | null,
  options: {
    chatId: string;
    messageId: string;
    text: string;
    autoPinTopics: boolean;
    classifyError: ClassifyError;
  },
): Promise<ThreadStartResult | null> {
  if (!client) return null;
  try {
    const content = buildPlainCard(options.text);
    const result = (await client.im.message.reply({
      path: { message_id: options.messageId },
      data: {
        msg_type: 'interactive',
        content,
        reply_in_thread: true,
      },
    })) as FeishuCreateMessageResult;

    const threadId = result?.data?.thread_id;
    const replyMessageId = result?.data?.message_id;
    if (!threadId || !replyMessageId) {
      console.warn(
        `[feishu] startThreadFromMessage returned no thread_id for chat=${options.chatId.slice(-8)}`,
      );
      return null;
    }

    if (options.autoPinTopics) {
      await pinFeishuMessage(client, String(replyMessageId)).catch((pinErr) => {
        console.warn(`[feishu] auto pin topic failed (${(pinErr as any)?.code ?? 'unknown'})`);
      });
    }

    return {
      threadId: String(threadId),
      rootMessageId: options.messageId,
      messageId: String(replyMessageId),
    };
  } catch (err) {
    if (isThreadReplyUnsupported(err) || isMissingReplyTarget(err)) {
      console.warn(
        `[feishu] startThreadFromMessage unsupported (${(err as any)?.code ?? 'unknown'})`,
      );
      return null;
    }
    throw options.classifyError(err);
  }
}

export async function startFeishuThreadWithTitle(
  client: Client | null,
  options: {
    chatId: string;
    title: string;
    text: string;
    autoPinTopics: boolean;
    classifyError: ClassifyError;
  },
): Promise<ThreadStartResult | null> {
  if (!client) return null;
  const root = (await client.im.message.create({
    params: { receive_id_type: 'chat_id' as any },
    data: {
      receive_id: options.chatId,
      msg_type: 'text',
      content: JSON.stringify({ text: options.title }),
    },
  })) as FeishuCreateMessageResult;

  const rootMessageId = root?.data?.message_id;
  if (!rootMessageId) {
    console.warn(
      `[feishu] startThreadWithTitle returned no root message_id for chat=${options.chatId.slice(-8)}`,
    );
    return null;
  }

  const started = await startFeishuThreadFromMessage(client, {
    chatId: options.chatId,
    messageId: String(rootMessageId),
    text: options.text,
    autoPinTopics: options.autoPinTopics,
    classifyError: options.classifyError,
  });
  return started ? { ...started, rootMessageId: String(rootMessageId) } : null;
}

export async function publishFeishuTopicMetadata(
  client: Client | null,
  options: {
    rootMessageId: string;
    text: string;
    autoPinTopics: boolean;
    classifyError: ClassifyError;
  },
): Promise<string | null> {
  if (!client) return null;
  try {
    const result = (await client.im.message.reply({
      path: { message_id: options.rootMessageId },
      data: {
        msg_type: 'post',
        content: buildTopicMetadataPost(options.text),
        reply_in_thread: true,
      },
    })) as FeishuCreateMessageResult;
    const messageId = result?.data?.message_id;
    if (!messageId) return null;
    if (options.autoPinTopics) {
      await pinFeishuMessage(client, String(messageId)).catch((pinErr) => {
        console.warn(
          `[feishu] auto pin topic metadata failed (${(pinErr as any)?.code ?? 'unknown'})`,
        );
      });
    }
    return String(messageId);
  } catch (err) {
    throw options.classifyError(err);
  }
}

function buildTopicMetadataPost(text: string): string {
  const marker = text.match(/tlive-topic:[A-Za-z0-9_-]+/)?.[0] ?? text;
  return JSON.stringify({
    zh_cn: {
      title: 'TLive 会话索引',
      content: [
        [
          {
            tag: 'a',
            text: 'TLive 会话索引',
            href: `https://tlive.local/session#${marker}`,
          },
        ],
      ],
    },
  });
}

export async function pinFeishuMessage(client: Client | null, messageId: string): Promise<void> {
  if (!client) return;
  await client.im.pin.create({
    data: { message_id: messageId },
  });
}

export function shouldSplitFeishuProgressMessage(message: FeishuRenderedMessage): boolean {
  if (!message.feishuElements) return false;
  return (
    Buffer.byteLength(buildStructuredCardForMessage(message), 'utf8') >= FEISHU_PROGRESS_SPLIT_BYTES
  );
}

function buildCardForMessage(message: FeishuRenderedMessage, raw: string): string {
  return message.feishuElements
    ? buildStructuredCardForMessage(message)
    : buildPlainCard(raw, message.buttons, message.feishuHeader);
}

function buildStructuredCardForMessage(message: FeishuRenderedMessage): string {
  return buildFeishuCard({
    header: message.feishuHeader as any,
    elements: [
      ...(message.feishuElements as any),
      ...buildFeishuButtonElements(message.feishuButtons ?? message.buttons),
    ],
  });
}

function tableCountInElement(element: FeishuCardElement): number {
  let count = typeof element.content === 'string' ? countMarkdownTables(element.content) : 0;
  if (element.elements) {
    count += element.elements.reduce((total, child) => total + tableCountInElement(child), 0);
  }
  if (element.body?.elements) {
    count += element.body.elements.reduce(
      (total, child) => total + tableCountInElement(child),
      0,
    );
  }
  return count;
}

function splitElementByTableCount(element: FeishuCardElement): FeishuCardElement[] {
  if (typeof element.content === 'string') {
    const normalized = splitLargeTables(element.content);
    const contentChunks = splitByTableCount(normalized).flatMap((content) =>
      chunkByParagraphBytes(content, FEISHU_STRUCTURED_CHUNK_BYTES),
    );
    if (contentChunks.length > 1) {
      return contentChunks.map((content) => ({ ...element, content }));
    }
    element = { ...element, content: normalized };
  }

  if (element.elements) {
    const childChunks = splitStructuredCardElements(element.elements);
    if (childChunks.length > 1) {
      return childChunks.map((elements, index) => ({
        ...element,
        elements,
        ...(element.tag === 'collapsible_panel' && element.expanded === true
          ? { expanded: index === childChunks.length - 1 }
          : {}),
      }));
    }
    element = { ...element, elements: childChunks[0] };
  }

  if (element.body?.elements) {
    const bodyChunks = splitStructuredCardElements(element.body.elements);
    if (bodyChunks.length > 1) {
      return bodyChunks.map((elements, index) => ({
        ...element,
        body: { ...element.body, elements },
        ...(element.tag === 'collapsible_panel' && element.expanded === true
          ? { expanded: index === bodyChunks.length - 1 }
          : {}),
      }));
    }
    element = {
      ...element,
      body: { ...element.body, elements: bodyChunks[0] },
    };
  }

  return [element];
}

/** Split the final Card 2.0 element tree, including tables nested in panels. */
function splitStructuredCardElements(elements: FeishuCardElement[]): FeishuCardElement[][] {
  const expanded = elements.flatMap(splitElementByTableCount);
  if (expanded.length === 0) return [[]];

  const chunks: FeishuCardElement[][] = [];
  let current: FeishuCardElement[] = [];
  let currentTables = 0;
  let currentBytes = 0;

  for (const element of expanded) {
    const elementTables = tableCountInElement(element);
    const elementBytes = Buffer.byteLength(JSON.stringify(element), 'utf8');
    if (
      current.length > 0 &&
      ((elementTables > 0 && currentTables + elementTables > MAX_TABLES_PER_CARD) ||
        currentBytes + elementBytes > FEISHU_STRUCTURED_CARD_BYTES)
    ) {
      chunks.push(current);
      current = [];
      currentTables = 0;
      currentBytes = 0;
    }
    current.push(element);
    currentTables += elementTables;
    currentBytes += elementBytes;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

function buildPlainCard(
  text: string,
  buttons?: FeishuRenderedMessage['buttons'],
  header?: { template: string; title: string },
): string {
  const elements: FeishuCardElement[] = [{ tag: 'markdown', content: downgradeHeadings(splitLargeTables(text)) }];
  elements.push(...buildFeishuButtonElements(buttons));

  return buildFeishuCard({
    header: header as any,
    elements,
  });
}

async function sendMediaMessage(
  client: Client,
  message: FeishuRenderedMessage,
): Promise<SendResult> {
  const media = message.media;
  if (!media) throw new Error('No media attachment');

  const buffer = await mediaBuffer(media);
  if (media.type === 'image') {
    const uploadResult = await client.im.image.create({
      data: {
        image_type: 'message',
        image: buffer as any,
      },
    });
    const imageKey = getFeishuUploadKey(uploadResult, 'image_key');
    if (!imageKey) throw new Error('Feishu image upload returned no image_key');

    const result = await sendMessageContent(
      client,
      message,
      'image',
      JSON.stringify({ image_key: imageKey }),
    );
    return { messageId: String((result as any)?.data?.message_id ?? ''), success: true };
  }

  const uploadResult = await client.im.file.create({
    data: {
      file_type: 'stream',
      file_name: media.filename || 'file',
      file: buffer as any,
    },
  });
  const fileKey = getFeishuUploadKey(uploadResult, 'file_key');
  if (!fileKey) throw new Error('Feishu file upload returned no file_key');

  const result = await sendMessageContent(
    client,
    message,
    'file',
    JSON.stringify({ file_key: fileKey }),
  );
  return { messageId: String((result as any)?.data?.message_id ?? ''), success: true };
}

async function mediaBuffer(media: NonNullable<FeishuRenderedMessage['media']>): Promise<Buffer> {
  if (media.buffer) return media.buffer;
  if (media.url?.startsWith('data:')) {
    const base64 = media.url.split(',')[1];
    return Buffer.from(base64, 'base64');
  }
  if (media.url) {
    const resp = await fetch(media.url);
    return Buffer.from(await resp.arrayBuffer());
  }
  throw new Error('No media source');
}

async function sendMessageContent(
  client: Client,
  message: FeishuRenderedMessage,
  msgType: string,
  content: string,
): Promise<FeishuCreateMessageResult> {
  const idType = message.receiveIdType || 'chat_id';
  if (message.replyToMessageId && message.replyInThread) {
    try {
      return (await client.im.message.reply({
        path: { message_id: message.replyToMessageId },
        data: {
          msg_type: msgType,
          content,
          reply_in_thread: true,
        },
      })) as FeishuCreateMessageResult;
    } catch (replyErr) {
      if (!isThreadReplyUnsupported(replyErr) && !isMissingReplyTarget(replyErr)) {
        throw replyErr;
      }
      console.warn(
        `[feishu] reply_in_thread failed (${(replyErr as any)?.code ?? 'unknown'}), falling back to chat send`,
      );
    }
  }

  const data: Record<string, unknown> = {
    receive_id: message.chatId,
    msg_type: msgType,
    content,
  };
  if (message.replyToMessageId) data.root_id = message.replyToMessageId;

  try {
    return (await client.im.message.create({
      params: { receive_id_type: idType as any },
      data: data as any,
    })) as FeishuCreateMessageResult;
  } catch (createErr) {
    if (message.replyToMessageId && isMissingReplyTarget(createErr)) {
      delete data.root_id;
      return (await client.im.message.create({
        params: { receive_id_type: idType as any },
        data: data as any,
      })) as FeishuCreateMessageResult;
    }
    throw createErr;
  }
}
