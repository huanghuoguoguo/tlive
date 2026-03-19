import { Client } from '@larksuiteoapi/node-sdk';
import { BaseChannelAdapter, registerAdapterFactory } from './base.js';
import type { InboundMessage, OutboundMessage, SendResult } from './types.js';
import { loadConfig } from '../config.js';

interface FeishuConfig {
  appId: string;
  appSecret: string;
  allowedUsers: string[];
}

export class FeishuAdapter extends BaseChannelAdapter {
  readonly channelType = 'feishu' as const;
  private client: Client | null = null;
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
  }

  async stop(): Promise<void> {
    this.client = null;
  }

  async consumeOne(): Promise<InboundMessage | null> {
    return this.messageQueue.shift() ?? null;
  }

  private buildCard(text: string, buttons?: OutboundMessage['buttons']): string {
    const elements: any[] = [
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

    const text = message.text ?? message.html ?? '';

    if (message.buttons?.length) {
      const result = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: message.chatId,
          msg_type: 'interactive',
          content: this.buildCard(text, message.buttons),
        },
      });

      const messageId = (result as any)?.data?.message_id ?? '';
      return { messageId: String(messageId), success: true };
    } else {
      // Post message for plain text (rich text format)
      const post = {
        zh_cn: {
          content: [[{ tag: 'md', text }]],
        },
      };

      const result = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: message.chatId,
          msg_type: 'post',
          content: JSON.stringify(post),
        },
      });

      const messageId = (result as any)?.data?.message_id ?? '';
      return { messageId: String(messageId), success: true };
    }
  }

  async editMessage(_chatId: string, messageId: string, message: OutboundMessage): Promise<void> {
    if (!this.client) return;
    const text = message.text ?? message.html ?? '';

    await this.client.im.message.patch({
      path: { message_id: messageId },
      data: {
        content: this.buildCard(text, message.buttons),
      } as any,
    });
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
    return this.config.allowedUsers.includes(userId);
  }
}

// Self-register
registerAdapterFactory('feishu', () => new FeishuAdapter(loadConfig().feishu));
