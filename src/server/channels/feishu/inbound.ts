import { basename, extname } from 'node:path';
import type { FileAttachment, InboundMessage } from '../types.js';
import { chatScopeId } from '../../../shared/core/key.js';
import { readFeishuBuffer } from './buffers.js';

const MAX_INBOUND_ATTACHMENT_BYTES = 10_000_000;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.xml': 'application/xml',
  '.yaml': 'application/x-yaml',
  '.yml': 'application/x-yaml',
  '.toml': 'application/toml',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.cjs': 'application/javascript',
  '.ts': 'application/typescript',
  '.tsx': 'application/typescript',
  '.jsx': 'application/javascript',
  '.html': 'text/html',
  '.css': 'text/css',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
};

export interface FeishuInboundEventMessage {
  message_type?: string;
  content: string;
  chat_id: string;
  chat_type?: string;
  message_id: string;
  parent_id?: string;
  root_id?: string;
  thread_id?: string;
  mentions?: FeishuMention[];
}

export interface FeishuMessageReceiveEvent {
  sender?: { sender_id?: { user_id?: string; open_id?: string; union_id?: string } };
  message?: FeishuInboundEventMessage;
}

export interface FeishuInboundOptions {
  botOpenId?: string;
  botName?: string;
}

interface FeishuMention {
  key?: string;
  id?: { union_id?: string; user_id?: string; open_id?: string };
  name?: string;
}

type FeishuInboundClient = {
  im: {
    messageResource: { get(input: unknown): Promise<unknown> };
    image: { get(input: unknown): Promise<unknown> };
    v1: { messageResource: { get(input: unknown): Promise<unknown> } };
  };
};

interface RichFileRef {
  fileKey: string;
  name: string;
  mimeType?: string;
}

interface RichMessageContent {
  text: string;
  imageKeys: string[];
  files: RichFileRef[];
}

export async function feishuMessageEventToInbound(
  event: FeishuMessageReceiveEvent,
  client: FeishuInboundClient,
  options: FeishuInboundOptions = {},
): Promise<InboundMessage | undefined> {
  const msg = event?.message;
  if (!msg) return undefined;
  if (shouldIgnoreGroupMessage(msg, options)) return undefined;

  const senderId = event?.sender?.sender_id;
  const userId = senderId?.user_id || senderId?.open_id || '';
  const baseMessage = feishuInboundBase(msg, userId);

  if (msg.message_type === 'text') {
    const text = parseTextMessage(msg.content);
    return text ? { ...baseMessage, text } : undefined;
  }

  if (msg.message_type === 'image') {
    const imageKey = parseImageKey(msg.content);
    if (!imageKey) return undefined;
    const attachment = await downloadImageAttachment(client, msg.message_id, imageKey);
    return attachment ? { ...baseMessage, text: '', attachments: [attachment] } : undefined;
  }

  if (msg.message_type === 'file') {
    const content = parseJsonRecord(msg.content);
    if (!content) return undefined;
    const fileKey = typeof content.file_key === 'string' ? content.file_key : '';
    const fileName = safeAttachmentName(content.file_name ?? content.name, 'file');
    const attachment = await downloadFileAttachment(client, msg.message_id, fileKey, fileName, {
      mimeType: content.mime_type ?? content.mimetype,
    });
    return attachment ? { ...baseMessage, text: '', attachments: [attachment] } : undefined;
  }

  if (msg.message_type === 'post') {
    const richContent = extractRichMessageContent(msg.content);
    const attachments = await downloadRichAttachments(client, msg.message_id, richContent);
    if (!richContent.text && attachments.length === 0) return undefined;
    return {
      ...baseMessage,
      text: richContent.text,
      attachments: attachments.length > 0 ? attachments : undefined,
    };
  }

  return undefined;
}

export function feishuInboundScope(chatId: string, threadId?: string): string | undefined {
  return threadId ? chatScopeId(chatId, threadId) : undefined;
}

function feishuReplyTarget(
  messageId: string,
  rootId?: string,
  parentId?: string,
  threadId?: string,
): string | undefined {
  return threadId ? messageId : parentId || rootId || undefined;
}

function feishuInboundBase(
  msg: FeishuInboundEventMessage,
  userId: string,
): Omit<InboundMessage, 'text' | 'attachments' | 'callbackData'> {
  const threadId = msg.thread_id || undefined;
  return {
    channelType: 'feishu',
    chatId: msg.chat_id,
    scopeId: feishuInboundScope(msg.chat_id, threadId),
    threadId,
    threadRootMessageId: msg.root_id,
    threadParentMessageId: msg.parent_id,
    replyInThread: !!threadId,
    userId,
    messageId: msg.message_id,
    replyTargetMessageId: threadId ? msg.message_id : undefined,
    replyToMessageId: threadId
      ? undefined
      : feishuReplyTarget(msg.message_id, msg.root_id, msg.parent_id, threadId),
  };
}

function parseTextMessage(rawContent: string): string | undefined {
  const content = parseJsonRecord(rawContent);
  return content ? stripFeishuMentions(String(content.text ?? '')) : undefined;
}

function parseImageKey(rawContent: string): string | undefined {
  const content = parseJsonRecord(rawContent);
  return typeof content?.image_key === 'string' ? content.image_key : undefined;
}

