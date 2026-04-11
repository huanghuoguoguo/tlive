import type { SessionMode } from '../messages/types.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type VerboseLevel = 0 | 1;

/** Persisted state shape (saved to disk) */
interface PersistedState {
  permModes: Record<string, 'on' | 'off'>;
  userLastChats: Record<string, { channelType: string; chatId: string; timestamp: number }>;
}

/**
 * Manages per-chat session state: permission modes,
 * processing guards, activity tracking, and thread bindings.
 *
 * Extracted from BridgeManager to keep session bookkeeping in one place.
 * Permission modes are persisted to disk so they survive restarts.
 */
export class SessionStateManager {
  private modes = new Map<string, SessionMode>();
  private processingChats = new Map<string, number>();
  private lastActive = new Map<string, number>();
  private sessionThreads = new Map<string, string>();
  /** User's last active chat: userId -> { channelType, chatId, timestamp } */
  private userLastChats = new Map<string, { channelType: string; chatId: string; timestamp: number }>();
  private persistPath: string | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SAVE_DEBOUNCE_MS = 2000;

  constructor(runtimeDir?: string) {
    if (runtimeDir) {
      this.persistPath = join(runtimeDir, 'session-state.json');
      this.loadPersisted();
    }
  }

  private defaultMode(): SessionMode {
    return { permissionMode: 'default' };
  }

  /** Combine channelType + chatId into a single map key */
  stateKey(channelType: string, chatId: string): string {
    return `${channelType}:${chatId}`;
  }

  getPermMode(channelType: string, chatId: string): 'on' | 'off' {
    const mode = this.modes.get(this.stateKey(channelType, chatId));
    if (!mode) return 'on';
    return mode.permissionMode === 'bypassPermissions' ? 'off' : 'on';
  }

  setPermMode(channelType: string, chatId: string, mode: 'on' | 'off'): void {
    const key = this.stateKey(channelType, chatId);
    const current = this.modes.get(key) || this.defaultMode();
    current.permissionMode = mode === 'off' ? 'bypassPermissions' : 'default';
    this.modes.set(key, current);
    this.savePersisted();
  }

  getSessionMode(channelType: string, chatId: string): SessionMode {
    return this.modes.get(this.stateKey(channelType, chatId)) || this.defaultMode();
  }

  isProcessing(chatKey: string): boolean {
    const start = this.processingChats.get(chatKey);
    if (!start) return false;
    // Auto-clear after 10 minutes (handler likely crashed)
    if (Date.now() - start > 10 * 60 * 1000) {
      console.warn(`[session] Processing flag expired for ${chatKey} (>10min)`);
      this.processingChats.delete(chatKey);
      return false;
    }
    return true;
  }

  setProcessing(chatKey: string, active: boolean): void {
    if (active) {
      this.processingChats.set(chatKey, Date.now());
    } else {
      this.processingChats.delete(chatKey);
    }
  }

  getThread(channelType: string, chatId: string): string | undefined {
    return this.sessionThreads.get(this.stateKey(channelType, chatId));
  }

  setThread(channelType: string, chatId: string, threadId: string): void {
    this.sessionThreads.set(this.stateKey(channelType, chatId), threadId);
  }

  clearThread(channelType: string, chatId: string): void {
    this.sessionThreads.delete(this.stateKey(channelType, chatId));
  }

  /**
   * Get the last active timestamp for a chat.
   * Returns undefined if no activity recorded, or the timestamp in milliseconds.
   */
  getLastActiveTime(channelType: string, chatId: string): number | undefined {
    return this.lastActive.get(this.stateKey(channelType, chatId));
  }

  /**
   * Get session age in milliseconds (time since last activity).
   * Returns undefined if no activity recorded, or the age in milliseconds.
   */
  getSessionAge(channelType: string, chatId: string): number | undefined {
    const last = this.lastActive.get(this.stateKey(channelType, chatId));
    if (!last) return undefined;
    return Date.now() - last;
  }

