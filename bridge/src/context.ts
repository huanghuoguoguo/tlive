import type { LLMProvider } from './providers/base.js';
import type { BridgeStore } from './store/interface.js';
import type { ProviderCapabilities, LiveSession } from './providers/base.js';

export type { ProviderCapabilities, LiveSession };

export interface BridgeContext {
  store: BridgeStore;
  llm: LLMProvider;
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