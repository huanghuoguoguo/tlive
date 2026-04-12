/** Claude settings source types */
export type ClaudeSettingSource = 'user' | 'project' | 'local';

/** Webhook default chat configuration */
export interface WebhookDefaultChat {
  /** Channel type (e.g., 'telegram', 'feishu') */
  channelType: string;
  /** Chat ID to route webhook messages to */
  chatId: string;
}

/** Project configuration for multi-repo support */
export interface ProjectConfig {
  /** Project name (unique identifier) */
  name: string;
  /** Default working directory */
  workdir: string;
  /** Channels enabled for this project (optional, defaults to all) */
  channels?: string[];
  /** Claude settings sources for this project */
  claudeSettingSources?: ClaudeSettingSource[];
  /** Default chat for webhook routing (optional) */
  webhookDefaultChat?: WebhookDefaultChat;
}

export interface ChannelBinding {
  channelType: string;
  chatId: string;
  sessionId: string;           // internal key (used for locks, dedup)
  sdkSessionId?: string;       // Claude SDK session UUID (for resume)
  cwd?: string;                // current working directory for this chat
  claudeSettingSources?: ClaudeSettingSource[]; // per-chat Claude settings override
  /** Project binding (optional, for multi-project support) */
  projectName?: string;
  createdAt: string;
}

export interface BridgeStore {
  // Bindings
  getBinding(channelType: string, chatId: string): Promise<ChannelBinding | null>;
  getBindingBySessionId(sessionId: string): Promise<ChannelBinding | null>;
  saveBinding(binding: ChannelBinding): Promise<void>;
  deleteBinding(channelType: string, chatId: string): Promise<void>;
  listBindings(): Promise<ChannelBinding[]>;

  // Dedup
  isDuplicate(messageId: string): Promise<boolean>;
  markProcessed(messageId: string): Promise<void>;

  // Locks
  acquireLock(key: string, ttlMs: number): Promise<boolean>;
  renewLock(key: string, ttlMs: number): Promise<boolean>;
  releaseLock(key: string): Promise<void>;
}
