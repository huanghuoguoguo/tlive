import type { ClaudeSDKProvider } from './providers/claude-sdk.js';
import type { JsonFileStore } from './store/json-file.js';
import type { CoreClientImpl } from './core-client.js';
import type { ProviderCapabilities, LiveSession } from './providers/base.js';

export type { ProviderCapabilities, LiveSession };

export interface BridgeContext {
  store: JsonFileStore;
  llm: ClaudeSDKProvider;
  core: CoreClientImpl | null;
  defaultWorkdir: string;
}

const CONTEXT_KEY = '__termlive_bridge_context__';

export function initBridgeContext(ctx: BridgeContext): void {
  (globalThis as Record<string, unknown>)[CONTEXT_KEY] = ctx;
}

export function getBridgeContext(): BridgeContext {
  const ctx = (globalThis as Record<string, unknown>)[CONTEXT_KEY];
  if (!ctx) throw new Error('BridgeContext not initialized. Call initBridgeContext() first.');
  return ctx as BridgeContext;
}