function parseJsonRecord(rawContent: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(rawContent);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function shouldIgnoreGroupMessage(
  msg: FeishuInboundEventMessage,
  options: FeishuInboundOptions,
): boolean {
  if (!isGroupChatType(msg.chat_type)) return false;

  const mentions = msg.mentions ?? [];
  if (mentions.length === 0) return true;

  const botOpenId = options.botOpenId?.trim();
  if (botOpenId && mentions.some((mention) => mention.id?.open_id === botOpenId)) {
    return false;
  }

  const botName = options.botName?.trim();
  if (botName && mentions.some((mention) => mention.name === botName)) {
    return false;
  }

  return true;
}

function isGroupChatType(chatType?: string): boolean {
  return chatType === 'group' || chatType === 'group_chat';
}

async function downloadImageAttachment(
  client: FeishuInboundClient,
  messageId: string,
  imageKey: string,
): Promise<FileAttachment | undefined> {
  let buf: Buffer | null = null;
  try {
    buf = await readFeishuBuffer(
      await client.im.messageResource.get({
        path: { message_id: messageId, file_key: imageKey },
        params: { type: 'image' },
      }),
    );
  } catch {
    try {
      buf = await readFeishuBuffer(
        await client.im.image.get({
          path: { image_key: imageKey },
        }),
      );
    } catch {
      return undefined;
    }
  }

  if (!isUsableAttachmentBuffer(buf)) return undefined;
  return {
    type: 'image',
    name: 'image.png',
    mimeType: 'image/png',
    base64Data: buf.toString('base64'),
  };
}

async function downloadFileAttachment(
  client: FeishuInboundClient,
  messageId: string,
  fileKey: string,
  fileName: string,
  options: { mimeType?: unknown } = {},
): Promise<FileAttachment | undefined> {
  if (!fileKey) return undefined;
  let buf: Buffer | null = null;
  try {
    buf = await readFeishuBuffer(
      await client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: 'file' },
      }),
    );
  } catch {
    return undefined;
  }

  if (!isUsableAttachmentBuffer(buf)) return undefined;
  return {
    type: 'file',
    name: fileName,
    mimeType: inferMimeType(fileName, options.mimeType),
    base64Data: buf.toString('base64'),
  };
}

async function downloadRichAttachments(
  client: FeishuInboundClient,
  messageId: string,
  richContent: RichMessageContent,
): Promise<FileAttachment[]> {
  const attachments: FileAttachment[] = [];

  for (const imageKey of richContent.imageKeys) {
    const attachment = await downloadImageAttachment(client, messageId, imageKey);
    if (attachment) attachments.push(attachment);
  }

  for (const file of richContent.files) {
    const attachment = await downloadFileAttachment(client, messageId, file.fileKey, file.name, {
      mimeType: file.mimeType,
    });
    if (attachment) attachments.push(attachment);
  }

  return attachments;
}

function isUsableAttachmentBuffer(buf: Buffer | null): buf is Buffer {
  return !!buf && buf.length > 0 && buf.length <= MAX_INBOUND_ATTACHMENT_BYTES;
}

function safeAttachmentName(name: unknown, fallback: string): string {
  if (typeof name !== 'string' || !name.trim()) return fallback;
  return basename(name.replace(/\\/g, '/')) || fallback;
}

function inferMimeType(name: string, fallback?: unknown): string {
  if (typeof fallback === 'string' && fallback.trim()) return fallback;
  return MIME_BY_EXTENSION[extname(name).toLowerCase()] || 'application/octet-stream';
}

function stripFeishuMentions(text: string): string {
  return text.replace(/@_user_\d+\s*/g, '').trim();
}

function extractRichMessageContent(rawContent: string): RichMessageContent {
  const parsed = JSON.parse(rawContent);
  const imageKeys: string[] = [];
  const files: RichFileRef[] = [];
  const textLines: string[] = [];

  const visit = (node: unknown, textParts: string[]): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, textParts);
      return;
    }
    if (!node || typeof node !== 'object') return;

    const item = node as Record<string, unknown>;
    const tag = typeof item.tag === 'string' ? item.tag : '';
    const text = typeof item.text === 'string' ? item.text : '';
    if (tag === 'text' || tag === 'a' || (!tag && text)) {
      textParts.push(text);
    } else if (tag === 'at') {
      const userName = typeof item.user_name === 'string' ? item.user_name : '';
      textParts.push(userName ? `@${userName}` : text);
    }

    const imageKey = typeof item.image_key === 'string' ? item.image_key : undefined;
    if (imageKey && (tag === 'img' || tag === 'image' || !item.file_key)) {
      imageKeys.push(imageKey);
    }

    const fileKey = typeof item.file_key === 'string' ? item.file_key : undefined;
    if (fileKey) {
      const name = safeAttachmentName(item.file_name ?? item.name, 'file');
      const mimeType =
        typeof item.mime_type === 'string'
          ? item.mime_type
          : typeof item.mimetype === 'string'
            ? item.mimetype
            : undefined;
      files.push({ fileKey, name, mimeType });
    }

    for (const childKey of ['content', 'elements', 'children']) {
      if (childKey in item) visit(item[childKey], textParts);
    }
  };

  const content = parsed?.content ?? parsed;
  if (Array.isArray(content)) {
    for (const line of content) {
      const textParts: string[] = [];
      visit(line, textParts);
      const lineText = stripFeishuMentions(textParts.join(''));
      if (lineText) textLines.push(lineText);
    }
  } else {
    const textParts: string[] = [];
    visit(content, textParts);
    const lineText = stripFeishuMentions(textParts.join(''));
    if (lineText) textLines.push(lineText);
  }

  if (textLines.length === 0 && typeof parsed?.title === 'string' && parsed.title.trim()) {
    textLines.push(parsed.title.trim());
  }

  return {
    text: textLines.join('\n'),
    imageKeys: Array.from(new Set(imageKeys)),
    files: files.filter(
      (file, index) => files.findIndex((candidate) => candidate.fileKey === file.fileKey) === index,
    ),
  };
}
