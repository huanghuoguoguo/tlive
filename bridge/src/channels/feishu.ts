import { Client, WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import { BaseChannelAdapter, registerAdapterFactory } from './base.js';
import type { InboundMessage, OutboundMessage, SendResult, FileAttachment } from './types.js';
import { loadConfig } from '../config.js';
import { classifyError } from './errors.js';
import { markdownToFeishu } from '../markdown/feishu.js';
import { buildFeishuCard } from '../formatting/feishu-card.js';
import { FeishuStreamingSession } from './feishu-streaming.js';

/** Feishu interactive card element – now imported from shared types */
type FeishuCardElement = import('../formatting/types.js').FeishuCardElement;

/** Shape of the Feishu message.create API response */
interface FeishuCreateMessageResult {
  code?: number;
  msg?: string;
  data?: { message_id?: string };
}

interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  webhookPort: number;
  allowedUsers: string[];
}

export class FeishuAdapter extends BaseChannelAdapter {
  readonly channelType = 'feishu' as const;
  private client: Client | null = null;
  private wsClient: WSClient | null = null;
  private config: FeishuConfig;
  private messageQueue: InboundMessage[] = [];

  constructor(config: FeishuConfig) {
    super();
    this.config = config;
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
      'im.message.receive_v1': async (event: { sender?: { sender_id?: { user_id?: string; open_id?: string; union_id?: string } }; message?: { message_type?: string; content: string; chat_id: string; message_id: string; parent_id?: string; root_id?: string } }) => {
        const msg = event?.message;
        if (!msg) return;

        const senderId = event?.sender?.sender_id;
        // Use user_id as primary identifier; store open_id as fallback for auth matching
        const userId = senderId?.user_id || senderId?.open_id || '';
        const attachments: FileAttachment[] = [];

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
            userId,

            text,
            messageId: msg.message_id,
            replyToMessageId: msg.parent_id || msg.root_id || undefined,
          });
        } else if (msg.message_type === 'image') {
          try {
            const imageKey = JSON.parse(msg.content).image_key;
            const resp = await this.client!.im.v1.messageResource.get({
              path: { message_id: msg.message_id, file_key: imageKey },
              params: { type: 'image' },
            });
            if (resp?.data) {
              const chunks: Buffer[] = [];
              for await (const chunk of resp.data as AsyncIterable<Buffer>) {
                chunks.push(chunk);
              }
              const buf = Buffer.concat(chunks);
              if (buf.length <= 10_000_000) {
                attachments.push({
                  type: 'image', name: 'image.png',
                  mimeType: 'image/png', base64Data: buf.toString('base64'),
                });
              }
            }
          } catch { /* skip undownloadable images */ }

          if (attachments.length > 0) {
            this.messageQueue.push({
              channelType: 'feishu',
              chatId: msg.chat_id,
              userId,
  
              text: '',
              messageId: msg.message_id,
              replyToMessageId: msg.parent_id || msg.root_id || undefined,
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
            if (resp?.data) {
              const chunks: Buffer[] = [];
              for await (const chunk of resp.data as AsyncIterable<Buffer>) {
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
              userId,
  
              text: '',
              messageId: msg.message_id,
              replyToMessageId: msg.parent_id || msg.root_id || undefined,
              attachments,
            });
          }
        }
      },
    });

    // Use WebSocket long connection (no public callback URL needed)
    // Note: CardActionHandler is NOT supported via WSClient — Feishu uses
    // text-based permission approval instead of card action callbacks.
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

  private buildCard(text: string, buttons?: OutboundMessage['buttons'], header?: { template: string; title: string }): string {
    const elements: FeishuCardElement[] = [
      { tag: 'markdown', content: text },
    ];

    if (buttons?.length) {
      elements.push({
        tag: 'action',
        actions: buttons.map(btn => ({
          tag: 'button',
          text: { tag: 'plain_text', content: btn.label },
          type: btn.style === 'danger' ? 'danger' : 'primary',
          value: { action: btn.callbackData },
        })),
      });
    }

    return buildFeishuCard({
      header: header as any,
      elements,
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
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
          const { Readable } = await import('node:stream');
          const uploadResult = await this.client.im.image.create({
            data: {
              image_type: 'message',
              image: Readable.from(buffer) as any,
            },
          });
          const imageKey = (uploadResult as any)?.data?.image_key;
          if (imageKey) {
            const idType = message.receiveIdType || 'chat_id';
            const result = await this.client.im.message.create({
              params: { receive_id_type: idType },
              data: {
                receive_id: message.chatId,
                msg_type: 'image',
                content: JSON.stringify({ image_key: imageKey }),
              },
            });
            const messageId = (result as any)?.data?.message_id ?? '';
            return { messageId: String(messageId), success: true };
          }
        } else {
          // Upload file then send
          const { Readable } = await import('node:stream');
          const uploadResult = await this.client.im.file.create({
            data: {
              file_type: 'stream',
              file_name: media.filename || 'file',
              file: Readable.from(buffer) as any,
            },
          });
          const fileKey = (uploadResult as any)?.data?.file_key;
          if (fileKey) {
            const idType = message.receiveIdType || 'chat_id';
            const result = await this.client.im.message.create({
              params: { receive_id_type: idType },
              data: {
                receive_id: message.chatId,
                msg_type: 'file',
                content: JSON.stringify({ file_key: fileKey }),
              },
            });
            const messageId = (result as any)?.data?.message_id ?? '';
            return { messageId: String(messageId), success: true };
          }
        }
      } catch (err) {
        // Fall through to text-only if media fails
        if (!message.text && !message.html) throw classifyError('feishu', err);
      }
    }

    try {
      const idType = message.receiveIdType || 'chat_id';
      const data: Record<string, unknown> = {
        receive_id: message.chatId,
        msg_type: 'interactive',
        content: this.buildCard(raw, message.buttons, message.feishuHeader),
      };
      if (message.replyToMessageId) data.root_id = message.replyToMessageId;

      let result: FeishuCreateMessageResult;
      try {
        result = await this.client.im.message.create({
          params: { receive_id_type: idType },
          data,
        }) as FeishuCreateMessageResult;
      } catch (createErr) {
        // Reply target withdrawn/deleted — retry without root_id
        const code = (createErr as any)?.code;
        if (message.replyToMessageId && (code === 230011 || code === 231003)) {
          delete data.root_id;
          result = await this.client.im.message.create({
            params: { receive_id_type: idType },
            data,
          }) as FeishuCreateMessageResult;
        } else {
          throw createErr;
        }
      }

      const messageId = result?.data?.message_id ?? '';
      return { messageId: String(messageId), success: true };
    } catch (err) {
      throw classifyError('feishu', err);
    }
  }

  async editMessage(_chatId: string, messageId: string, message: OutboundMessage): Promise<void> {
    if (!this.client) return;
    const text = markdownToFeishu(message.text ?? message.html ?? '');

    try {
      await this.client.im.message.patch({
        path: { message_id: messageId },
        data: {
          content: this.buildCard(text, message.buttons),
        },
      });
    } catch {
      // Non-fatal: stale message edits (e.g. after restart) should not crash the process
    }
  }

  createStreamingSession(chatId: string, receiveIdType?: string, replyToMessageId?: string, header?: { template: string; title: string }): FeishuStreamingSession | null {
    if (!this.client) return null;
    return new FeishuStreamingSession({
      client: this.client,
      chatId,
      receiveIdType,
      replyToMessageId,
      header,
    });
  }

  async sendTyping(_chatId: string): Promise<void> {
    // Feishu has no native typing API; reactions are used instead
    // (handled by bridge-manager via addReaction)
  }

  private reactionIds = new Map<string, string>();

  async addReaction(_chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client) return;
    console.log(`[feishu] addReaction: messageId=${messageId}, emoji=${emoji}`);
    try {
      // Remove existing reaction first (if any)
      await this.removeReaction(_chatId, messageId);
      const result = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      });
      const reactionId = (result as any)?.data?.reaction_id;
      if (reactionId) this.reactionIds.set(messageId, reactionId);
    } catch (err) {
      console.warn(`[feishu] addReaction failed:`, (err as any)?.msg || (err as any)?.message || err);
    }
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
}

// Self-register
registerAdapterFactory('feishu', () => new FeishuAdapter(loadConfig().feishu));
