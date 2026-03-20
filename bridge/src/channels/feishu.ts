import { Client, WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import { BaseChannelAdapter, registerAdapterFactory } from './base.js';
import type { InboundMessage, OutboundMessage, SendResult, FileAttachment } from './types.js';
import { loadConfig } from '../config.js';
import { classifyError } from './errors.js';
import { markdownToFeishu } from '../markdown/feishu.js';

/** Feishu interactive card element (markdown block, action block, etc.) */
interface FeishuCardElement {
  tag: string;
  content?: string;
  actions?: Array<{
    tag: string;
    text: { tag: string; content: string };
    type: string;
    value: Record<string, string>;
  }>;
}

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

  private buildCard(text: string, buttons?: OutboundMessage['buttons']): string {
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

    return JSON.stringify({
      config: { wide_screen_mode: true },
      elements,
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.client) throw new Error('Feishu client not started');

    const raw = markdownToFeishu(message.text ?? message.html ?? '');

    try {
      // Always use interactive card format so editMessage (patch) works for streaming updates
      const result = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: message.chatId,
          msg_type: 'interactive',
          content: this.buildCard(raw, message.buttons),
          ...(message.replyToMessageId ? { root_id: message.replyToMessageId } : {}),
        },
      });

      const messageId = (result as FeishuCreateMessageResult)?.data?.message_id ?? '';
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

  async sendTyping(_chatId: string): Promise<void> {
    // Feishu has no native typing API; streaming card updates serve this purpose
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
