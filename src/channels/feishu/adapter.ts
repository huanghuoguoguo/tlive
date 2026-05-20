import { Client, WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import { BaseChannelAdapter } from '../base.js';
import type { InboundMessage, SendResult, FileAttachment, ThreadStartResult } from '../types.js';
import type { BridgeError } from '../errors.js';
import { RateLimitError, AuthError } from '../errors.js';
import { checkNetworkError } from '../shared/index.js';
import { markdownToFeishu, downgradeHeadings } from './markdown.js';
import { buildFeishuCard, buildFeishuButtonElements } from './card-builder.js';
import { FeishuStreamingSession } from './streaming.js';
import { FeishuFormatter } from './formatter.js';
import { FEISHU_POLICY } from './policy.js';
import type { Readable } from 'node:stream';
import type { FeishuRenderedMessage } from './types.js';
import type { FeishuCardElement } from './card-builder.js';
import { t } from '../../i18n/index.js';
import type { QuickButtonName } from '../../ui/buttons.js';
import { chatScopeId } from '../../core/key.js';

/**
 * Read a Feishu SDK response into a Buffer.
 * The SDK returns different formats depending on version/endpoint:
 * Buffer, ArrayBuffer, async iterable, or nested in .data
 * (Inspired by openclaw's readFeishuResponseBuffer)
 */
async function readFeishuBuffer(resp: unknown): Promise<Buffer | null> {
  if (!resp) return null;
  const r = resp as any;
  // Direct Buffer
  if (Buffer.isBuffer(r)) return r;
  if (r instanceof ArrayBuffer) return Buffer.from(r);
  // Nested in .data
  if (r.data && Buffer.isBuffer(r.data)) return r.data;
  if (r.data instanceof ArrayBuffer) return Buffer.from(r.data);
  // getReadableStream() — SDK v1.30+ returns this for file downloads
  if (typeof r.getReadableStream === 'function') {
    const stream = r.getReadableStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  // writeFile() — SDK fallback: write to temp file then read back
  if (typeof r.writeFile === 'function') {
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { readFile, unlink } = await import('node:fs/promises');
    const tmp = join(tmpdir(), `tlive-feishu-${Date.now()}.tmp`);
    try {
      await r.writeFile(tmp);
      return await readFile(tmp);
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }
  // Async iterable (stream) on .data
  if (typeof r.data?.[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    for await (const chunk of r.data as AsyncIterable<Buffer>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  if (typeof r[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    for await (const chunk of r as AsyncIterable<Buffer>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  // Readable stream on .data
  if (typeof r.data?.read === 'function') {
    const chunks: Buffer[] = [];
    for await (const chunk of r.data as Readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  return null;
}

/** Shape of the Feishu message.create API response */
interface FeishuCreateMessageResult {
  code?: number;
  msg?: string;
  data?: { message_id?: string; thread_id?: string };
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  webhookPort: number;
  allowedUsers: string[];
}

export interface FeishuAdapterOptions {
  doneButtons?: readonly QuickButtonName[];
  autoPinTopics?: boolean;
}

const FEISHU_MENU_EVENT_TO_COMMAND: Record<string, string> = {
  tlive_home: '/home',
  tlive_recent_sessions: '/sessions --all',
  tlive_status: '/status',
  tlive_stop: '/stop',
  tlive_help: '/help',
};
const FEISHU_PROGRESS_SPLIT_BYTES = 27 * 1024;

function isMissingReplyTarget(err: unknown): boolean {
  const code = (err as any)?.code;
  return code === 230011 || code === 231003;
}

function isThreadReplyUnsupported(err: unknown): boolean {
  return (err as any)?.code === 230071;
}

function feishuInboundScope(chatId: string, threadId?: string): string | undefined {
  return threadId ? chatScopeId(chatId, threadId) : undefined;
}

function feishuReplyTarget(messageId: string, rootId?: string, parentId?: string, threadId?: string): string | undefined {
  return threadId ? messageId : (parentId || rootId || undefined);
}

export class FeishuAdapter extends BaseChannelAdapter<FeishuRenderedMessage> {
  readonly channelType = 'feishu' as const;
  private client: Client | null = null;
  private wsClient: WSClient | null = null;
  private config: FeishuConfig;
  private messageQueue: InboundMessage[] = [];
  private autoPinTopics: boolean;

  constructor(config: FeishuConfig, options: FeishuAdapterOptions = {}) {
    super();
    this.config = config;
    this.autoPinTopics = options.autoPinTopics ?? false;
    // Set platform-specific formatter and policy (Chinese locale for Feishu)
    this.formatter = new FeishuFormatter('zh', { doneButtons: options.doneButtons });
    this.setPolicy(FEISHU_POLICY);
  }

  async start(): Promise<void> {
    this.client = new Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    const eventDispatcher = new EventDispatcher({
      verificationToken: this.config.verificationToken,
      encryptKey: this.config.encryptKey,
    });

    eventDispatcher.register({
      'im.message.receive_v1': async (event: { sender?: { sender_id?: { user_id?: string; open_id?: string; union_id?: string } }; message?: { message_type?: string; content: string; chat_id: string; message_id: string; parent_id?: string; root_id?: string; thread_id?: string } }) => {
        const msg = event?.message;
        if (!msg) return;

        const senderId = event?.sender?.sender_id;
        // Use user_id as primary identifier; store open_id as fallback for auth matching
        const userId = senderId?.user_id || senderId?.open_id || '';
        const attachments: FileAttachment[] = [];
        const threadId = msg.thread_id || undefined;
        const replyToMessageId = threadId ? undefined : feishuReplyTarget(msg.message_id, msg.root_id, msg.parent_id, threadId);
        const replyTargetMessageId = threadId ? msg.message_id : undefined;
        const scopeId = feishuInboundScope(msg.chat_id, threadId);

        if (msg.message_type === 'text') {
          let text = '';
          try {
            const content = JSON.parse(msg.content);
            text = content.text ?? '';
            // Strip @mention placeholders (e.g. "@_user_1 ") from group chat messages
            text = text.replace(/@_user_\d+\s*/g, '').trim();
          } catch {
            return;
          }

          this.messageQueue.push({
            channelType: 'feishu',
            chatId: msg.chat_id,
            scopeId,
            threadId,
            threadRootMessageId: msg.root_id,
            threadParentMessageId: msg.parent_id,
            replyInThread: !!threadId,
            userId,

            text,
            messageId: msg.message_id,
            replyTargetMessageId,
            replyToMessageId,
          });
        } else if (msg.message_type === 'image') {
          try {
            const imageKey = JSON.parse(msg.content).image_key;
            let buf: Buffer | null = null;
            try {
              buf = await readFeishuBuffer(await this.client!.im.messageResource.get({
                path: { message_id: msg.message_id, file_key: imageKey },
                params: { type: 'image' },
              }));
            } catch {
              try {
                buf = await readFeishuBuffer(await this.client!.im.image.get({
                  path: { image_key: imageKey },
                }));
              } catch { /* both methods failed */ }
            }
            if (buf && buf.length > 0 && buf.length <= 10_000_000) {
              attachments.push({
                type: 'image', name: 'image.png',
                mimeType: 'image/png', base64Data: buf.toString('base64'),
              });
            }
          } catch { /* skip undownloadable images */ }

          if (attachments.length > 0) {
            this.messageQueue.push({
              channelType: 'feishu',
              chatId: msg.chat_id,
              scopeId,
              threadId,
              threadRootMessageId: msg.root_id,
              threadParentMessageId: msg.parent_id,
              replyInThread: !!threadId,
              userId,

              text: '',
              messageId: msg.message_id,
              replyTargetMessageId,
              replyToMessageId,
              attachments,
            });
          }
        } else if (msg.message_type === 'file') {
          try {
            const fileKey = JSON.parse(msg.content).file_key;
            const resp = await this.client!.im.v1.messageResource.get({
              path: { message_id: msg.message_id, file_key: fileKey },
              params: { type: 'file' },
            });
            if ((resp as any)?.data) {
              const chunks: Buffer[] = [];
              for await (const chunk of (resp as any).data as AsyncIterable<Buffer>) {
                chunks.push(chunk);
              }
              const buf = Buffer.concat(chunks);
              if (buf.length <= 10_000_000) {
                attachments.push({
                  type: 'file', name: 'file',
                  mimeType: 'application/octet-stream', base64Data: buf.toString('base64'),
                });
              }
            }
          } catch { /* skip undownloadable files */ }

          if (attachments.length > 0) {
            this.messageQueue.push({
              channelType: 'feishu',
              chatId: msg.chat_id,
              scopeId,
              threadId,
              threadRootMessageId: msg.root_id,
              threadParentMessageId: msg.parent_id,
              replyInThread: !!threadId,
              userId,

              text: '',
              messageId: msg.message_id,
              replyTargetMessageId,
              replyToMessageId,
              attachments,
            });
          }
        }
      },
    });

    // Register card action handler for button callbacks and form submissions (schema 2.0 cards)
    eventDispatcher.register({
      'card.action.trigger': async (data: unknown) => {
        console.log('[feishu] card.action.trigger received:', JSON.stringify(data).slice(0, 500));
        const event = data as {
          operator?: { user_id?: string; open_id?: string };
          action?: { value?: Record<string, string>; form_value?: Record<string, string> };
          context?: { chat_id?: string; open_chat_id?: string; open_message_id?: string; thread_id?: string };
        };

        // Check for form submission (form_value present)
        const formValue = event?.action?.form_value;
        if (formValue && Object.keys(formValue).length > 0) {
          // Form submission — extract interactionId and answers
          const interactionId = formValue._interaction_id || '';
          const userId = event?.operator?.user_id || event?.operator?.open_id || '';
          const chatId = event?.context?.chat_id || event?.context?.open_chat_id || '';
          const messageId = event?.context?.open_message_id || '';
          const threadId = event?.context?.thread_id || undefined;

          console.log('[feishu] Form submission:', interactionId, JSON.stringify(formValue));

          this.messageQueue.push({
            channelType: 'feishu',
            chatId,
            scopeId: feishuInboundScope(chatId, threadId),
            threadId,
            replyInThread: !!threadId,
            userId,
            text: '',
            callbackData: `form:${interactionId}:${JSON.stringify(formValue)}`,
            messageId,
            replyTargetMessageId: threadId ? messageId : undefined,
          });
          return {
            toast: {
              type: 'success',
              content: t('zh', 'adapter.submitted'),
            },
          };
        }

        // Button callback
        const action = event?.action?.value?.action;
        if (!action) {
          console.warn('[feishu] card.action.trigger: no action value found');
          return {};
        }
        const userId = event?.operator?.user_id || event?.operator?.open_id || '';
        const chatId = event?.context?.chat_id || event?.context?.open_chat_id || '';
        const messageId = event?.context?.open_message_id || '';
        const threadId = event?.context?.thread_id || undefined;
        this.messageQueue.push({
          channelType: 'feishu',
          chatId,
          scopeId: feishuInboundScope(chatId, threadId),
          threadId,
          replyInThread: !!threadId,
          userId,
          text: '',
          callbackData: action,
          messageId,
          replyTargetMessageId: threadId ? messageId : undefined,
        });
        return {
          toast: {
            type: 'success',
            content: t('zh', 'adapter.processing'),
          },
        };
      },
    } as any);

    eventDispatcher.register({
      'application.bot.menu_v6': async (data: unknown) => {
        const event = data as {
          event_key?: string;
          operator?: {
            operator_id?: {
              user_id?: string;
              open_id?: string;
            };
          };
        };
        const command = event?.event_key ? FEISHU_MENU_EVENT_TO_COMMAND[event.event_key] : undefined;
        if (!command) {
          console.warn('[feishu] application.bot.menu_v6: unknown event key', event?.event_key);
          return {};
        }
        const userId = event?.operator?.operator_id?.user_id || event?.operator?.operator_id?.open_id || '';
        this.messageQueue.push({
          channelType: 'feishu',
          chatId: '',
          userId,
          text: command,
          messageId: `menu:${event?.event_key ?? 'unknown'}:${Date.now()}`,
        });
        return {};
      },
    } as any);

    // Use WebSocket long connection (no public callback URL needed)
    this.wsClient = new WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    await this.wsClient.start({ eventDispatcher });
  }

  async stop(): Promise<void> {
    if (this.wsClient) {
      try { (this.wsClient as any).close?.(); } catch { /* best effort */ }
      this.wsClient = null;
    }
    this.client = null;
  }

  async consumeOne(): Promise<InboundMessage | null> {
    return this.messageQueue.shift() ?? null;
  }

  private buildCard(text: string, buttons?: FeishuRenderedMessage['buttons'], header?: { template: string; title: string }): string {
    const elements: FeishuCardElement[] = [
      { tag: 'markdown', content: downgradeHeadings(text) },
    ];
    elements.push(...buildFeishuButtonElements(buttons));

    return buildFeishuCard({
      header: header as any,
      elements,
    });
  }

  private async sendMessageContent(
    message: FeishuRenderedMessage,
    msgType: string,
    content: string,
  ): Promise<FeishuCreateMessageResult> {
    if (!this.client) throw new Error('Feishu client not started');

    const idType = message.receiveIdType || 'chat_id';
    if (message.replyToMessageId && message.replyInThread) {
      try {
        return await this.client.im.message.reply({
          path: { message_id: message.replyToMessageId },
          data: {
            msg_type: msgType,
            content,
            reply_in_thread: true,
          },
        }) as FeishuCreateMessageResult;
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
      return await this.client.im.message.create({
        params: { receive_id_type: idType as any },
        data: data as any,
      }) as FeishuCreateMessageResult;
    } catch (createErr) {
      if (message.replyToMessageId && isMissingReplyTarget(createErr)) {
        delete data.root_id;
        return await this.client.im.message.create({
          params: { receive_id_type: idType as any },
          data: data as any,
        }) as FeishuCreateMessageResult;
      }
      throw createErr;
    }
  }

  override async startThreadFromMessage(
    chatId: string,
    messageId: string,
    text = '💬 已开启话题，正在处理...',
  ): Promise<ThreadStartResult | null> {
    if (!this.client) return null;
    try {
      const content = this.buildCard(text);
      const result = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'interactive',
          content,
          reply_in_thread: true,
        },
      }) as FeishuCreateMessageResult;
      const threadId = result?.data?.thread_id;
      const replyMessageId = result?.data?.message_id;
      if (!threadId || !replyMessageId) {
        console.warn(`[feishu] startThreadFromMessage returned no thread_id for chat=${chatId.slice(-8)}`);
        return null;
      }
      if (this.autoPinTopics) {
        await this.pinMessage(String(replyMessageId)).catch((pinErr) => {
          console.warn(`[feishu] auto pin topic failed (${(pinErr as any)?.code ?? 'unknown'})`);
        });
      }
      return {
        threadId: String(threadId),
        rootMessageId: messageId,
        messageId: String(replyMessageId),
      };
    } catch (err) {
      if (isThreadReplyUnsupported(err) || isMissingReplyTarget(err)) {
        console.warn(`[feishu] startThreadFromMessage unsupported (${(err as any)?.code ?? 'unknown'})`);
        return null;
      }
      throw this.classifyError(err);
    }
  }

  override async startThreadWithTitle(
    chatId: string,
    title: string,
    text = '💬 已开启话题，请在本话题内继续...',
  ): Promise<ThreadStartResult | null> {
    if (!this.client) return null;
    const content = JSON.stringify({ text: title });
    const root = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' as any },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content,
      },
    }) as FeishuCreateMessageResult;
    const rootMessageId = root?.data?.message_id;
    if (!rootMessageId) {
      console.warn(`[feishu] startThreadWithTitle returned no root message_id for chat=${chatId.slice(-8)}`);
      return null;
    }

    const started = await this.startThreadFromMessage(chatId, String(rootMessageId), text);
    return started ? { ...started, rootMessageId: String(rootMessageId) } : null;
  }

  async send(message: FeishuRenderedMessage): Promise<SendResult> {
    if (!this.client) throw new Error('Feishu client not started');

    // Prefer raw text (markdown) over HTML — schema 2.0 cards render markdown natively
    const raw = message.text
      ? message.text
      : markdownToFeishu(message.html ?? '');

    // Media sending
    if (message.media) {
      try {
        const media = message.media;
        let buffer: Buffer;
        if (media.buffer) {
          buffer = media.buffer;
        } else if (media.url?.startsWith('data:')) {
          const base64 = media.url.split(',')[1];
          buffer = Buffer.from(base64, 'base64');
        } else if (media.url) {
          // Fetch URL to buffer
          const resp = await fetch(media.url);
          buffer = Buffer.from(await resp.arrayBuffer());
        } else {
          throw new Error('No media source');
        }

        if (media.type === 'image') {
          // Upload image first, then send
          // Pass Buffer directly — Readable.from() causes form-data issues
          // See: https://github.com/larksuite/node-sdk/issues/121
          const uploadResult = await this.client.im.image.create({
            data: {
              image_type: 'message',
              image: buffer as any,
            },
          });
          const imageKey = (uploadResult as any)?.data?.image_key;
          if (imageKey) {
            const result = await this.sendMessageContent(
              message,
              'image',
              JSON.stringify({ image_key: imageKey }),
            );
            const messageId = (result as any)?.data?.message_id ?? '';
            return { messageId: String(messageId), success: true };
          }
        } else {
          // Upload file then send
          // Pass Buffer directly — Readable.from() causes form-data issues
          const uploadResult = await this.client.im.file.create({
            data: {
              file_type: 'stream',
              file_name: media.filename || 'file',
              file: buffer as any,
            },
          });
          const fileKey = (uploadResult as any)?.data?.file_key;
          if (fileKey) {
            const result = await this.sendMessageContent(
              message,
              'file',
              JSON.stringify({ file_key: fileKey }),
            );
            const messageId = (result as any)?.data?.message_id ?? '';
            return { messageId: String(messageId), success: true };
          }
        }
      } catch (err) {
        // Fall through to text-only if media fails
        if (!message.text && !message.html) throw this.classifyError(err);
      }
    }

    try {
      // If feishuElements provided, build card directly from structured elements
      const cardContent = message.feishuElements
        ? buildFeishuCard({
            header: message.feishuHeader as any,
            elements: [
              ...(message.feishuElements as any),
              ...buildFeishuButtonElements(message.feishuButtons ?? message.buttons),
            ],
          })
        : this.buildCard(raw, message.buttons, message.feishuHeader);
      const result = await this.sendMessageContent(message, 'interactive', cardContent);

      const messageId = result?.data?.message_id ?? '';
      return { messageId: String(messageId), success: true };
    } catch (err) {
      throw this.classifyError(err);
    }
  }

  async pinMessage(messageId: string): Promise<void> {
    if (!this.client) return;
    await this.client.im.pin.create({
      data: { message_id: messageId },
    });
  }

  async deleteMessage(_chatId: string, messageId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.im.message.delete({ path: { message_id: messageId } });
    } catch {
      // Non-fatal
    }
  }

  async editMessage(_chatId: string, messageId: string, message: FeishuRenderedMessage): Promise<void> {
    if (!this.client) return;
    const text = message.text
      ? message.text
      : markdownToFeishu(message.html ?? '');

    try {
      if (message.feishuElements) {
        await this.client.im.message.patch({
          path: { message_id: messageId },
          data: {
            content: buildFeishuCard({
              header: message.feishuHeader as any,
              elements: [
                ...(message.feishuElements as any),
                ...buildFeishuButtonElements(message.feishuButtons ?? message.buttons),
              ],
            }),
          },
        });
        return;
      }
      await this.client.im.message.patch({
        path: { message_id: messageId },
        data: {
          content: this.buildCard(text, message.buttons, message.feishuHeader),
        },
      });
    } catch (err: any) {
      console.warn(`[feishu] editMessage failed: ${err?.message ?? err}`);
    }
  }

  createStreamingSession(chatId: string, receiveIdType?: string, replyToMessageId?: string, header?: { template: string; title: string }, replyInThread?: boolean): FeishuStreamingSession | null {
    if (!this.client) return null;
    return new FeishuStreamingSession({
      client: this.client,
      chatId,
      receiveIdType,
      replyToMessageId,
      header,
      replyInThread,
    });
  }

  override shouldSplitProgressMessage(message: FeishuRenderedMessage): boolean {
    if (!message.feishuElements) {
      return false;
    }
    const cardJson = buildFeishuCard({
      header: message.feishuHeader as { template: any; title: string } | undefined,
      elements: [
        ...(message.feishuElements as any),
        ...buildFeishuButtonElements(message.feishuButtons ?? message.buttons),
      ],
    });
    return Buffer.byteLength(cardJson, 'utf8') >= FEISHU_PROGRESS_SPLIT_BYTES;
  }

  async sendTyping(_chatId: string): Promise<void> {
    // Feishu has no native typing API; reactions are used instead
    // (handled by bridge-manager via addReaction)
  }

  private reactionIds = new Map<string, string>();

  async addReaction(_chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client) return;
    try {
      // Remove existing reaction first (if any)
      await this.removeReaction(_chatId, messageId);
      const result = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      });
      const reactionId = (result as any)?.data?.reaction_id;
      if (reactionId) this.reactionIds.set(messageId, reactionId);
    } catch { /* non-fatal */ }
  }

  async removeReaction(_chatId: string, messageId: string): Promise<void> {
    if (!this.client) return;
    const reactionId = this.reactionIds.get(messageId);
    if (!reactionId) return;
    try {
      await this.client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
      this.reactionIds.delete(messageId);
    } catch {
      // Non-fatal
    }
  }

  validateConfig(): string | null {
    if (!this.config.appId) return 'TL_FS_APP_ID is required for Feishu';
    if (!this.config.appSecret) return 'TL_FS_APP_SECRET is required for Feishu';
    return null;
  }

  isAuthorized(userId: string, _chatId: string): boolean {
    if (this.config.allowedUsers.length === 0) return true;
    // userId may be user_id or open_id — match against either format in allowedUsers
    return this.config.allowedUsers.includes(userId);
  }

  // --- Error classification (OCP: platform-specific error handling) ---

  /** Classify Feishu/Lark SDK errors */
  classifyError(err: unknown): BridgeError {
    const e = err as Record<string, any>;
    const message = e?.message ?? String(err);

    // Handle common network errors
    const netErr = checkNetworkError(e);
    if (netErr) return netErr;

    // Feishu uses numeric error codes
    const code = e?.code;
    if (code === 99991400) return new RateLimitError(message);
    if (code === 99991401 || code === 99991403) return new AuthError(message);

    return super.classifyError(err);
  }

  // --- Broadcast preparation (OCP: platform-specific broadcast handling) ---

  /** Add receive_id_type for Feishu broadcast messages */
  prepareBroadcast(msg: FeishuRenderedMessage): FeishuRenderedMessage {
    // Feishu requires receive_id_type for group chat messages
    return { ...msg, receiveIdType: undefined };
  }

  /** Get Feishu bot info for display */
  getBotInfo(): { appId?: string; name?: string } {
    return { appId: this.config.appId };
  }
}
