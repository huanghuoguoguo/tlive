import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PermissionCoordinator } from '../../server/engine/coordinators/permission.js';
import { PendingPermissions } from '../../server/engine/permissions/gateway.js';

describe('PermissionCoordinator', () => {
  let gateway: PendingPermissions;
  let coord: PermissionCoordinator;

  beforeEach(() => {
    gateway = new PendingPermissions();
    coord = new PermissionCoordinator(gateway);
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
      expect(coord.getPendingSdkPerm('feishu:123')).toBeUndefined();
      coord.setPendingSdkPerm('feishu:123', 'perm-1');
      expect(coord.getPendingSdkPerm('feishu:123')).toBe('perm-1');
      coord.clearPendingSdkPerm('feishu:123');
      expect(coord.getPendingSdkPerm('feishu:123')).toBeUndefined();
    });

    it('isolates per chat key', () => {
      coord.setPendingSdkPerm('feishu:123', 'perm-1');
      coord.setPendingSdkPerm('feishu:456', 'perm-2');
      expect(coord.getPendingSdkPerm('feishu:123')).toBe('perm-1');
      expect(coord.getPendingSdkPerm('feishu:456')).toBe('perm-2');
    });
  });

  describe('tryResolveByText', () => {
    it('resolves when SDK perm is pending', async () => {
      // Set up a pending gateway entry
      const promise = gateway.waitFor('sdk-123', { timeoutMs: 5000 });
      coord.setPendingSdkPerm('feishu:chat1', 'sdk-123');

      const resolved = coord.tryResolveByText('feishu:chat1', 'allow');
      expect(resolved).toBe(true);
      expect(coord.getPendingSdkPerm('feishu:chat1')).toBeUndefined();

      const result = await promise;
      expect(result.behavior).toBe('allow');
    });

    it('returns false when no pending perm', () => {
      const resolved = coord.tryResolveByText('feishu:chat1', 'allow');
      expect(resolved).toBe(false);
    });

    it('returns false when gateway has no matching entry', () => {
      coord.setPendingSdkPerm('feishu:chat1', 'nonexistent');
      const resolved = coord.tryResolveByText('feishu:chat1', 'allow');
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

  describe('handlePermissionCallback', () => {
    it('resolves active permission button callbacks', async () => {
      const promise = gateway.waitFor('perm-abc', { timeoutMs: 5000 });
      const resolved = coord.handlePermissionCallback('perm:allow:perm-abc');
      expect(resolved).toBe(true);

      const result = await promise;
      expect(result.behavior).toBe('allow');
    });

    it('returns false for non-matching callback', () => {
      expect(coord.handlePermissionCallback('unknown:data')).toBe(false);
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

    it('remembers same-command approvals exactly within the session', () => {
      coord.rememberSameCommandAllowance('session-1', 'Bash', { command: 'npm test' });
      coord.rememberSameCommandAllowance('session-1', 'Edit', { file_path: 'src/a.ts' });

      expect(coord.isToolAllowed('session-1', 'Bash', { command: 'npm test' })).toBe(true);
      expect(coord.isToolAllowed('session-1', 'Bash', { command: 'npm run build' })).toBe(false);
      expect(coord.isToolAllowed('session-1', 'Edit', { file_path: 'src/a.ts' })).toBe(true);
      expect(coord.isToolAllowed('session-1', 'Edit', { file_path: 'src/b.ts' })).toBe(false);
      expect(coord.isToolAllowed('session-2', 'Bash', { command: 'npm test' })).toBe(false);
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
      coord.notePermissionPending('feishu:chat-1', 'perm-1', 'session-1', 'Edit', 'src/main.ts');

      expect(coord.getPermissionStatus('feishu:chat-1', 'session-1')).toMatchObject({
        rememberedTools: 0,
        rememberedBashPrefixes: 0,
        pending: { toolName: 'Edit' },
      });

      coord.notePermissionResolved('feishu:chat-1', 'session-1', 'Edit', 'allow_always', 'perm-1');

      expect(coord.getPermissionStatus('feishu:chat-1', 'session-1')).toMatchObject({
        lastDecision: { toolName: 'Edit', decision: 'allow_always' },
      });
      expect(coord.getPermissionStatus('feishu:chat-1', 'session-1').pending).toBeUndefined();
    });

    it('clears only the matching pending snapshot', () => {
      coord.notePermissionPending('feishu:chat-1', 'perm-1', 'session-1', 'Edit', 'src/main.ts');
      coord.clearPendingPermissionSnapshot('feishu:chat-1', 'perm-1');
      expect(coord.getPermissionStatus('feishu:chat-1', 'session-1').pending).toBeUndefined();
    });

    it('does not surface a previous session snapshot to a new session', () => {
      coord.notePermissionResolved('feishu:chat-1', 'session-1', 'Edit', 'allow_always');
      expect(coord.getPermissionStatus('feishu:chat-1', 'session-2').lastDecision).toBeUndefined();
    });
  });
});
