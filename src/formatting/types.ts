/** Permission card input data */
export interface PermissionCardData {
  toolName: string;
  toolInput: string;
  permissionId: string;
  expiresInMinutes?: number;
  terminalUrl?: string;
}

/** Hook notification input data */
export interface NotificationData {
  type: 'stop' | 'idle_prompt' | 'generic';
  title: string;
  summary?: string;
  terminalUrl?: string;
}

/** Feishu card element (re-exported for convenience) */
export interface FeishuCardElement {
  tag: string;
  content?: string;
  elements?: Array<{ tag: string; content: string }>;
  actions?: Array<{
    tag: string;
    text: { tag: string; content: string };
    type: string;
    value: Record<string, string>;
  }>;
  /** For collapsible_panel */
  expanded?: boolean;
  header?: {
    title: { tag: string; content: string };
  };
  body?: {
    elements: Array<{ tag: string; content: string }>;
  };
  /** Allow arbitrary additional properties */
  [key: string]: unknown;
}
