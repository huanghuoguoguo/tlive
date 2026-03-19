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
}

const factories = new Map<ChannelType, () => BaseChannelAdapter>();

export function registerAdapterFactory(type: ChannelType, factory: () => BaseChannelAdapter): void {
  factories.set(type, factory);
}

export function createAdapter(type: ChannelType): BaseChannelAdapter {
  const factory = factories.get(type);
  if (!factory) throw new Error(`Unknown channel type: ${type}`);
  return factory();
}

export function getRegisteredTypes(): ChannelType[] {
  return Array.from(factories.keys());
}
