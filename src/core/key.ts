/**
 * Chat key utilities - unified key construction for channel:chat identification.
 */

/** Build a unique key for a channel+chat combination.
 * Format: `${channelType}:${chatId}`
 * Used consistently across SessionState, WorkspaceState, JsonFileStore, SDKEngine, etc.
 */
export function chatKey(channelType: string, chatId: string): string {
  return `${channelType}:${chatId}`;
}

/** Split a chat key while preserving ':' characters inside chatId/scopeId. */
export function splitChatKey(key: string): { channelType: string; chatId: string } {
  const idx = key.indexOf(':');
  if (idx < 0) return { channelType: key, chatId: '' };
  return { channelType: key.slice(0, idx), chatId: key.slice(idx + 1) };
}

export interface SessionKeyParts {
  channelType: string;
  chatId: string;
  bindingSessionId: string;
}

/** Build a logical runtime session key.
 *
 * Only split on the first and last separator: chatId/scopeId may itself contain ':'.
 */
export function sessionKey(
  channelType: string,
  chatId: string,
  bindingSessionId: string,
): string {
  return `${channelType}:${chatId}:${bindingSessionId}`;
}

/** Split a logical runtime session key while preserving ':' inside chatId/scopeId. */
export function splitSessionKey(key: string): SessionKeyParts | undefined {
  const first = key.indexOf(':');
  const last = key.lastIndexOf(':');
  if (first <= 0 || last <= first) return undefined;
  return {
    channelType: key.slice(0, first),
    chatId: key.slice(first + 1, last),
    bindingSessionId: key.slice(last + 1),
  };
}

/** Separator used to derive a logical chat scope from a platform thread/topic. */
export const THREAD_SCOPE_SEPARATOR = '#thread:';

/** Build the logical scope id used for state/session binding. */
export function chatScopeId(chatId: string, threadId?: string): string {
  return threadId ? `${chatId}${THREAD_SCOPE_SEPARATOR}${threadId}` : chatId;
}

/** Extract a platform thread/topic id from a logical scope id. */
export function threadIdFromScope(chatId: string, scopeId: string): string | undefined {
  const prefix = `${chatId}${THREAD_SCOPE_SEPARATOR}`;
  return scopeId.startsWith(prefix) ? scopeId.slice(prefix.length) : undefined;
}

/** Whether a logical scope id represents a platform topic/thread. */
export function isThreadScopeId(scopeId?: string): boolean {
  return !!scopeId?.includes(THREAD_SCOPE_SEPARATOR);
}

/** Resolve the logical scope id for an inbound message-like object. */
export function messageScopeId(message: {
  chatId: string;
  threadId?: string;
  scopeId?: string;
}): string {
  return message.scopeId || chatScopeId(message.chatId, message.threadId);
}
