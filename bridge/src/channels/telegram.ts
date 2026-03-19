import TelegramBot from 'node-telegram-bot-api';
import { BaseChannelAdapter, registerAdapterFactory } from './base.js';
import type { InboundMessage, OutboundMessage, SendResult } from './types.js';
import { loadConfig } from '../config.js';

interface TelegramConfig {
  botToken: string;
  chatId: string;
  allowedUsers: string[];
}

export class TelegramAdapter extends BaseChannelAdapter {
  readonly channelType = 'telegram' as const;
  private bot: TelegramBot | null = null;
  private config: TelegramConfig;
  private messageQueue: InboundMessage[] = [];

  constructor(config: TelegramConfig) {
    super();
    this.config = config;
  }

  async start(): Promise<void> {
    this.bot = new TelegramBot(this.config.botToken, { polling: true });

    this.bot.on('message', (msg) => {
      if (!msg.text) return;
      this.messageQueue.push({
        channelType: 'telegram',
        chatId: String(msg.chat.id),
        userId: String(msg.from?.id ?? ''),
        text: msg.text,
        messageId: String(msg.message_id),
        replyToMessageId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
      });
    });

    this.bot.on('callback_query', (query) => {
      this.messageQueue.push({
        channelType: 'telegram',
        chatId: String(query.message?.chat.id ?? ''),
        userId: String(query.from.id),
        text: '',
        callbackData: query.data,
        messageId: String(query.message?.message_id ?? ''),
      });
    });
  }

  async stop(): Promise<void> {
    await this.bot?.stopPolling();
    this.bot = null;
  }

  async consumeOne(): Promise<InboundMessage | null> {
    return this.messageQueue.shift() ?? null;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.bot) throw new Error('Telegram bot not started');

    const options: TelegramBot.SendMessageOptions = {};

    if (message.html) {
      options.parse_mode = 'HTML';
    }

    if (message.buttons?.length) {
      options.reply_markup = {
        inline_keyboard: [message.buttons.map(b => ({
          text: b.label,
          callback_data: b.callbackData,
        }))],
      };
    }

    if (message.replyToMessageId) {
      options.reply_to_message_id = parseInt(message.replyToMessageId, 10);
    }

    const text = message.html ?? message.text ?? '';
    const result = await this.bot.sendMessage(message.chatId, text, options);
    return { messageId: String(result.message_id), success: true };
  }

  async editMessage(chatId: string, messageId: string, message: OutboundMessage): Promise<void> {
    if (!this.bot) return;
    const text = message.html ?? message.text ?? '';
    const options: TelegramBot.EditMessageTextOptions = {
      chat_id: chatId,
      message_id: parseInt(messageId, 10),
    };
    if (message.html) options.parse_mode = 'HTML';
    try {
      await this.bot.editMessageText(text, options);
    } catch (err: any) {
      if (!err.message?.includes('message is not modified')) throw err;
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    try {
      await this.bot?.sendChatAction(chatId, 'typing');
    } catch {
      // Non-critical; swallow errors
    }
  }

  validateConfig(): string | null {
    if (!this.config.botToken) return 'TL_TG_BOT_TOKEN is required for Telegram';
    return null;
  }

  isAuthorized(userId: string, _chatId: string): boolean {
    if (this.config.allowedUsers.length === 0) return true;
    return this.config.allowedUsers.includes(userId);
  }
}

// Self-register
registerAdapterFactory('telegram', () => new TelegramAdapter(loadConfig().telegram));
