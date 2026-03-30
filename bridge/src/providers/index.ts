import { ClaudeSDKProvider } from './claude-sdk.js';
import { CodexProvider } from './codex-provider.js';
import type { LLMProvider } from './base.js';
import type { PendingPermissions } from '../permissions/gateway.js';
import type { ClaudeSettingSource } from '../config.js';

export interface ProviderOptions {
  claudeSettingSources?: ClaudeSettingSource[];
}

export function resolveProvider(runtime: string, permissions: PendingPermissions, options?: ProviderOptions): LLMProvider {
  switch (runtime) {
    case 'codex':
      return new CodexProvider();
    case 'claude':
    case 'auto':
    default:
      return new ClaudeSDKProvider(permissions, options?.claudeSettingSources);
  }
}

// Cached Codex availability check (resolved once on first call)
let _codexAvailable: boolean | null = null;
let _codexCheckPromise: Promise<boolean> | null = null;

/** Check if Codex SDK is installed. First call triggers async import, subsequent calls return cached result. */
export function isCodexAvailable(): boolean {
  if (_codexAvailable !== null) return _codexAvailable;
  // Kick off check if not started yet
  if (!_codexCheckPromise) {
    _codexCheckPromise = import('@openai/codex-sdk')
      .then((mod) => {
        _codexAvailable = !!(mod.Codex || (mod as any).default?.Codex);
        return _codexAvailable;
      })
      .catch(() => {
        _codexAvailable = false;
        return false;
      });
  }
  // First sync call before promise resolves — assume unavailable
  return false;
}

/** Async version: await this for accurate result */
export async function checkCodexAvailable(): Promise<boolean> {
  if (_codexAvailable !== null) return _codexAvailable;
  if (!_codexCheckPromise) {
    isCodexAvailable(); // triggers the check
  }
  return _codexCheckPromise!;
}

export { ClaudeSDKProvider } from './claude-sdk.js';
export { CodexProvider } from './codex-provider.js';
export type { PermissionTimeoutCallback } from './claude-sdk.js';
export type { LLMProvider, StreamChatParams } from './base.js';
