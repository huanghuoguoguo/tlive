import type { Config } from '../../shared/config.js';
import type { AgentProvider } from '../../shared/providers/base.js';
import { ClaudeSDKProvider } from './claude-sdk.js';
import { CodexSDKProvider } from './codex-sdk.js';
import { detectClaudeCli, detectCodexCli } from './cli-detection.js';
import { AgentProviderRegistry, type AgentProviderDescriptor } from './registry.js';
import type { AgentProviderKind } from '../../shared/providers/kinds.js';
import type { RemoteClientRegistry } from '../../server/clients/client-registry.js';
import { ClientBackedAgentProvider } from '../../server/clients/client-agent-provider.js';
import { loadCodexProviderConfig } from './codex-config.js';

export interface AgentProviderRegistryOptions {
  remoteClientRegistry?: RemoteClientRegistry;
}

export function createAgentProviderRegistry(
  config: Config,
  options: AgentProviderRegistryOptions = {},
): AgentProviderRegistry {
  const claude = detectClaudeCli();
  const codexConfig = loadCodexProviderConfig({ defaultModel: config.defaultModel });
  const codex = detectCodexCli(codexConfig.codexPath);

  const descriptors = new Map<AgentProviderKind, AgentProviderDescriptor>([
    [
      'claude',
      {
        kind: 'claude',
        displayName: 'Claude',
        available: claude.available,
        isDefault: config.provider === 'claude',
        cliPath: claude.path,
        version: claude.version,
        reason: claude.reason,
      },
    ],
    [
      'codex',
      {
        kind: 'codex',
        displayName: 'Codex',
        available: codex.available,
        isDefault: config.provider === 'codex',
        cliPath: codex.path,
        version: codex.version,
        reason: codex.reason,
      },
    ],
  ]);

  const useClientBackedProviders = Boolean(options.remoteClientRegistry);
  const providers = new Map<AgentProviderKind, AgentProvider>();

  const localClaude =
    !useClientBackedProviders && (claude.available || config.provider === 'claude')
      ? new ClaudeSDKProvider(config.agentSettingSources)
      : undefined;
  const localCodex =
    !useClientBackedProviders && (codex.available || config.provider === 'codex')
      ? new CodexSDKProvider({
          ...codexConfig,
          ...(codex.path || codexConfig.codexPath
            ? { codexPath: codex.path ?? codexConfig.codexPath }
            : {}),
        })
      : undefined;

  if (useClientBackedProviders) {
    providers.set(
      'claude',
      new ClientBackedAgentProvider({
        kind: 'claude',
        remoteClientRegistry: options.remoteClientRegistry!,
      }),
    );
    const descriptor = descriptors.get('claude');
    if (descriptor) {
      descriptor.displayName = 'Remote Claude Code';
      descriptor.available = true;
      descriptor.reason = 'execution client provider';
    }
  } else if (localClaude) {
    providers.set('claude', localClaude);
  }

  if (useClientBackedProviders) {
    providers.set(
      'codex',
      new ClientBackedAgentProvider({
        kind: 'codex',
        remoteClientRegistry: options.remoteClientRegistry!,
      }),
    );
    const descriptor = descriptors.get('codex');
    if (descriptor) {
      descriptor.displayName = 'Remote Codex';
      descriptor.available = true;
      descriptor.reason = 'execution client provider';
    }
  } else if (localCodex) {
    providers.set('codex', localCodex);
  }

  const effectiveDefaultKind =
    (providers.has(config.provider) ? config.provider : providers.keys().next().value) ??
    config.provider;
  for (const descriptor of descriptors.values()) {
    descriptor.isDefault = descriptor.kind === effectiveDefaultKind;
  }

  return new AgentProviderRegistry(effectiveDefaultKind, providers, descriptors);
}
