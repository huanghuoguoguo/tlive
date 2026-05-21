export type AgentProviderKind = 'claude' | 'codex';

export function normalizeAgentProviderKind(
  provider: AgentProviderKind | undefined,
): AgentProviderKind {
  return provider ?? 'claude';
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
