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
import type { InboundMessage, OutboundMessage, SendResult } from './types.js';
import { loadConfig } from '../config.js';

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

    this.client.on('messageCreate', (msg) => {
      if (msg.author.bot) return;
      this.messageQueue.push({
        channelType: 'discord',
        chatId: msg.channelId,
        userId: msg.author.id,
        text: msg.content,
        messageId: msg.id,
        replyToMessageId: msg.reference?.messageId ?? undefined,
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
    // Discord has a 2000 char message limit
    const truncated = content.length > 2000 ? content.slice(0, 2000) : content;

    const payload: Parameters<TextChannel['send']>[0] = { content: truncated };

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

    const sent = await channel.send(payload) as Message;
    return { messageId: sent.id, success: true };
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
