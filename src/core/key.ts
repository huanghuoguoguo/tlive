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