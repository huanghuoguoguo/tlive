import { ClaudeSDKProvider } from './claude-sdk.js';
import { CodexProvider } from './codex-provider.js';
import type { LLMProvider } from './base.js';
import type { PendingPermissions } from '../permissions/gateway.js';

export function resolveProvider(runtime: string, permissions: PendingPermissions): LLMProvider {
  switch (runtime) {
    case 'codex':
      return new CodexProvider();
    case 'claude':
    case 'auto':
    default:
      return new ClaudeSDKProvider(permissions);
  }
}

export { ClaudeSDKProvider } from './claude-sdk.js';
export { CodexProvider } from './codex-provider.js';
export type { PermissionTimeoutCallback } from './claude-sdk.js';
export type { LLMProvider, StreamChatParams } from './base.js';
