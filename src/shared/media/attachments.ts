/** File attachment for inbound messages and LLM input. */
export interface FileAttachment {
  type: 'image' | 'file';
  name: string;
  mimeType: string;
  base64Data: string;
  /** Local path where the attachment was persisted for Agent to inspect. */
  localPath?: string;
  /** URL to fetch the file content when base64Data is empty. */
  url?: string;
}

/** Media attachment for outbound messages. */
export interface MediaAttachment {
  type: 'image' | 'file';
  /** URL to fetch, or data URI such as data:image/png;base64,... */
  url?: string;
  /** Raw buffer data. */
  buffer?: Buffer;
  /** Filename for file attachments. */
  filename?: string;
  /** MIME type. */
  mimeType?: string;
}
