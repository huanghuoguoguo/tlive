import type { AgentProviderKind } from '../../shared/providers/kinds.js';
import type { AgentProviderRegistry } from './registry.js';

export function historyProviderKinds(registry: AgentProviderRegistry): AgentProviderKind[] {
  const available = registry.availableForNewSession().filter((provider) => provider.available);
  if (available.length > 0) return available.map((provider) => provider.kind);
  return [registry.defaultProviderKind];
}
