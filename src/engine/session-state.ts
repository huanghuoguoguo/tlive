import type { SessionMode } from '../messages/types.js';
import type { EffortLevel } from '../utils/types.js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export type VerboseLevel = 0 | 1;

/** Persisted state shape (saved to disk) */
interface PersistedState {
  permModes: Record<string, 'on' | 'off'>;
}

/**
 * Manages per-chat session state: verbose levels, permission modes, effort,
 * processing guards, activity tracking, and thread bindings.
 *
 * Extracted from BridgeManager to keep session bookkeeping in one place.
 * Permission modes are persisted to disk so they survive restarts.
 */
export class SessionStateManager {
  private verboseLevels = new Map<string, VerboseLevel>();
  private modes = new Map<string, SessionMode>();
  private processingChats = new Map<string, number>();
  private lastActive = new Map<string, number>();
  private sessionThreads = new Map<string, string>();
  private persistPath: string | undefined;

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

  getVerboseLevel(channelType: string, chatId: string): VerboseLevel {
    return this.verboseLevels.get(this.stateKey(channelType, chatId)) ?? 1;
  }

  setVerboseLevel(channelType: string, chatId: string, level: VerboseLevel): void {
    this.verboseLevels.set(this.stateKey(channelType, chatId), level);
  }

  getPermMode(channelType: string, chatId: string): 'on' | 'off' {
    // QQ Bot doesn't support interactive buttons → default to auto-approve
    if (channelType === 'qqbot') return 'off';
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

  getEffort(channelType: string, chatId: string): EffortLevel | undefined {
    return this.modes.get(this.stateKey(channelType, chatId))?.effort;
  }

  setEffort(channelType: string, chatId: string, level: EffortLevel): void {
    const key = this.stateKey(channelType, chatId);
    const current = this.modes.get(key) || this.defaultMode();
    current.effort = level;
    this.modes.set(key, current);
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

  getModel(channelType: string, chatId: string): string | undefined {
    return this.modes.get(this.stateKey(channelType, chatId))?.model;
  }

  setModel(channelType: string, chatId: string, model: string | undefined): void {
    const key = this.stateKey(channelType, chatId);
    const current = this.modes.get(key) || this.defaultMode();
    current.model = model;
    this.modes.set(key, current);
  }

  // --- Persistence ---

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
    try {
      mkdirSync(join(this.persistPath, '..'), { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify({ permModes }, null, 2));
    } catch (err) {
      console.warn('[session] Failed to persist state:', err);
    }
  }
}
