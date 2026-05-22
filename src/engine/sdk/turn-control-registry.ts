import type { QueryControls } from '../../providers/base.js';

export interface TurnControlCleanupOptions {
  resolveFallbackSessionKey?: (chatKey: string) => string | undefined;
}

export class TurnControlRegistry {
  private activeControlsBySession = new Map<string, QueryControls>();
  private activeControlsByChat = new Map<string, QueryControls>();
  private controlChatBySession = new Map<string, string>();

  getActiveControls(): Map<string, QueryControls> {
    return this.activeControlsByChat;
  }

  getControlsForChat(chatKey: string): QueryControls | undefined {
    return this.activeControlsByChat.get(chatKey);
  }

  getControlsForSession(sessionKey: string): QueryControls | undefined {
    return this.activeControlsBySession.get(sessionKey);
  }

  setControlsForChat(
    chatKey: string,
    controls: QueryControls | undefined,
    sessionKey: string,
    options?: TurnControlCleanupOptions,
  ): void {
    if (controls) {
      this.activeControlsBySession.set(sessionKey, controls);
      this.activeControlsByChat.set(chatKey, controls);
      this.controlChatBySession.set(sessionKey, chatKey);
      return;
    }

    this.cleanupSessionControls(sessionKey, options);
  }

  moveSession(sessionKey: string, newSessionKey: string, newChatKey?: string): void {
    const oldChatKey = this.controlChatBySession.get(sessionKey);
    const controls = this.activeControlsBySession.get(sessionKey);

    if (controls) {
      this.activeControlsBySession.delete(sessionKey);
      this.activeControlsBySession.set(newSessionKey, controls);
    }

    if (oldChatKey) {
      this.controlChatBySession.delete(sessionKey);
      this.activeControlsByChat.delete(oldChatKey);
    }

    if (newChatKey) {
      this.controlChatBySession.set(newSessionKey, newChatKey);
      if (controls) {
        this.activeControlsByChat.set(newChatKey, controls);
      }
    }
  }

  cleanupSessionControls(sessionKey: string, options?: TurnControlCleanupOptions): void {
    this.activeControlsBySession.delete(sessionKey);
    const chatKey = this.controlChatBySession.get(sessionKey);
    if (!chatKey) return;

    this.controlChatBySession.delete(sessionKey);
    const fallbackSessionKey = options?.resolveFallbackSessionKey?.(chatKey);
    const fallbackControls = fallbackSessionKey
      ? this.activeControlsBySession.get(fallbackSessionKey)
      : undefined;

    if (fallbackControls) {
      this.activeControlsByChat.set(chatKey, fallbackControls);
      return;
    }

    this.activeControlsByChat.delete(chatKey);
  }

  consumeSessionControls(
    sessionKey: string,
    options?: TurnControlCleanupOptions,
  ): QueryControls | undefined {
    const controls = this.activeControlsBySession.get(sessionKey);
    if (!controls) return undefined;
    this.cleanupSessionControls(sessionKey, options);
    return controls;
  }

  consumeChatControls(
    chatKey: string,
    options?: TurnControlCleanupOptions,
  ): QueryControls | undefined {
    const controls = this.activeControlsByChat.get(chatKey);
    if (!controls) return undefined;

    const sessionKey = this.findSessionKeyForChat(chatKey);
    if (sessionKey) {
      this.cleanupSessionControls(sessionKey, options);
    } else {
      this.activeControlsByChat.delete(chatKey);
    }

    return controls;
  }

  private findSessionKeyForChat(chatKey: string): string | undefined {
    return [...this.controlChatBySession.entries()].find(([, key]) => key === chatKey)?.[0];
  }
}
