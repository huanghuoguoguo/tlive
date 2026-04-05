import type { ChannelType, InboundMessage, OutboundMessage, SendResult } from './types.js';

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