  /**
   * Check if session expired (>30 min inactivity) and update last-active timestamp.
   * Returns true if expired, false otherwise (including first call).
   */
  checkAndUpdateLastActive(channelType: string, chatId: string): boolean {
    const key = this.stateKey(channelType, chatId);
    const last = this.lastActive.get(key);
    const now = Date.now();
    this.lastActive.set(key, now);
    if (last && (now - last) > 30 * 60 * 1000) return true;
    return false;
  }

  clearLastActive(channelType: string, chatId: string): void {
    this.lastActive.delete(this.stateKey(channelType, chatId));
  }

  // --- User Last Active Chat (for menu fallback) ---

  /**
   * Record user's last active chat. Called when user sends a message.
   * This is used for menu events (which don't have chat context) to fallback.
   */
  setUserLastChat(userId: string, channelType: string, chatId: string): void {
    const existing = this.userLastChats.get(userId);
    if (existing?.channelType === channelType && existing?.chatId === chatId) {
      existing.timestamp = Date.now();
      return; // Same chat — skip persist, just update timestamp in memory
    }
    this.userLastChats.set(userId, {
      channelType,
      chatId,
      timestamp: Date.now(),
    });
    this.debouncedSave();
  }

  /**
   * Get user's last active chat. Used for menu event fallback.
   * Returns undefined if no recent activity (or activity too old).
   * @param maxAgeMs Maximum age in milliseconds (default 24 hours)
   */
  getUserLastChat(userId: string, maxAgeMs = 24 * 60 * 60 * 1000): { channelType: string; chatId: string } | undefined {
    const last = this.userLastChats.get(userId);
    if (!last) return undefined;
    // Too old - don't use stale chat context
    if (Date.now() - last.timestamp > maxAgeMs) {
      this.userLastChats.delete(userId);
      return undefined;
    }
    return { channelType: last.channelType, chatId: last.chatId };
  }

  /**
   * Clear user's last chat record. Called when user explicitly leaves/unbinds.
   */
  clearUserLastChat(userId: string): void {
    this.userLastChats.delete(userId);
    this.debouncedSave();
  }

  // --- Persistence ---

  private debouncedSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.savePersisted();
    }, SessionStateManager.SAVE_DEBOUNCE_MS);
  }

  private loadPersisted(): void {
    if (!this.persistPath) return;
    try {
      const data: PersistedState = JSON.parse(readFileSync(this.persistPath, 'utf-8'));
      if (data.permModes) {
        for (const [key, mode] of Object.entries(data.permModes)) {
          const current = this.modes.get(key) || this.defaultMode();
          current.permissionMode = mode === 'off' ? 'bypassPermissions' : 'default';
          this.modes.set(key, current);
        }
      }
      if (data.userLastChats) {
        for (const [userId, lastChat] of Object.entries(data.userLastChats)) {
          // Only load recent ones (<24 hours)
          if (Date.now() - lastChat.timestamp < 24 * 60 * 60 * 1000) {
            this.userLastChats.set(userId, lastChat);
          }
        }
      }
    } catch {
      // File doesn't exist or invalid — start fresh
    }
  }

  private savePersisted(): void {
    if (!this.persistPath) return;
    const permModes: Record<string, 'on' | 'off'> = {};
    for (const [key, mode] of this.modes) {
      if (mode.permissionMode === 'bypassPermissions') {
        permModes[key] = 'off';
      }
    }
    // Only persist recent user chats (<24 hours)
    const userLastChats: Record<string, { channelType: string; chatId: string; timestamp: number }> = {};
    const now = Date.now();
    for (const [userId, lastChat] of this.userLastChats) {
      if (now - lastChat.timestamp < 24 * 60 * 60 * 1000) {
        userLastChats[userId] = lastChat;
      }
    }
    try {
      mkdirSync(join(this.persistPath, '..'), { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify({ permModes, userLastChats }, null, 2));
    } catch (err) {
      console.warn('[session] Failed to persist state:', err);
    }
  }
}
