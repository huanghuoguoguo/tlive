import type { AgentProviderKind } from '../../shared/providers/kinds.js';
import type { AgentSettingSource } from '../../shared/config.js';

export interface ChannelBinding {
  channelType: string;
  chatId: string;
  sessionId: string; // internal key (used for locks, dedup)
  sdkSessionId?: string; // Provider runtime session UUID (for resume)
  provider?: AgentProviderKind; // agent runtime for this logical session
  /** Execution client for this logical session. Omitted means local/default. */
  clientId?: string;
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
  listBindings(): Promise<ChannelBinding[]>;

  // Locks
  acquireLock(key: string, ttlMs: number): Promise<boolean>;
  releaseLock(key: string): Promise<void>;
}
