/** Agent settings source types. */
import type { AgentProviderKind } from '../providers/kinds.js';

export type AgentSettingSource = 'user' | 'project' | 'local';

/** Webhook default chat configuration */
export interface WebhookDefaultChat {
  /** Channel type. Only 'feishu' is supported. */
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
  /** Provider settings sources for this project. */
  agentSettingSources?: AgentSettingSource[];
  /** Default chat for webhook routing (optional) */
  webhookDefaultChat?: WebhookDefaultChat;
}

export interface ChannelBinding {
  channelType: string;
  chatId: string;
  sessionId: string; // internal key (used for locks, dedup)
  sdkSessionId?: string; // Provider runtime session UUID (for resume)
  provider?: AgentProviderKind; // agent runtime for this logical session
  cwd?: string; // current working directory for this chat
  agentSettingSources?: AgentSettingSource[]; // per-chat provider settings override
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
