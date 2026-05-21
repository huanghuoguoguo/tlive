export type AgentProviderKind = 'claude' | 'codex';

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

export function sameAgentSession(
  providerA: AgentProviderKind | undefined,
  sessionIdA: string | undefined,
  providerB: AgentProviderKind | undefined,
  sessionIdB: string | undefined,
): boolean {
  return (
    !!sessionIdA &&
    !!sessionIdB &&
    sessionIdA === sessionIdB &&
    normalizeAgentProviderKind(providerA) === normalizeAgentProviderKind(providerB)
  );
}
