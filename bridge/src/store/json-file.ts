import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BridgeStore, SessionData, Message, ChannelBinding } from './interface.js';

export class JsonFileStore implements BridgeStore {
  private dataDir: string;
  private sessions = new Map<string, SessionData>();
  private messages = new Map<string, Message[]>(); // key: sessionId
  private bindings = new Map<string, ChannelBinding>(); // key: channelType:chatId
  private processedIds = new Set<string>();
  private locks = new Map<string, number>(); // key -> expiresAt timestamp

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(join(dataDir, 'sessions'), { recursive: true });
    mkdirSync(join(dataDir, 'messages'), { recursive: true });
    this.loadFromDisk();
  }

  // ---- Helpers ----

  private bindingKey(channelType: string, chatId: string): string {
    return `${channelType}:${chatId}`;
  }

  private atomicWrite(filePath: string, data: unknown): void {
    const tmp = filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, filePath);
  }

  private readJson<T>(filePath: string): T | null {
    if (!existsSync(filePath)) return null;
    try {
      return JSON.parse(readFileSync(filePath, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  private sessionPath(id: string): string {
    return join(this.dataDir, 'sessions', `${id}.json`);
  }

  private messagesPath(sessionId: string): string {
    return join(this.dataDir, 'messages', `${sessionId}.json`);
  }

  private bindingsPath(): string {
    return join(this.dataDir, 'bindings.json');
  }

  private processedPath(): string {
    return join(this.dataDir, 'processed.json');
  }

  private loadFromDisk(): void {
    // Load bindings
    const bindings = this.readJson<Record<string, ChannelBinding>>(this.bindingsPath());
    if (bindings) {
      for (const [key, val] of Object.entries(bindings)) {
        this.bindings.set(key, val);
      }
    }

    // Load processed IDs
    const processed = this.readJson<string[]>(this.processedPath());
    if (processed) {
      for (const id of processed) {
        this.processedIds.add(id);
      }
    }

    // Sessions are loaded lazily via individual files; scan directory for index
    // We load them on demand rather than eagerly to keep init fast.
    // However, listSessions() needs to know all IDs. We keep a sessions index file.
    const indexPath = join(this.dataDir, 'sessions-index.json');
    const index = this.readJson<string[]>(indexPath);
    if (index) {
      for (const id of index) {
        const data = this.readJson<SessionData>(this.sessionPath(id));
        if (data) this.sessions.set(id, data);
      }
    }

    // Load messages index
    const msgsIndexPath = join(this.dataDir, 'messages-index.json');
    const msgsIndex = this.readJson<string[]>(msgsIndexPath);
    if (msgsIndex) {
      for (const sessionId of msgsIndex) {
        const msgs = this.readJson<Message[]>(this.messagesPath(sessionId));
        if (msgs) this.messages.set(sessionId, msgs);
      }
    }
  }

  private persistSessionsIndex(): void {
    const indexPath = join(this.dataDir, 'sessions-index.json');
    this.atomicWrite(indexPath, [...this.sessions.keys()]);
  }

  private persistMessagesIndex(): void {
    const indexPath = join(this.dataDir, 'messages-index.json');
    this.atomicWrite(indexPath, [...this.messages.keys()]);
  }

  // ---- Sessions ----

  async getSession(id: string): Promise<SessionData | null> {
    return this.sessions.get(id) ?? null;
  }

  async saveSession(session: SessionData): Promise<void> {
    this.sessions.set(session.id, session);
    this.atomicWrite(this.sessionPath(session.id), session);
    this.persistSessionsIndex();
  }

  async listSessions(): Promise<SessionData[]> {
    return [...this.sessions.values()];
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
    const path = this.sessionPath(id);
    if (existsSync(path)) unlinkSync(path);
    this.persistSessionsIndex();
  }

  // ---- Messages ----

  async getMessages(sessionId: string): Promise<Message[]> {
    return this.messages.get(sessionId) ?? [];
  }

  async saveMessage(sessionId: string, message: Message): Promise<void> {
    const existing = this.messages.get(sessionId) ?? [];
    existing.push(message);
    this.messages.set(sessionId, existing);
    this.atomicWrite(this.messagesPath(sessionId), existing);
    this.persistMessagesIndex();
  }

  // ---- Bindings ----

  async getBinding(channelType: string, chatId: string): Promise<ChannelBinding | null> {
    return this.bindings.get(this.bindingKey(channelType, chatId)) ?? null;
  }

  async saveBinding(binding: ChannelBinding): Promise<void> {
    const key = this.bindingKey(binding.channelType, binding.chatId);
    this.bindings.set(key, binding);
    this.persistBindings();
  }

  async deleteBinding(channelType: string, chatId: string): Promise<void> {
    this.bindings.delete(this.bindingKey(channelType, chatId));
    this.persistBindings();
  }

  async listBindings(): Promise<ChannelBinding[]> {
    return [...this.bindings.values()];
  }

  private persistBindings(): void {
    const obj: Record<string, ChannelBinding> = {};
    for (const [key, val] of this.bindings.entries()) {
      obj[key] = val;
    }
    this.atomicWrite(this.bindingsPath(), obj);
  }

  // ---- Dedup ----

  async isDuplicate(messageId: string): Promise<boolean> {
    return this.processedIds.has(messageId);
  }

  async markProcessed(messageId: string): Promise<void> {
    this.processedIds.add(messageId);
    this.atomicWrite(this.processedPath(), [...this.processedIds]);
  }

  // ---- Locks ----

  async acquireLock(key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const expiresAt = this.locks.get(key);
    if (expiresAt !== undefined && expiresAt > now) {
      // Lock is currently held and not expired
      return false;
    }
    // Acquire (or take over expired lock)
    this.locks.set(key, now + ttlMs);
    return true;
  }

  async renewLock(key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const expiresAt = this.locks.get(key);
    if (expiresAt === undefined || expiresAt <= now) {
      // Lock not held or already expired — cannot renew
      return false;
    }
    this.locks.set(key, now + ttlMs);
    return true;
  }

  async releaseLock(key: string): Promise<void> {
    this.locks.delete(key);
  }
}
