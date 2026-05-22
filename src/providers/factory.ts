import type { Config } from '../config.js';
import type { AgentProvider } from './base.js';
import { ClaudeSDKProvider } from './claude-sdk.js';
import { CodexSDKProvider } from './codex-sdk.js';
import { detectClaudeCli, detectCodexCli } from './cli-detection.js';
import { AgentProviderRegistry, type AgentProviderDescriptor } from './registry.js';
import type { AgentProviderKind } from './kinds.js';
import type { RemoteClientRegistry } from '../server/client-registry.js';
import { ClientBackedAgentProvider } from '../server/client-agent-provider.js';

export interface AgentProviderRegistryOptions {
  remoteClientRegistry?: RemoteClientRegistry;
}

export function createAgentProviderRegistry(
  config: Config,
  options: AgentProviderRegistryOptions = {},
): AgentProviderRegistry {
  const claude = detectClaudeCli();
  const codex = detectCodexCli(config.codex.codexPath || undefined);

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

  const remoteProviders = new Set(
    options.remoteClientRegistry && config.remote.server.enabled
      ? config.remote.server.providers
      : [],
  );
  const useClientBackedProviders = options.remoteClientRegistry && config.remote.server.enabled;
  const providers = new Map<AgentProviderKind, AgentProvider>();

  const localClaude =
    (config.remote.server.localClientEnabled || !useClientBackedProviders) &&
    (claude.available || config.provider === 'claude')
      ? new ClaudeSDKProvider(config.agentSettingSources)
      : undefined;
  const localCodex =
    (config.remote.server.localClientEnabled || !useClientBackedProviders) &&
    (codex.available || config.provider === 'codex')
      ? new CodexSDKProvider({
          ...(codex.path || config.codex.codexPath
            ? { codexPath: codex.path ?? config.codex.codexPath }
            : {}),
          ...(config.codex.model ? { model: config.codex.model } : {}),
          sandboxMode: config.codex.sandboxMode,
          approvalPolicy: config.codex.approvalPolicy,
          skipGitRepoCheck: config.codex.skipGitRepoCheck,
          ...(config.codex.modelReasoningEffort
            ? { modelReasoningEffort: config.codex.modelReasoningEffort }
            : {}),
          ...(config.codex.networkAccessEnabled !== undefined
            ? { networkAccessEnabled: config.codex.networkAccessEnabled }
            : {}),
          ...(config.codex.webSearchMode ? { webSearchMode: config.codex.webSearchMode } : {}),
        })
      : undefined;

  if (useClientBackedProviders && (remoteProviders.has('claude') || localClaude)) {
    providers.set(
      'claude',
      new ClientBackedAgentProvider({
        kind: 'claude',
        localProvider: localClaude,
        remoteClientRegistry: remoteProviders.has('claude')
          ? options.remoteClientRegistry
          : undefined,
      }),
    );
    const descriptor = descriptors.get('claude');
    if (descriptor) {
      descriptor.displayName = localClaude ? 'Claude Code' : 'Remote Claude Code';
      descriptor.available = true;
      descriptor.reason = 'client-backed provider';
    }
  } else if (localClaude) {
    providers.set('claude', localClaude);
  }

  if (useClientBackedProviders && (remoteProviders.has('codex') || localCodex)) {
    providers.set(
      'codex',
      new ClientBackedAgentProvider({
        kind: 'codex',
        localProvider: localCodex,
        remoteClientRegistry: remoteProviders.has('codex') ? options.remoteClientRegistry : undefined,
      }),
    );
    const descriptor = descriptors.get('codex');
    if (descriptor) {
      descriptor.displayName = localCodex ? 'Codex' : 'Remote Codex';
      descriptor.available = true;
      descriptor.reason = 'client-backed provider';
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
