/** Feishu rendered message - uses Card 2.0 JSON format */
export interface FeishuRenderedMessage {
  chatId: string;
  /** Plain text (fallback for simple messages) */
  text?: string;
  /** HTML content (converted to Feishu markdown via markdownToFeishu) */
  html?: string;
  /** Card header (template color + title) */
  feishuHeader?: {
    template: string;
    title: string;
  };
  /** Card 2.0 body elements (bypasses text→markdown conversion) */
  feishuElements?: Array<Record<string, unknown>>;
  /** Card action buttons (rendered as button elements) */
  feishuButtons?: import('../../ui/types.js').Button[];
  /** Generic buttons (fallback when feishuButtons not provided) */
  buttons?: import('../../ui/types.js').Button[];
  /** Override receive_id_type (default 'chat_id', can be 'open_id' for P2P) */
  receiveIdType?: string;
  /** Reply to a specific message (root_id in Feishu) */
  replyToMessageId?: string;
  /** Media attachment */
  media?: import('../media-types.js').MediaAttachment;
}