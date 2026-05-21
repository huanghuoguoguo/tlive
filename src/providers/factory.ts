import type { Config } from '../config.js';
import type { AgentProvider } from './base.js';
import { ClaudeSDKProvider } from './claude-sdk.js';
import { CodexSDKProvider } from './codex-sdk.js';
import { detectClaudeCli, detectCodexCli } from './cli-detection.js';
import { AgentProviderRegistry, type AgentProviderDescriptor } from './registry.js';
import type { AgentProviderKind } from './kinds.js';

export function createAgentProviderRegistry(config: Config): AgentProviderRegistry {
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

  const providers = new Map<AgentProviderKind, AgentProvider>();
  if (claude.available || config.provider === 'claude') {
    providers.set('claude', new ClaudeSDKProvider(config.agentSettingSources));
  }
  if (codex.available || config.provider === 'codex') {
    providers.set(
      'codex',
      new CodexSDKProvider({
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
