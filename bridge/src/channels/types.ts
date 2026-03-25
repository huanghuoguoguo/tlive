export type ChannelType = 'telegram' | 'discord' | 'feishu';

export interface InboundMessage {
  channelType: ChannelType;
  chatId: string;
  userId: string;
  text: string;
  attachments?: FileAttachment[];
  callbackData?: string;
  messageId: string;
  replyToMessageId?: string;
}

export interface FileAttachment {
  type: 'image' | 'file';
  name: string;
  mimeType: string;
  base64Data: string;
}

export interface OutboundMessage {
  chatId: string;
  text?: string;
  html?: string;
  buttons?: Button[];
  replyToMessageId?: string;
  /** Feishu: override receive_id_type (default 'chat_id', can be 'open_id' for P2P) */
  receiveIdType?: string;
  /** Discord embed for rich formatting */
  embed?: {
    title?: string;
    description?: string;
    color?: number;
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
    footer?: string;
  };
  /** Feishu card header (template color + title) */
  feishuHeader?: {
    template: string;
    title: string;
  };
}

export interface SendResult {
  messageId: string;
  success: boolean;
}

export interface Button {
  label: string;
  callbackData: string;
  style?: 'primary' | 'danger' | 'default';
}
