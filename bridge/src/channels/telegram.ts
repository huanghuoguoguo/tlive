import TelegramBot from 'node-telegram-bot-api';
import { BaseChannelAdapter, registerAdapterFactory } from './base.js';
import type { InboundMessage, OutboundMessage, SendResult, FileAttachment } from './types.js';
import { loadConfig } from '../config.js';
import { chunkMarkdown } from '../delivery/delivery.js';
import { classifyError } from './errors.js';

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
    // Clear accumulated updates before starting polling to avoid processing old messages
    try {
      const tempBot = new TelegramBot(this.config.botToken);
      const updates = await tempBot.getUpdates({ offset: -1, limit: 1, timeout: 0 });
      if (updates.length > 0) {
        await tempBot.getUpdates({ offset: updates[0].update_id + 1, limit: 0, timeout: 0 });
      }
      await tempBot.close();
    } catch {
      // Non-fatal: proceed with polling even if cleanup fails
    }

    this.bot = new TelegramBot(this.config.botToken, { polling: true });

    this.bot.on('message', async (msg) => {
      const base = {
        channelType: 'telegram' as const,
        chatId: String(msg.chat.id),
        userId: String(msg.from?.id ?? ''),
        text: msg.text ?? msg.caption ?? '',
        messageId: String(msg.message_id),
        replyToMessageId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
      };

      const attachments: FileAttachment[] = [];

      if (msg.photo?.length) {
        const photo = msg.photo[msg.photo.length - 1]; // largest size
        try {
          const url = await this.bot!.getFileLink(photo.file_id);
          const resp = await fetch(url);
          if (resp.ok) {
            const buf = Buffer.from(await resp.arrayBuffer());
            if (buf.length <= 10_000_000) {
              attachments.push({
                type: 'image', name: 'photo.jpg',
                mimeType: 'image/jpeg', base64Data: buf.toString('base64'),
              });
            }
          }
        } catch { /* skip undownloadable photos */ }
      }

      if (msg.document) {
        try {
          const url = await this.bot!.getFileLink(msg.document.file_id);
          const resp = await fetch(url);
          if (resp.ok) {
            const buf = Buffer.from(await resp.arrayBuffer());
            if (buf.length <= 10_000_000) {
              const mimeType = msg.document.mime_type ?? 'application/octet-stream';
              attachments.push({
                type: mimeType.startsWith('image/') ? 'image' : 'file',
                name: msg.document.file_name ?? 'file',
                mimeType, base64Data: buf.toString('base64'),
              });
            }
          }
        } catch { /* skip undownloadable documents */ }
      }

      if (!base.text && attachments.length === 0) return;
      this.messageQueue.push({ ...base, attachments: attachments.length > 0 ? attachments : undefined });
    });

    this.bot.on('callback_query', (query) => {
      // Dismiss the loading spinner on the button
      this.bot!.answerCallbackQuery(query.id).catch(() => {});
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
    if (message.html) options.parse_mode = 'HTML';
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
    const chunks = text.length > 4096 ? chunkMarkdown(text, 4096) : [text];

    let lastMessageId = '';
    try {
      for (let i = 0; i < chunks.length; i++) {
        const opts: TelegramBot.SendMessageOptions = { ...options };
        if (i < chunks.length - 1) delete opts.reply_markup;
        const result = await this.bot.sendMessage(message.chatId, chunks[i], opts);
        lastMessageId = String(result.message_id);
      }
    } catch (err) {
      throw classifyError('telegram', err);
    }

    return { messageId: lastMessageId, success: true };
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
    } catch (err: unknown) {
      if (!(err instanceof Error && err.message?.includes('message is not modified'))) throw err;
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
