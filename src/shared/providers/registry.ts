import type { AgentProvider } from './base.js';
import { DEFAULT_AGENT_PROVIDER_KIND, type AgentProviderKind } from './kinds.js';

export interface AgentProviderDescriptor {
  kind: AgentProviderKind;
  displayName: string;
  available: boolean;
  isDefault: boolean;
  cliPath?: string;
  version?: string;
  reason?: string;
}

export class AgentProviderRegistry {
  constructor(
    private readonly defaultKind: AgentProviderKind,
    private readonly providers: Map<AgentProviderKind, AgentProvider>,
    private readonly descriptors: Map<AgentProviderKind, AgentProviderDescriptor>,
  ) {}

  get defaultProviderKind(): AgentProviderKind {
    return this.defaultKind;
  }

  get defaultProvider(): AgentProvider {
    const provider = this.get(this.defaultKind) ?? this.providers.values().next().value;
    if (!provider) throw new Error('No agent provider is configured');
    return provider;
  }

  get(kind: AgentProviderKind | undefined): AgentProvider | undefined {
    return this.providers.get(kind ?? this.defaultKind);
  }

  require(kind: AgentProviderKind | undefined): AgentProvider {
    const provider = this.get(kind);
    if (!provider) throw new Error(`Agent provider is unavailable: ${kind ?? this.defaultKind}`);
    return provider;
  }

  descriptor(kind: AgentProviderKind): AgentProviderDescriptor | undefined {
    return this.descriptors.get(kind);
  }

  list(): AgentProviderDescriptor[] {
    return [...this.descriptors.values()];
  }

  configuredProviders(): AgentProvider[] {
    return [...this.providers.values()];
  }

  availableForNewSession(): AgentProviderDescriptor[] {
    const available = this.list().filter((provider) => provider.available);
    if (available.length > 0) return available;
    const fallback = this.descriptor(this.defaultKind);
    return fallback ? [fallback] : [];
  }

  isKnown(kind: string | undefined): kind is AgentProviderKind {
    return kind === 'claude' || kind === 'codex' || kind === 'pi';
  }

  isAvailable(kind: AgentProviderKind): boolean {
    return !!this.descriptor(kind)?.available;
  }
}

export function singleProviderRegistry(provider: AgentProvider): AgentProviderRegistry {
  const kind = provider.kind ?? DEFAULT_AGENT_PROVIDER_KIND;
  const descriptor: AgentProviderDescriptor = {
    kind,
    displayName: provider.displayName,
    available: true,
    isDefault: true,
  };
  return new AgentProviderRegistry(
    kind,
    new Map([[kind, provider]]),
    new Map([[kind, descriptor]]),
  );
}
