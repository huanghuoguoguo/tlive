export interface SessionData {
  id: string;
  sdkSessionId?: string;
  workingDirectory: string;
  model?: string;
  mode?: string;
  createdAt: string;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface ChannelBinding {
  channelType: string;
  chatId: string;
  sessionId: string;
  createdAt: string;
}

export interface BridgeStore {
  // Sessions
  getSession(id: string): Promise<SessionData | null>;
  saveSession(session: SessionData): Promise<void>;
  listSessions(): Promise<SessionData[]>;
  deleteSession(id: string): Promise<void>;

  // Messages
  getMessages(sessionId: string): Promise<Message[]>;
  saveMessage(sessionId: string, message: Message): Promise<void>;

  // Bindings
  getBinding(channelType: string, chatId: string): Promise<ChannelBinding | null>;
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
