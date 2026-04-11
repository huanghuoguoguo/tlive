import type { ClaudeSettingSource } from '../config.js';

export interface ChannelBinding {
  channelType: string;
  chatId: string;
  sessionId: string;           // internal key (used for locks, dedup)
  sdkSessionId?: string;       // Claude SDK session UUID (for resume)
  cwd?: string;                // current working directory for this chat
  claudeSettingSources?: ClaudeSettingSource[]; // per-chat Claude settings override
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
