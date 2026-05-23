import type { RemoteSessionDescriptor } from '../shared/protocol/messages.js';
import { invalidateSessionCache, scanAgentSessions } from './providers/session-scanner.js';
import type { AgentProviderKind } from '../shared/providers/kinds.js';

export function listLocalSessionDescriptors(
  providers: AgentProviderKind[],
  limit = 20,
): RemoteSessionDescriptor[] {
  return scanAgentSessions(50, undefined, providers)
    .slice(0, limit)
    .map((session) => ({
      provider: session.provider,
      providerDisplayName: session.providerDisplayName,
      sdkSessionId: session.sdkSessionId,
      cwd: session.cwd,
      mtime: session.mtime,
      size: session.size,
      preview: session.preview,
    }));
}

export function invalidateLocalSessionIndex(): void {
  invalidateSessionCache();
}
