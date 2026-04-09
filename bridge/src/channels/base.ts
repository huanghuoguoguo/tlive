import type { ChannelType, InboundMessage, OutboundMessage, SendResult } from './types.js';
import type { FormattableMessage } from '../formatting/message-types.js';
import { MessageFormatter } from '../formatting/message-formatter.js';

export abstract class BaseChannelAdapter {
  abstract readonly channelType: ChannelType;
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract consumeOne(): Promise<InboundMessage | null>;
  abstract send(message: OutboundMessage): Promise<SendResult>;
  abstract editMessage(chatId: string, messageId: string, message: OutboundMessage): Promise<void>;
  abstract sendTyping(chatId: string): Promise<void>;
  abstract validateConfig(): string | null;
  abstract isAuthorized(userId: string, chatId: string): boolean;

  /** Delete a message. Override in adapters that support deletion. */
  async deleteMessage(_chatId: string, _messageId: string): Promise<void> {}

  /** Add a reaction emoji to a message. Override in adapters that support reactions. */
  async addReaction(_chatId: string, _messageId: string, _emoji: string): Promise<void> {}

  /** Remove all bot reactions from a message. */
  async removeReaction(_chatId: string, _messageId: string): Promise<void> {}

  // --- Formatting support ---

  /** Platform-specific message formatter. Override in subclass. */
  protected formatter!: MessageFormatter;

  /** Set the formatter for this adapter */
  setFormatter(formatter: MessageFormatter): void {
    this.formatter = formatter;
  }

  /**
   * Format a semantic message for this platform.
   * Uses the platform-specific formatter to render the message.
   */
  format(msg: FormattableMessage): OutboundMessage {
    const { type, chatId, data } = msg as any;
    switch (type) {
      case 'status':
        return this.formatter.formatStatus(chatId, data);
      case 'permission':
        return this.formatter.formatPermission(chatId, data);
      case 'question':
        return this.formatter.formatQuestion(chatId, data);
      case 'notification':
        return this.formatter.formatNotification(chatId, data);
      case 'home':
        return this.formatter.formatHome(chatId, data);
      case 'sessions':
        return this.formatter.formatSessions(chatId, data);
      case 'sessionDetail':
        return this.formatter.formatSessionDetail(chatId, data);
      case 'help':
        return this.formatter.formatHelp(chatId, data);
      case 'newSession':
        return this.formatter.formatNewSession(chatId, data);
      case 'error':
        return this.formatter.formatError(chatId, data);
      case 'progress':
        return this.formatter.formatProgress(chatId, data);
      default:
        throw new Error(`Unknown message type: ${type}`);
    }
  }

  /**
   * Format and send a semantic message in one call.
   */
  async sendFormatted(msg: FormattableMessage): Promise<SendResult> {
    return this.send(this.format(msg));
  }
}

// Use globalThis to share the registry across module instances (for dynamic imports)
const GLOBAL_KEY = '__tlive_adapter_registry__';

type AdapterRegistry = Map<ChannelType, () => BaseChannelAdapter>;

function getRegistry(): AdapterRegistry {
  if (!(globalThis as any)[GLOBAL_KEY]) {
    (globalThis as any)[GLOBAL_KEY] = new Map<ChannelType, () => BaseChannelAdapter>();
  }
  return (globalThis as any)[GLOBAL_KEY];
}

export function registerAdapterFactory(type: ChannelType, factory: () => BaseChannelAdapter): void {
  getRegistry().set(type, factory);
}

export function createAdapter(type: ChannelType): BaseChannelAdapter {
  const factory = getRegistry().get(type);
  if (!factory) throw new Error(`Unknown channel type: ${type}`);
  return factory();
}

export function getRegisteredTypes(): ChannelType[] {
  return Array.from(getRegistry().keys());
}