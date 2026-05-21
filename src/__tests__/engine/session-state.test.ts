import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionStateManager } from '../../engine/state/session-state.js';

describe('SessionStateManager', () => {
  let state: SessionStateManager;

  beforeEach(() => {
    state = new SessionStateManager();
  });

  describe('stateKey', () => {
    it('combines channelType and chatId', () => {
      expect(state.stateKey('feishu', '123')).toBe('feishu:123');
      expect(state.stateKey('feishu', 'abc')).toBe('feishu:abc');
    });
  });

  describe('permMode', () => {
    it('defaults to on', () => {
      expect(state.getPermMode('feishu', '1')).toBe('on');
    });

    it('feishu also defaults to on for text-based approvals', () => {
      expect(state.getPermMode('feishu', '1')).toBe('on');
    });

    it('set and get with sessionId (per bsession)', () => {
      state.setPermMode('feishu', '1', 'session-abc', 'off');
      expect(state.getPermMode('feishu', '1', 'session-abc')).toBe('off');
      // Different session in same chat defaults to on
      expect(state.getPermMode('feishu', '1', 'session-xyz')).toBe('on');
      // Without sessionId also defaults to on (no fallback to per-chat)
      expect(state.getPermMode('feishu', '1')).toBe('on');
    });

    it('set without sessionId (legacy per-chat)', () => {
      state.setPermMode('feishu', '1', undefined, 'off');
      expect(state.getPermMode('feishu', '1')).toBe('off');
      // Per-bsession query does not inherit from per-chat
      expect(state.getPermMode('feishu', '1', 'session-abc')).toBe('on');
    });
  });

  describe('processing guard', () => {
    it('defaults to not processing', () => {
      expect(state.isProcessing('feishu:1')).toBe(false);
    });

    it('toggles on and off', () => {
      state.setProcessing('feishu:1', true);
      expect(state.isProcessing('feishu:1')).toBe(true);
      state.setProcessing('feishu:1', false);
      expect(state.isProcessing('feishu:1')).toBe(false);
    });
  });

  describe('SessionMode', () => {
    it('returns full SessionMode with defaults', () => {
      const mode = state.getSessionMode('feishu', '1');
      expect(mode.permissionMode).toBe('default');
    });

    it('stores permission mode changes in SessionMode', () => {
      state.setPermMode('feishu', '1', 'session-1', 'off');
      const mode = state.getSessionMode('feishu', '1', 'session-1');
      expect(mode.permissionMode).toBe('bypassPermissions');
    });
  });

  describe('activity tracking', () => {
    it('returns false on first call', () => {
      expect(state.checkAndUpdateLastActive('feishu', '1')).toBe(false);
    });

    it('returns false on second call within 30 min', () => {
      state.checkAndUpdateLastActive('feishu', '1');
      expect(state.checkAndUpdateLastActive('feishu', '1')).toBe(false);
    });

    it('returns true after >30 min gap', () => {
      state.checkAndUpdateLastActive('feishu', '1');
      // Fast-forward Date.now by 31 minutes
      const realNow = Date.now;
      const start = realNow.call(Date);
      vi.spyOn(Date, 'now').mockReturnValue(start + 31 * 60 * 1000);
      expect(state.checkAndUpdateLastActive('feishu', '1')).toBe(true);
      vi.restoreAllMocks();
    });

    it('clearLastActive resets tracking', () => {
      state.checkAndUpdateLastActive('feishu', '1');
      state.clearLastActive('feishu', '1');
      // After clear, next call should return false (like first call)
      expect(state.checkAndUpdateLastActive('feishu', '1')).toBe(false);
    });

    it('getLastActiveTime returns undefined before any activity', () => {
      expect(state.getLastActiveTime('feishu', '1')).toBeUndefined();
    });

    it('getLastActiveTime returns timestamp after activity', () => {
      const before = Date.now();
      state.checkAndUpdateLastActive('feishu', '1');
      const after = Date.now();
      const lastActive = state.getLastActiveTime('feishu', '1');
      expect(lastActive).toBeDefined();
      expect(lastActive!).toBeGreaterThanOrEqual(before);
      expect(lastActive!).toBeLessThanOrEqual(after);
    });

    it('getSessionAge returns undefined before any activity', () => {
      expect(state.getSessionAge('feishu', '1')).toBeUndefined();
    });

    it('getSessionAge returns elapsed time since last activity', () => {
      state.checkAndUpdateLastActive('feishu', '1');
      const age = state.getSessionAge('feishu', '1');
      expect(age).toBeDefined();
      expect(age!).toBeLessThan(1000); // Should be very small right after activity
    });

    it('getSessionAge increases over time', () => {
      state.checkAndUpdateLastActive('feishu', '1');
      const age1 = state.getSessionAge('feishu', '1');

      // Fast-forward 1 minute
      const realNow = Date.now;
      const start = realNow.call(Date);
      vi.spyOn(Date, 'now').mockReturnValue(start + 60 * 1000);
      const age2 = state.getSessionAge('feishu', '1');
      vi.restoreAllMocks();

      expect(age2!).toBeGreaterThan(age1!);
      expect(age2! - age1!).toBeGreaterThanOrEqual(60 * 1000);
    });

    it('clearLastActive makes getSessionAge return undefined', () => {
      state.checkAndUpdateLastActive('feishu', '1');
      state.clearLastActive('feishu', '1');
      expect(state.getSessionAge('feishu', '1')).toBeUndefined();
    });
  });
});
