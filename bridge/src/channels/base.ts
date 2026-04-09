import type { ChannelType, InboundMessage, OutboundMessage, SendResult } from './types.js';
import type { FormattableMessage } from '../formatting/message-types.js';
import type { MessageFormatter } from '../formatting/message-formatter.js';

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

  /** Get the locale for this adapter */
  getLocale(): 'en' | 'zh' {
    return (this.formatter as any).locale ?? 'en';
  }

  /** Check if this platform supports rich card display (buttons, headers, etc.) */
  supportsRichCards(): boolean {
    // Access protected method via type assertion
    return (this.formatter as any).supportsButtons();
  }

  /**
   * Format a semantic message for this platform.
   * Uses the platform-specific formatter to render the message.
   */
  format(msg: FormattableMessage): OutboundMessage {
    return this.formatter.format(msg);
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