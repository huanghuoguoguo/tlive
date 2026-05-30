export type AgentProviderKind = 'claude' | 'codex' | 'pi';

export const DEFAULT_AGENT_PROVIDER_KIND: AgentProviderKind = 'claude';

export function normalizeAgentProviderKind(
  provider: AgentProviderKind | undefined,
): AgentProviderKind {
  return provider ?? DEFAULT_AGENT_PROVIDER_KIND;
}

export function agentSessionKey(
  provider: AgentProviderKind | undefined,
  sdkSessionId: string,
): string {
  return `${normalizeAgentProviderKind(provider)}:${sdkSessionId}`;
}
