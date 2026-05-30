import type { Config } from '../../shared/config.js';
import type { AgentProviderKind } from '../../shared/providers/kinds.js';
import {
  AgentProviderRegistry,
  type AgentProviderDescriptor,
} from '../../shared/providers/registry.js';
import type { RemoteClientRegistry } from '../clients/client-registry.js';
import { ClientBackedAgentProvider } from './client-backed-provider.js';

export function createClientBackedAgentProviderRegistry(
  config: Config,
  remoteClientRegistry: RemoteClientRegistry,
): AgentProviderRegistry {
  const providers = new Map<AgentProviderKind, ClientBackedAgentProvider>([
    [
      'claude',
      new ClientBackedAgentProvider({
        kind: 'claude',
        remoteClientRegistry,
      }),
    ],
    [
      'codex',
      new ClientBackedAgentProvider({
        kind: 'codex',
        remoteClientRegistry,
      }),
    ],
    [
      'pi',
      new ClientBackedAgentProvider({
        kind: 'pi',
        remoteClientRegistry,
      }),
    ],
  ]);

  const effectiveDefaultKind = providers.has(config.provider) ? config.provider : 'claude';
  const descriptors = new Map<AgentProviderKind, AgentProviderDescriptor>([
    [
      'claude',
      {
        kind: 'claude',
        displayName: 'Remote Claude Code',
        available: true,
        isDefault: effectiveDefaultKind === 'claude',
        reason: 'execution client provider',
      },
    ],
    [
      'codex',
      {
        kind: 'codex',
        displayName: 'Remote Codex',
        available: true,
        isDefault: effectiveDefaultKind === 'codex',
        reason: 'execution client provider',
      },
    ],
    [
      'pi',
      {
        kind: 'pi',
        displayName: 'Remote Pi',
        available: true,
        isDefault: effectiveDefaultKind === 'pi',
        reason: 'execution client provider',
      },
    ],
  ]);

  return new AgentProviderRegistry(effectiveDefaultKind, providers, descriptors);
}
