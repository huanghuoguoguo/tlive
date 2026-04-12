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
