/** File attachment for inbound messages */
export interface FileAttachment {
  type: 'image' | 'file';
  name: string;
  mimeType: string;
  base64Data: string;
  /** URL to fetch the file content (used when base64Data is empty) */
  url?: string;
}

/** Media attachment for outbound messages */
export interface MediaAttachment {
  type: 'image' | 'file';
  /** URL to fetch, or data URI (data:image/png;base64,...) */
  url?: string;
  /** Raw buffer data */
  buffer?: Buffer;
  /** Filename for file attachments */
  filename?: string;
  /** MIME type */
  mimeType?: string;
}