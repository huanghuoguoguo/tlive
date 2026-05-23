import type { Config } from '../../shared/config.js';
import type { AgentProvider } from '../../shared/providers/base.js';
import type { AgentProviderKind } from '../../shared/providers/kinds.js';
import {
  AgentProviderRegistry,
  type AgentProviderDescriptor,
} from '../../shared/providers/registry.js';
import { ClaudeSDKProvider } from './claude-sdk.js';
import { CodexSDKProvider } from './codex-sdk.js';
import { loadCodexProviderConfig } from './codex-config.js';
import { detectClaudeCli, detectCodexCli } from './cli-detection.js';

export function createLocalAgentProviderRegistry(config: Config): AgentProviderRegistry {
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

  const providers = new Map<AgentProviderKind, AgentProvider>();
  if (claude.available || config.provider === 'claude') {
    providers.set('claude', new ClaudeSDKProvider(config.agentSettingSources));
  }
  if (codex.available || config.provider === 'codex') {
    providers.set(
      'codex',
      new CodexSDKProvider({
        ...codexConfig,
        ...(codex.path || codexConfig.codexPath
          ? { codexPath: codex.path ?? codexConfig.codexPath }
          : {}),
      }),
    );
  }

  const effectiveDefaultKind =
    (providers.has(config.provider) ? config.provider : providers.keys().next().value) ??
    config.provider;
  for (const descriptor of descriptors.values()) {
    descriptor.isDefault = descriptor.kind === effectiveDefaultKind;
  }

  return new AgentProviderRegistry(effectiveDefaultKind, providers, descriptors);
}
