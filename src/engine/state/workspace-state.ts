import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chatKey as buildChatKey } from '../../core/key.js';

/**
 * Per-chat workspace history and binding state.
 * Tracks directory history for quick navigation (/cd -) and workspace binding.
 */
export interface WorkspaceState {
  /** Directory history (last N visited directories) */
  history: string[];
  /** Long-term workspace binding (repo this chat primarily serves) */
  binding?: string;
}

/**
 * Manages per-chat workspace state: directory history and workspace binding.
 * Persisted to disk so it survives restarts.
 *
 * Features:
 * - Directory history for /cd - (back to previous directory)
 * - Workspace binding for stable repo attribution
 * - History deduplication and size limit (max 10)
 * - Debounced persistence
 */
export class WorkspaceStateManager {
  /** Per-chat workspace state: channelType:chatId → WorkspaceState */
  private stateByChat = new Map<string, WorkspaceState>();
  private persistPath: string | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SAVE_DEBOUNCE_MS = 2000;
  /** Maximum history entries per chat */
  static readonly MAX_HISTORY_SIZE = 10;

  constructor(runtimeDir?: string) {
    if (runtimeDir) {
      this.persistPath = join(runtimeDir, 'workspace-state.json');
      this.loadPersisted();
    }
  }

  /** Combine channelType + chatId into a single map key */
  chatKey(channelType: string, chatId: string): string {
    return buildChatKey(channelType, chatId);
  }

  /**
   * Add a directory to the chat's history.
   * - Deduplicates (moves existing entry to front)
   * - Truncates to MAX_HISTORY_SIZE
   */
  pushHistory(channelType: string, chatId: string, cwd: string): void {
    const key = this.chatKey(channelType, chatId);
    const state = this.stateByChat.get(key) || { history: [] };

    // Remove existing entry if present (will be re-added at front)
    const existingIndex = state.history.indexOf(cwd);
    if (existingIndex !== -1) {
      state.history.splice(existingIndex, 1);
    }

    // Add to front
    state.history.unshift(cwd);

    // Truncate to max size
    if (state.history.length > WorkspaceStateManager.MAX_HISTORY_SIZE) {
      state.history = state.history.slice(0, WorkspaceStateManager.MAX_HISTORY_SIZE);
    }

    this.stateByChat.set(key, state);
    this.debouncedSave();
  }

  /**
   * Get the previous directory for /cd -.
   * Returns the second entry in history (first is current).
   */
  getPreviousDirectory(channelType: string, chatId: string): string | undefined {
    const key = this.chatKey(channelType, chatId);
    const state = this.stateByChat.get(key);
    // history[0] is current, history[1] is previous
    return state?.history[1];
  }

  /**
   * Get directory history for display.
   * Returns all entries (current is history[0]).
   */
  getHistory(channelType: string, chatId: string): string[] {
    const key = this.chatKey(channelType, chatId);
    const state = this.stateByChat.get(key);
    return state?.history || [];
  }

  /**
   * Set the workspace binding (long-term repo attribution).
   */
  setBinding(channelType: string, chatId: string, workdir: string): void {
    const key = this.chatKey(channelType, chatId);
    const state = this.stateByChat.get(key) || { history: [] };
    state.binding = workdir;
    this.stateByChat.set(key, state);
    this.debouncedSave();
  }

  /**
   * Get the workspace binding.
   */
  getBinding(channelType: string, chatId: string): string | undefined {
    const key = this.chatKey(channelType, chatId);
    const state = this.stateByChat.get(key);
    return state?.binding;
  }

  /**
   * Clear workspace binding for a chat.
   */
  clearBinding(channelType: string, chatId: string): void {
    const key = this.chatKey(channelType, chatId);
    const state = this.stateByChat.get(key);
    if (!state || state.binding === undefined) {
      return;
    }
    state.binding = undefined;
    this.stateByChat.set(key, state);
    this.debouncedSave();
  }

  /**
   * Clear workspace state for a chat (on /new or explicit unbind).
   */
  clear(channelType: string, chatId: string): void {
    const key = this.chatKey(channelType, chatId);
    this.stateByChat.delete(key);
    this.debouncedSave();
  }

  // --- Persistence ---

  private debouncedSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.savePersisted();
    }, WorkspaceStateManager.SAVE_DEBOUNCE_MS);
  }

  private loadPersisted(): void {
    if (!this.persistPath) return;
    try {
      const data: Record<string, WorkspaceState> = JSON.parse(readFileSync(this.persistPath, 'utf-8'));
      for (const [key, state] of Object.entries(data)) {
        // Validate state structure — ignore projectName for backward compatibility
        if (Array.isArray(state.history)) {
          this.stateByChat.set(key, {
            history: state.history.slice(0, WorkspaceStateManager.MAX_HISTORY_SIZE),
            binding: state.binding,
          });
        }
      }
    } catch {
      // File doesn't exist or invalid — start fresh
    }
  }

  private savePersisted(): void {
    if (!this.persistPath) return;
    const data: Record<string, WorkspaceState> = {};
    for (const [key, state] of this.stateByChat) {
      data[key] = state;
    }
    try {
      mkdirSync(join(this.persistPath, '..'), { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.warn('[workspace] Failed to persist state:', err);
    }
  }
}
