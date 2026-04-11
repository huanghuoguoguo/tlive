export type ChannelType = 'telegram' | 'feishu' | 'qqbot';

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
  /** URL to fetch the file content (used when base64Data is empty) */
  url?: string;
}

export interface OutboundMessage {
  chatId: string;
  text?: string;
  html?: string;
  buttons?: Button[];
  replyToMessageId?: string;
  /** Feishu: override receive_id_type (default 'chat_id', can be 'open_id' for P2P) */
  receiveIdType?: string;
  /** Feishu card header (template color + title) */
  feishuHeader?: {
    template: string;
    title: string;
  };
  /** Feishu Card 2.0: override card body elements directly (bypasses text→markdown conversion) */
  feishuElements?: Array<Record<string, unknown>>;
  /** Feishu Card 2.0: render explicit action rows instead of generic message buttons */
  feishuButtons?: Button[];
  /** Media attachment to send (image or file) */
  media?: {
    type: 'image' | 'file';
    /** URL to fetch, or data URI (data:image/png;base64,...) */
    url?: string;
    /** Raw buffer data */
    buffer?: Buffer;
    /** Filename for file attachments */
    filename?: string;
    /** MIME type */
    mimeType?: string;
  };
}

export interface SendResult {
  messageId: string;
  success: boolean;
}

export interface StreamingCardSession {
  start(initialText?: string): Promise<string>;
  update(fullText: string): Promise<void>;
  close(finalText?: string): Promise<void>;
}

export interface Button {
  label: string;
  callbackData: string;
  style?: 'primary' | 'danger' | 'default';
  /** URL button: opens link directly instead of sending callback */
  url?: string;
  /** Row index for layout grouping. Buttons with same row are on one line. */
  row?: number;
}
