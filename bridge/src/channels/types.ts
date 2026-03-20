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
