import type { RemoteSessionDescriptor } from '../shared/protocol/messages.js';
import { invalidateSessionCache, scanAgentSessions } from './providers/session-scanner.js';
import type { AgentProviderKind } from '../shared/providers/kinds.js';

function normalizePath(path: string): string {
  return path.replace(/[\\/]+$/, '');
}

function isInWorkspace(cwd: string, workspaces: string[]): boolean {
  if (!workspaces.length) return true;
  const normalizedCwd = normalizePath(cwd);
  return workspaces.some((workspace) => {
    const root = normalizePath(workspace);
    return normalizedCwd === root || normalizedCwd.startsWith(`${root}/`);
  });
}

export function listLocalSessionDescriptors(
  providers: AgentProviderKind[],
  workspaces: string[] = [],
  limit = 20,
): RemoteSessionDescriptor[] {
  return scanAgentSessions(50, undefined, providers)
    .filter((session) => isInWorkspace(session.cwd, workspaces))
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
