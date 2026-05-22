import type { Client } from '@larksuiteoapi/node-sdk';
import type { SendResult, ThreadStartResult } from '../types.js';
import type { BridgeError } from '../errors.js';
import { markdownToFeishu, downgradeHeadings } from './markdown.js';
import { buildFeishuCard, buildFeishuButtonElements } from './card-builder.js';
import type { FeishuCardElement } from './card-builder.js';
import type { FeishuRenderedMessage } from './types.js';
import { getFeishuUploadKey } from './buffers.js';
import { Logger } from '../../logger.js';

const FEISHU_PROGRESS_SPLIT_BYTES = 27 * 1024;

/** Shape of the Feishu message.create/reply API response */
interface FeishuCreateMessageResult {
  code?: number;
  msg?: string;
  data?: { message_id?: string; thread_id?: string };
}

type ClassifyError = (err: unknown) => BridgeError;

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

  try {
    const cardContent = buildCardForMessage(message, raw);
    const result = await sendMessageContent(client, message, 'interactive', cardContent);
    return { messageId: String(result?.data?.message_id ?? ''), success: true };
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

  try {
    await client.im.message.patch({
      path: { message_id: messageId },
      data: {
        content: message.feishuElements
          ? buildStructuredCardForMessage(message)
          : buildPlainCard(text, message.buttons, message.feishuHeader),
      },
    });
  } catch (err: any) {
    if (classifyError && isFeishuRateLimit(err)) {
      throw classifyError(err);
    }
    console.warn(`[feishu] editMessage failed: ${err?.message ?? err}`);
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

function buildPlainCard(
  text: string,
  buttons?: FeishuRenderedMessage['buttons'],
  header?: { template: string; title: string },
): string {
  const elements: FeishuCardElement[] = [{ tag: 'markdown', content: downgradeHeadings(text) }];
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
