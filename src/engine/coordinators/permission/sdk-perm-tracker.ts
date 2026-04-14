import type { PendingPermissions } from '../../../permissions/gateway.js';
import type { PermissionDecision as TextPermissionDecision } from '../../../ui/policy.js';
import { truncate } from '../../../utils/string.js';

type PermissionDecision = TextPermissionDecision | 'cancelled';

interface PermissionSnapshotState {
  pending?: {
    permissionId: string;
    sessionId?: string;
    toolName: string;
    input: string;
  };
  lastDecision?: {
    sessionId?: string;
    toolName: string;
    decision: PermissionDecision;
  };
}

/**
 * Tracks pending SDK permissions and text-based approval routing.
 *
 * Handles:
 * - pendingSdkPerms: SDK permission IDs per chat for text-based resolution
 * - permissionSnapshotsByChat: Recent pending/resolved SDK permission snapshots
 * - permissionMessages: Track permission messages for text-based approval
 * - latestPermission: Latest permission per channel type for single-pending shortcut
 */
export class SdkPermTracker {
  private gateway: PendingPermissions;

  /** Track pending SDK permission IDs per chat for text-based resolution (key: stateKey, value: permId) */
  private pendingSdkPerms = new Map<string, string>();
  /** Recent pending / resolved SDK permission snapshots per chat */
  private permissionSnapshotsByChat = new Map<string, PermissionSnapshotState>();
  /** Track permission messages for text-based approval */
  private permissionMessages = new Map<string, { permissionId: string; sessionId: string; timestamp: number }>();
  /** Latest permission per channel type for single-pending shortcut */
  private latestPermission = new Map<string, { permissionId: string; sessionId: string; messageId: string }>();

  constructor(gateway: PendingPermissions) {
    this.gateway = gateway;
  }

  /** Expose the PendingPermissions gateway instance */
  getGateway(): PendingPermissions {
    return this.gateway;
  }

  // --- SDK permission tracking ---

  getPendingSdkPerm(chatKey: string): string | undefined {
    return this.pendingSdkPerms.get(chatKey);
  }

  setPendingSdkPerm(chatKey: string, permId: string): void {
    this.pendingSdkPerms.set(chatKey, permId);
  }

  clearPendingSdkPerm(chatKey: string): void {
    this.pendingSdkPerms.delete(chatKey);
  }

  notePermissionPending(
    chatKey: string,
    permissionId: string,
    sessionId: string | undefined,
    toolName: string,
    input: string,
  ): void {
    const snapshot = this.permissionSnapshotsByChat.get(chatKey) || {};
    snapshot.pending = {
      permissionId,
      sessionId,
      toolName,
      input: truncate(input, 260),
    };
    this.permissionSnapshotsByChat.set(chatKey, snapshot);
  }

  notePermissionResolved(
    chatKey: string,
    sessionId: string | undefined,
    toolName: string,
    decision: PermissionDecision,
    permissionId?: string,
  ): void {
    const snapshot = this.permissionSnapshotsByChat.get(chatKey) || {};
    if (!permissionId || snapshot.pending?.permissionId === permissionId) {
      delete snapshot.pending;
    }
    snapshot.lastDecision = { sessionId, toolName, decision };
    this.permissionSnapshotsByChat.set(chatKey, snapshot);
  }

  clearPendingPermissionSnapshot(chatKey: string, permissionId?: string): void {
    const snapshot = this.permissionSnapshotsByChat.get(chatKey);
    if (!snapshot?.pending) return;
    if (!permissionId || snapshot.pending.permissionId === permissionId) {
      delete snapshot.pending;
    }
    if (!snapshot.lastDecision && !snapshot.pending) {
      this.permissionSnapshotsByChat.delete(chatKey);
    }
  }

