import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PermissionCoordinator } from '../../engine/coordinators/permission.js';
import { PendingPermissions } from '../../permissions/gateway.js';
import { PermissionBroker } from '../../permissions/broker.js';

describe('PermissionCoordinator', () => {
  let gateway: PendingPermissions;
  let broker: PermissionBroker;
  let coord: PermissionCoordinator;

  beforeEach(() => {
    gateway = new PendingPermissions();
    broker = new PermissionBroker(gateway, 'http://localhost:8080');
    coord = new PermissionCoordinator(gateway, broker);
  });

  describe('parsePermissionText', () => {
    it('recognizes allow variants', () => {
      expect(coord.parsePermissionText('allow')).toBe('allow');
      expect(coord.parsePermissionText('a')).toBe('allow');
      expect(coord.parsePermissionText('yes')).toBe('allow');
      expect(coord.parsePermissionText('y')).toBe('allow');
      expect(coord.parsePermissionText('Y')).toBe('allow');
      expect(coord.parsePermissionText('Allow')).toBe('allow');
    });

    it('recognizes Chinese allow variants', () => {
      expect(coord.parsePermissionText('允许')).toBe('allow');
      expect(coord.parsePermissionText('通过')).toBe('allow');
    });

    it('recognizes deny variants', () => {
      expect(coord.parsePermissionText('deny')).toBe('deny');
      expect(coord.parsePermissionText('d')).toBe('deny');
      expect(coord.parsePermissionText('no')).toBe('deny');
      expect(coord.parsePermissionText('n')).toBe('deny');
      expect(coord.parsePermissionText('N')).toBe('deny');
    });

    it('recognizes Chinese deny variants', () => {
      expect(coord.parsePermissionText('拒绝')).toBe('deny');
      expect(coord.parsePermissionText('否')).toBe('deny');
    });

    it('recognizes always variants', () => {
      expect(coord.parsePermissionText('always')).toBe('allow_always');
      expect(coord.parsePermissionText('Always')).toBe('allow_always');
      expect(coord.parsePermissionText('始终允许')).toBe('allow_always');
    });

    it('returns null for random text', () => {
      expect(coord.parsePermissionText('hello')).toBeNull();
      expect(coord.parsePermissionText('maybe')).toBeNull();
      expect(coord.parsePermissionText('')).toBeNull();
      expect(coord.parsePermissionText('allow me to explain')).toBeNull();
    });

    it('trims whitespace', () => {
      expect(coord.parsePermissionText('  yes  ')).toBe('allow');
      expect(coord.parsePermissionText('\tno\n')).toBe('deny');
    });
  });

  describe('SDK permission tracking', () => {
    it('set/get/clear', () => {
      expect(coord.getPendingSdkPerm('telegram:123')).toBeUndefined();
      coord.setPendingSdkPerm('telegram:123', 'perm-1');
      expect(coord.getPendingSdkPerm('telegram:123')).toBe('perm-1');
      coord.clearPendingSdkPerm('telegram:123');
      expect(coord.getPendingSdkPerm('telegram:123')).toBeUndefined();
    });

    it('isolates per chat key', () => {
      coord.setPendingSdkPerm('telegram:123', 'perm-1');
      coord.setPendingSdkPerm('feishu:456', 'perm-2');
      expect(coord.getPendingSdkPerm('telegram:123')).toBe('perm-1');
      expect(coord.getPendingSdkPerm('feishu:456')).toBe('perm-2');
    });
  });

  describe('tryResolveByText', () => {
    it('resolves when SDK perm is pending', async () => {
      // Set up a pending gateway entry
      const promise = gateway.waitFor('sdk-123', { timeoutMs: 5000 });
      coord.setPendingSdkPerm('telegram:chat1', 'sdk-123');

      const resolved = coord.tryResolveByText('telegram:chat1', 'allow');
      expect(resolved).toBe(true);
      expect(coord.getPendingSdkPerm('telegram:chat1')).toBeUndefined();

      const result = await promise;
      expect(result.behavior).toBe('allow');
    });

    it('returns false when no pending perm', () => {
      const resolved = coord.tryResolveByText('telegram:chat1', 'allow');
      expect(resolved).toBe(false);
    });

    it('returns false when gateway has no matching entry', () => {
      coord.setPendingSdkPerm('telegram:chat1', 'nonexistent');
      const resolved = coord.tryResolveByText('telegram:chat1', 'allow');
      expect(resolved).toBe(false);
    });

    it('maps deny decision correctly', async () => {
      const promise = gateway.waitFor('sdk-deny', { timeoutMs: 5000 });
      coord.setPendingSdkPerm('tg:c', 'sdk-deny');
      coord.tryResolveByText('tg:c', 'deny');
      const result = await promise;
      expect(result.behavior).toBe('deny');
    });

    it('maps allow_always decision correctly', async () => {
      const promise = gateway.waitFor('sdk-always', { timeoutMs: 5000 });
      coord.setPendingSdkPerm('tg:c', 'sdk-always');
      coord.tryResolveByText('tg:c', 'allow_always');
      const result = await promise;
      expect(result.behavior).toBe('allow_always');
    });
  });

  describe('handleBrokerCallback', () => {
    it('delegates to broker', async () => {
      const promise = gateway.waitFor('perm-abc', { timeoutMs: 5000 });
      const resolved = coord.handleBrokerCallback('perm:allow:perm-abc');
      expect(resolved).toBe(true);

      const result = await promise;
      expect(result.behavior).toBe('allow');
    });

    it('returns false for non-matching callback', () => {
      expect(coord.handleBrokerCallback('unknown:data')).toBe(false);
    });
  });

  describe('hook message tracking', () => {
    it('tracks and retrieves hook messages', () => {
      expect(coord.isHookMessage('msg-1')).toBe(false);
      coord.trackHookMessage('msg-1', 'session-1');
      expect(coord.isHookMessage('msg-1')).toBe(true);
      expect(coord.getHookMessage('msg-1')).toMatchObject({ sessionId: 'session-1' });
    });

    it('handles empty sessionId', () => {
      coord.trackHookMessage('msg-2', '');
      expect(coord.isHookMessage('msg-2')).toBe(true);
      expect(coord.getHookMessage('msg-2')?.sessionId).toBe('');
    });

    it('returns undefined for unknown messages', () => {
      expect(coord.getHookMessage('unknown')).toBeUndefined();
    });
  });

  describe('permission message tracking', () => {
    it('tracks and finds permission messages', () => {
      coord.trackPermissionMessage('msg-1', 'perm-1', 'session-1', 'telegram');
      const found = coord.findHookPermission('msg-1', 'telegram');
      expect(found).toMatchObject({ permissionId: 'perm-1', sessionId: 'session-1' });
    });

    it('finds latest when only one pending', () => {
      coord.trackPermissionMessage('msg-1', 'perm-1', 'session-1', 'telegram');
      // No replyToMessageId — should find the single pending
      const found = coord.findHookPermission(undefined, 'telegram');
      expect(found).toMatchObject({ permissionId: 'perm-1' });
    });

    it('returns undefined when multiple pending and no reply', () => {
      coord.trackPermissionMessage('msg-1', 'perm-1', 's1', 'telegram');
      coord.trackPermissionMessage('msg-2', 'perm-2', 's2', 'telegram');
      const found = coord.findHookPermission(undefined, 'telegram');
      expect(found).toBeUndefined();
    });

    it('counts pending permissions', () => {
      expect(coord.pendingPermissionCount()).toBe(0);
      coord.trackPermissionMessage('msg-1', 'perm-1', 's1', 'telegram');
      expect(coord.pendingPermissionCount()).toBe(1);
      coord.trackPermissionMessage('msg-2', 'perm-2', 's2', 'telegram');
      expect(coord.pendingPermissionCount()).toBe(2);
    });
  });

  describe('storeHookPermissionText', () => {
    it('stores and is used by pruneStaleEntries', () => {
      coord.storeHookPermissionText('hook-1', 'some text');
      // No error — pruneStaleEntries ran internally
    });
  });

  describe('getGateway / getBroker', () => {
    it('returns the injected instances', () => {
      expect(coord.getGateway()).toBe(gateway);
      expect(coord.getBroker()).toBe(broker);
    });
  });

  describe('dynamic session whitelist', () => {
    it('isToolAllowed returns false by default', () => {
      expect(coord.isToolAllowed('session-1', 'Edit', {})).toBe(false);
    });

    it('allows tool after addAllowedTool within the same session', () => {
      coord.addAllowedTool('session-1', 'Edit');
      expect(coord.isToolAllowed('session-1', 'Edit', {})).toBe(true);
      expect(coord.isToolAllowed('session-1', 'Write', {})).toBe(false);
      expect(coord.isToolAllowed('session-2', 'Edit', {})).toBe(false);
    });

    it('allows Bash with matching prefix within the same session', () => {
      coord.addAllowedBashPrefix('session-1', 'npm');
      expect(coord.isToolAllowed('session-1', 'Bash', { command: 'npm test' })).toBe(true);
      expect(coord.isToolAllowed('session-1', 'Bash', { command: 'npm install' })).toBe(true);
      expect(coord.isToolAllowed('session-1', 'Bash', { command: 'git push' })).toBe(false);
      expect(coord.isToolAllowed('session-2', 'Bash', { command: 'npm test' })).toBe(false);
    });

    it('clears only the targeted session whitelist', () => {
      coord.addAllowedTool('session-1', 'Edit');
      coord.addAllowedBashPrefix('session-1', 'npm');
      coord.addAllowedTool('session-2', 'Write');
      coord.clearSessionWhitelist('session-1');
      expect(coord.isToolAllowed('session-1', 'Edit', {})).toBe(false);
      expect(coord.isToolAllowed('session-1', 'Bash', { command: 'npm test' })).toBe(false);
      expect(coord.isToolAllowed('session-2', 'Write', {})).toBe(true);
    });

    it('remembers allow_always decisions by session', () => {
      coord.rememberSessionAllowance('session-1', 'Edit', {});
      coord.rememberSessionAllowance('session-1', 'Bash', { command: 'npm test' });
      expect(coord.isToolAllowed('session-1', 'Edit', {})).toBe(true);
      expect(coord.isToolAllowed('session-1', 'Bash', { command: 'npm run build' })).toBe(true);
      expect(coord.isToolAllowed('session-2', 'Edit', {})).toBe(false);
    });

    it('clears all whitelists when sessionId is omitted', () => {
      coord.addAllowedTool('session-1', 'Edit');
      coord.addAllowedTool('session-2', 'Write');
      coord.clearSessionWhitelist();
      expect(coord.isToolAllowed('session-1', 'Edit', {})).toBe(false);
      expect(coord.isToolAllowed('session-2', 'Write', {})).toBe(false);
    });

    it('extractBashPrefix gets first word of command', () => {
      expect(coord.extractBashPrefix('npm test')).toBe('npm');
      expect(coord.extractBashPrefix('git push origin main')).toBe('git');
      expect(coord.extractBashPrefix('')).toBe('');
      expect(coord.extractBashPrefix('   ls -la  ')).toBe('ls');
    });
  });

  describe('permission status snapshots', () => {
    it('tracks pending and resolved sdk permissions per chat', () => {
      coord.notePermissionPending('telegram:chat-1', 'perm-1', 'session-1', 'Edit', 'src/main.ts');

      expect(coord.getPermissionStatus('telegram:chat-1', 'session-1')).toMatchObject({
        rememberedTools: 0,
        rememberedBashPrefixes: 0,
        pending: { toolName: 'Edit' },
      });

      coord.notePermissionResolved('telegram:chat-1', 'session-1', 'Edit', 'allow_always', 'perm-1');

      expect(coord.getPermissionStatus('telegram:chat-1', 'session-1')).toMatchObject({
        lastDecision: { toolName: 'Edit', decision: 'allow_always' },
      });
      expect(coord.getPermissionStatus('telegram:chat-1', 'session-1').pending).toBeUndefined();
    });

    it('clears only the matching pending snapshot', () => {
      coord.notePermissionPending('telegram:chat-1', 'perm-1', 'session-1', 'Edit', 'src/main.ts');
      coord.clearPendingPermissionSnapshot('telegram:chat-1', 'perm-1');
      expect(coord.getPermissionStatus('telegram:chat-1', 'session-1').pending).toBeUndefined();
    });

    it('does not surface a previous session snapshot to a new session', () => {
      coord.notePermissionResolved('telegram:chat-1', 'session-1', 'Edit', 'allow_always');
      expect(coord.getPermissionStatus('telegram:chat-1', 'session-2').lastDecision).toBeUndefined();
    });
  });
});
