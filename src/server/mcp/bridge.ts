import type { BaseChannelAdapter } from '../channels/base.js';
import type { DeliveryRoute } from '../channels/delivery-route.js';
import type { ChannelBinding } from '../store/interface.js';

export interface McpDeliveryTarget extends DeliveryRoute {
  cwd?: string;
  sessionKey?: string;
}

export interface TliveMcpBridge {
  getAdapter(channelType: string): BaseChannelAdapter | undefined;
  getAdapters(): BaseChannelAdapter[];
  getLastChatId(channelType: string): string;
  resolveFileDeliveryToken?(token: string): McpDeliveryTarget | undefined;
  hasActiveSession(channelType: string, chatId: string, workdir?: string): boolean;
  getBinding(channelType: string, chatId: string): Promise<ChannelBinding | null>;
  getBindingBySessionId(sessionId: string): Promise<ChannelBinding | null>;
}