  getPermissionStatus(chatKey: string, sessionId?: string): {
    rememberedTools: number;
    rememberedBashPrefixes: number;
    pending?: { toolName: string; input: string };
    lastDecision?: { toolName: string; decision: PermissionDecision };
  } {
    const snapshot = this.permissionSnapshotsByChat.get(chatKey);
    const pending = snapshot?.pending
      && (!sessionId || !snapshot.pending.sessionId || snapshot.pending.sessionId === sessionId)
      ? {
          toolName: snapshot.pending.toolName,
          input: snapshot.pending.input,
        }
      : undefined;
    const lastDecision = snapshot?.lastDecision
      && (!sessionId || !snapshot.lastDecision.sessionId || snapshot.lastDecision.sessionId === sessionId)
      ? {
          toolName: snapshot.lastDecision.toolName,
          decision: snapshot.lastDecision.decision,
        }
      : undefined;
    return {
      rememberedTools: 0, // Will be filled by SessionWhitelist in facade
      rememberedBashPrefixes: 0,
      pending,
      lastDecision,
    };
  }

  // --- Parse permission text ---

  /** Parse text as a permission decision */
  parsePermissionText(text: string): TextPermissionDecision | null {
    const t = text.trim().toLowerCase();
    if (['allow', 'a', 'yes', 'y', '允许', '通过'].includes(t)) return 'allow';
    if (['deny', 'd', 'no', 'n', '拒绝', '否'].includes(t)) return 'deny';
    if (['always', '始终允许'].includes(t)) return 'allow_always';
    return null;
  }

  // --- SDK permission resolution ---

  /** Try to resolve an SDK permission via gateway for a given chat. Returns true if resolved. */
  tryResolveByText(chatKey: string, decision: TextPermissionDecision): boolean {
    const pendingPermId = this.pendingSdkPerms.get(chatKey);
    if (!pendingPermId) return false;
    const gwDecision = decision === 'deny' ? 'deny' as const
      : decision === 'allow_always' ? 'allow_always' as const
      : 'allow' as const;
    if (this.gateway.resolve(pendingPermId, gwDecision)) {
      this.pendingSdkPerms.delete(chatKey);
      return true;
    }
    return false;
  }

  // --- Permission message tracking ---

  /** Track a permission message for text-based approval (Feishu) */
  trackPermissionMessage(messageId: string, permissionId: string, sessionId: string, channelType: string): void {
    this.permissionMessages.set(messageId, { permissionId, sessionId, timestamp: Date.now() });
    this.latestPermission.set(channelType, { permissionId, sessionId, messageId });
  }

  /** Find a hook permission entry for text-based resolution. Returns the entry or undefined. */
  findHookPermission(replyToMessageId: string | undefined, channelType: string): { permissionId: string; sessionId: string; timestamp: number } | undefined {
    let permEntry = replyToMessageId ? this.permissionMessages.get(replyToMessageId) : undefined;
    if (!permEntry) {
      if (this.permissionMessages.size === 1) {
        const latest = this.latestPermission.get(channelType);
        if (latest) permEntry = this.permissionMessages.get(latest.messageId);
      }
    }
    return permEntry;
  }

  /** Count of pending permission messages (used for "multiple pending" check) */
  pendingPermissionCount(): number {
    return this.permissionMessages.size;
  }

  /** Get permission messages map (for cleanup by HookResolver) */
  getPermissionMessages(): Map<string, { permissionId: string; sessionId: string; timestamp: number }> {
    return this.permissionMessages;
  }

  /** Get latest permission map (for cleanup by HookResolver) */
  getLatestPermission(): Map<string, { permissionId: string; sessionId: string; messageId: string }> {
    return this.latestPermission;
  }

  // --- Pruning ---

  /** Prune stale permission messages and snapshots */
  pruneStaleEntries(): void {
    const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, entry] of this.permissionMessages) {
      if (entry.timestamp < cutoff24h) this.permissionMessages.delete(id);
    }
    // Prune stale permission snapshots (>1h with no pending)
    for (const [chatKey, snapshot] of this.permissionSnapshotsByChat) {
      if (!snapshot.pending && !snapshot.lastDecision) {
        this.permissionSnapshotsByChat.delete(chatKey);
      }
    }
  }
}