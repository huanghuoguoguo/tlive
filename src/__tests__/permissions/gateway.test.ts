import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parsePermissionCallback,
  PendingPermissions,
} from '../../permissions/gateway.js';

describe('PendingPermissions', () => {
  let gateway: PendingPermissions;

  beforeEach(() => {
    gateway = new PendingPermissions();
  });

  it('waitFor returns a promise that resolves on allow', async () => {
    const promise = gateway.waitFor('tool1');
    gateway.resolve('tool1', 'allow');
    const result = await promise;
    expect(result.behavior).toBe('allow');
  });

  it('waitFor returns deny result on deny', async () => {
    const promise = gateway.waitFor('tool2');
    gateway.resolve('tool2', 'deny');
    const result = await promise;
    expect(result.behavior).toBe('deny');
  });

  it('resolve returns true if permission was pending', () => {
    gateway.waitFor('tool1');
    expect(gateway.resolve('tool1', 'allow')).toBe(true);
  });

  it('resolve returns false if no pending permission', () => {
    expect(gateway.resolve('unknown', 'allow')).toBe(false);
  });

  it('times out after 5 minutes and auto-denies', async () => {
    vi.useFakeTimers();
    const promise = gateway.waitFor('tool1');
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await expect(promise).resolves.toMatchObject({ behavior: 'deny' });
    vi.useRealTimers();
  });

  it('denyAll denies all pending permissions', async () => {
    const p1 = gateway.waitFor('t1');
    const p2 = gateway.waitFor('t2');
    gateway.denyAll();
    const r1 = await p1;
    const r2 = await p2;
    expect(r1.behavior).toBe('deny');
    expect(r2.behavior).toBe('deny');
  });

  it('isPending returns whether a permission is still waiting', () => {
    gateway.waitFor('t1');
    gateway.waitFor('t2');
    expect(gateway.isPending('t1')).toBe(true);
    expect(gateway.isPending('t2')).toBe(true);
    gateway.resolve('t1', 'allow');
    expect(gateway.isPending('t1')).toBe(false);
    expect(gateway.isPending('t2')).toBe(true);
    gateway.denyAll();
  });

  describe('timeout callback', () => {
    it('invokes onTimeout before resolving with deny', async () => {
      vi.useFakeTimers();
      const gw = new PendingPermissions();
      const onTimeout = vi.fn();

      const promise = gw.waitFor('tool-1', { onTimeout, timeoutMs: 1000 });
      vi.advanceTimersByTime(1001);

      const result = await promise;
      expect(result.behavior).toBe('deny');
      expect(onTimeout).toHaveBeenCalledWith('tool-1');

      vi.useRealTimers();
    });

    it('uses default timeout when options not provided', async () => {
      vi.useFakeTimers();
      const gw = new PendingPermissions();

      const promise = gw.waitFor('tool-2');
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      const result = await promise;
      expect(result.behavior).toBe('deny');

      vi.useRealTimers();
    });
  });

  describe('permission callbacks', () => {
    it('parses the active four-button permission callbacks', () => {
      expect(parsePermissionCallback('perm:allow:perm-1')).toEqual({
        permissionId: 'perm-1',
        decision: 'allow',
      });
      expect(parsePermissionCallback('perm:allow_same:perm-1')).toEqual({
        permissionId: 'perm-1',
        decision: 'allow',
        grantScope: 'same_command',
      });
      expect(parsePermissionCallback('perm:allow_all_session:perm-1')).toEqual({
        permissionId: 'perm-1',
        decision: 'allow',
        grantScope: 'session_all',
      });
      expect(parsePermissionCallback('perm:deny:perm-1')).toEqual({
        permissionId: 'perm-1',
        decision: 'deny',
      });
    });

    it('does not treat AskUserQuestion option callbacks as permission decisions', () => {
      expect(parsePermissionCallback('perm:allow:perm-1:askq:0')).toBeNull();
    });

    it('resolves allow_same and session-wide callbacks through the gateway', async () => {
      const exactCommand = gateway.waitFor('same-1', { timeoutMs: 5000 });
      expect(gateway.resolveCallback('perm:allow_same:same-1')).toBe(true);
      await expect(exactCommand).resolves.toMatchObject({
        behavior: 'allow',
        grantScope: 'same_command',
      });

      const sessionWide = gateway.waitFor('session-1', { timeoutMs: 5000 });
      expect(gateway.resolveCallback('perm:allow_all_session:session-1')).toBe(true);
      await expect(sessionWide).resolves.toMatchObject({
        behavior: 'allow',
        grantScope: 'session_all',
      });
    });

    it('returns false for stale or unsupported callbacks', () => {
      expect(gateway.resolveCallback('perm:allow:missing')).toBe(false);
      expect(gateway.resolveCallback('perm:allow_tool:perm-1:Edit')).toBe(false);
    });
  });
});
