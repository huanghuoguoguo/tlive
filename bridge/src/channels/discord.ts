import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type TextChannel,
  type Message,
} from 'discord.js';
import { BaseChannelAdapter, registerAdapterFactory } from './base.js';
import type { InboundMessage, OutboundMessage, SendResult, FileAttachment } from './types.js';
import { loadConfig } from '../config.js';
import { chunkMarkdown } from '../delivery/delivery.js';
import { classifyError } from './errors.js';

interface DiscordConfig {
  botToken: string;
  allowedUsers: string[];
  allowedChannels: string[];
}

export class DiscordAdapter extends BaseChannelAdapter {
  readonly channelType = 'discord' as const;
  private client: Client | null = null;
  private config: DiscordConfig;
  private messageQueue: InboundMessage[] = [];

  constructor(config: DiscordConfig) {
    super();
    this.config = config;
  }

  async start(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client.on('messageCreate', async (msg) => {
      if (msg.author.bot) return;

      const attachments: FileAttachment[] = [];
      for (const [, att] of msg.attachments) {
        if ((att.size ?? 0) > 10_000_000) continue;
        try {
          const resp = await fetch(att.url);
          if (!resp.ok) continue;
          const buf = Buffer.from(await resp.arrayBuffer());
          const mimeType = att.contentType ?? 'application/octet-stream';
          attachments.push({
            type: mimeType.startsWith('image/') ? 'image' : 'file',
            name: att.name ?? 'file',
            mimeType, base64Data: buf.toString('base64'),
          });
        } catch { /* skip undownloadable attachments */ }
      }

      this.messageQueue.push({
        channelType: 'discord',
        chatId: msg.channelId,
        userId: msg.author.id,
        text: msg.content,
        messageId: msg.id,
        replyToMessageId: msg.reference?.messageId ?? undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
    });

    this.client.on('interactionCreate', (interaction) => {
      if (!interaction.isButton()) return;
      this.messageQueue.push({
        channelType: 'discord',
        chatId: interaction.channelId,
        userId: interaction.user.id,
        text: '',
        callbackData: interaction.customId,
        messageId: interaction.message.id,
      });
    });

    await this.client.login(this.config.botToken);
  }

  async stop(): Promise<void> {
    await this.client?.destroy();
    this.client = null;
  }

  async consumeOne(): Promise<InboundMessage | null> {
    return this.messageQueue.shift() ?? null;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.client) throw new Error('Discord client not started');

    const channel = await this.client.channels.fetch(message.chatId) as TextChannel;
    if (!channel || !channel.send) {
      throw new Error(`Channel ${message.chatId} not found or not a text channel`);
    }

    const content = message.text ?? message.html ?? '';
    const chunks = chunkMarkdown(content, 2000);

    let lastSent: Message | undefined;
    try {
      for (let i = 0; i < chunks.length; i++) {
        const payload: Parameters<TextChannel['send']>[0] = { content: chunks[i] };

        // Reply reference on first chunk only
        if (i === 0 && message.replyToMessageId) {
          (payload as Record<string, unknown>).reply = { messageReference: { messageId: message.replyToMessageId } };
        }

        // Buttons on last chunk only
        if (i === chunks.length - 1 && message.buttons?.length) {
          const row = new ActionRowBuilder<ButtonBuilder>();
          for (const btn of message.buttons) {
            const button = new ButtonBuilder()
              .setCustomId(btn.callbackData)
              .setLabel(btn.label)
              .setStyle(btn.style === 'danger' ? ButtonStyle.Danger : ButtonStyle.Primary);
            row.addComponents(button);
          }
          payload.components = [row];
        }

        lastSent = await channel.send(payload) as Message;
      }
    } catch (err) {
      throw classifyError('discord', err);
    }

    return { messageId: lastSent?.id ?? '', success: true };
  }

  async editMessage(chatId: string, messageId: string, message: OutboundMessage): Promise<void> {
    if (!this.client) return;

    const channel = await this.client.channels.fetch(chatId) as TextChannel;
    if (!channel || !channel.messages) return;

    const existing = await channel.messages.fetch(messageId);
    if (!existing) return;

    const content = message.text ?? message.html ?? '';
    const truncated = content.length > 2000 ? content.slice(0, 2000) : content;

    const payload: Parameters<Message['edit']>[0] = { content: truncated };

    if (message.buttons?.length) {
      const row = new ActionRowBuilder<ButtonBuilder>();
      for (const btn of message.buttons) {
        const button = new ButtonBuilder()
          .setCustomId(btn.callbackData)
          .setLabel(btn.label)
          .setStyle(btn.style === 'danger' ? ButtonStyle.Danger : ButtonStyle.Primary);
        row.addComponents(button);
      }
      payload.components = [row];
    }

    await existing.edit(payload);
  }

  async sendTyping(chatId: string): Promise<void> {
    try {
      const channel = await this.client?.channels.fetch(chatId);
      if (channel?.isTextBased()) await (channel as TextChannel).sendTyping();
    } catch {
      // Non-critical; swallow errors
    }
  }

  validateConfig(): string | null {
    if (!this.config.botToken) return 'TL_DC_BOT_TOKEN is required for Discord';
    return null;
  }

  isAuthorized(userId: string, chatId: string): boolean {
    const userAllowed =
      this.config.allowedUsers.length === 0 || this.config.allowedUsers.includes(userId);
    const channelAllowed =
      this.config.allowedChannels.length === 0 || this.config.allowedChannels.includes(chatId);
    return userAllowed && channelAllowed;
  }
}

// Self-register
registerAdapterFactory('discord', () => new DiscordAdapter(loadConfig().discord));
