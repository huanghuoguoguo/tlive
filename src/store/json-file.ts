import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BridgeStore, ChannelBinding } from './interface.js';
import { chatKey as buildChatKey } from '../core/key.js';

/** Max entries to keep in processed IDs (prevents unbounded growth) */
const MAX_PROCESSED_IDS = 10000;

export class JsonFileStore implements BridgeStore {
  private dataDir: string;
  private bindings = new Map<string, ChannelBinding>(); // key: channelType:chatId
  private processedIds = new Map<string, number>(); // id -> timestamp
  private locks = new Map<string, number>(); // key -> expiresAt timestamp

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.loadFromDisk();
  }

  // ---- Helpers ----

  private bindingKey(channelType: string, chatId: string): string {
    return buildChatKey(channelType, chatId);
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

    // Load processed IDs (legacy format: string[], new format: Record<string, number>)
    const processed = this.readJson<string[] | Record<string, number>>(this.processedPath());
    if (processed) {
      const now = Date.now();
      if (Array.isArray(processed)) {
        // Legacy format: convert to map with current timestamp
        for (const id of processed) {
          this.processedIds.set(id, now);
        }
      } else {
        // New format: direct map
        for (const [id, ts] of Object.entries(processed)) {
          this.processedIds.set(id, ts as number);
        }
      }
    }
  }

  // ---- Bindings ----

  async getBinding(channelType: string, chatId: string): Promise<ChannelBinding | null> {
    return this.bindings.get(this.bindingKey(channelType, chatId)) ?? null;
  }

  async getBindingBySessionId(sessionId: string): Promise<ChannelBinding | null> {
    // Match by sdkSessionId (Claude session) or sessionId (internal)
    for (const binding of this.bindings.values()) {
      if (binding.sdkSessionId === sessionId || binding.sessionId === sessionId) {
        return binding;
      }
    }
    return null;
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
    const now = Date.now();
    this.processedIds.set(messageId, now);

    // Prune old entries if over limit (keep most recent half)
    if (this.processedIds.size > MAX_PROCESSED_IDS) {
      const entries = [...this.processedIds.entries()];
      entries.sort((a, b) => b[1] - a[1]); // Sort by timestamp descending
      this.processedIds = new Map(entries.slice(0, MAX_PROCESSED_IDS / 2));
    }

    this.atomicWrite(this.processedPath(), [...this.processedIds.keys()]);
  }

  // ---- Locks ----

  async acquireLock(key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const expiresAt = this.locks.get(key);
    if (expiresAt !== undefined && expiresAt > now) {
      return false;
    }
    this.locks.set(key, now + ttlMs);
    return true;
  }

  async renewLock(key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const expiresAt = this.locks.get(key);
    if (expiresAt === undefined || expiresAt <= now) {
      return false;
    }
    this.locks.set(key, now + ttlMs);
    return true;
  }

  async releaseLock(key: string): Promise<void> {
    this.locks.delete(key);
  }
}
