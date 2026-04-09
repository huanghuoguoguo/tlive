import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionStateManager } from '../engine/session-state.js';

describe('SessionStateManager', () => {
  let state: SessionStateManager;

  beforeEach(() => {
    state = new SessionStateManager();
  });

  describe('stateKey', () => {
    it('combines channelType and chatId', () => {
      expect(state.stateKey('telegram', '123')).toBe('telegram:123');
      expect(state.stateKey('feishu', 'abc')).toBe('feishu:abc');
    });
  });

  describe('verboseLevel', () => {
    it('defaults to 1', () => {
      expect(state.getVerboseLevel('telegram', '1')).toBe(1);
    });

    it('set and get', () => {
      state.setVerboseLevel('telegram', '1', 0);
      expect(state.getVerboseLevel('telegram', '1')).toBe(0);
      state.setVerboseLevel('telegram', '1', 1);
      expect(state.getVerboseLevel('telegram', '1')).toBe(1);
    });

    it('isolates per chat', () => {
      state.setVerboseLevel('telegram', '1', 0);
      expect(state.getVerboseLevel('telegram', '2')).toBe(1);
    });
  });

  describe('permMode', () => {
    it('defaults to on', () => {
      expect(state.getPermMode('feishu', '1')).toBe('on');
    });

    it('set and get', () => {
      state.setPermMode('feishu', '1', 'off');
      expect(state.getPermMode('feishu', '1')).toBe('off');
    });
  });

  describe('effort', () => {
    it('defaults to undefined', () => {
      expect(state.getEffort('telegram', '1')).toBeUndefined();
    });

    it('set and get', () => {
      state.setEffort('telegram', '1', 'high');
      expect(state.getEffort('telegram', '1')).toBe('high');
    });
  });

  describe('processing guard', () => {
    it('defaults to not processing', () => {
      expect(state.isProcessing('telegram:1')).toBe(false);
    });

    it('toggles on and off', () => {
      state.setProcessing('telegram:1', true);
      expect(state.isProcessing('telegram:1')).toBe(true);
      state.setProcessing('telegram:1', false);
      expect(state.isProcessing('telegram:1')).toBe(false);
    });
  });

  describe('threads', () => {
    it('defaults to undefined', () => {
      expect(state.getThread('telegram', '1')).toBeUndefined();
    });

    it('set and get', () => {
      state.setThread('telegram', '1', 'thread-abc');
      expect(state.getThread('telegram', '1')).toBe('thread-abc');
    });

    it('clear removes the thread', () => {
      state.setThread('telegram', '1', 'thread-abc');
      state.clearThread('telegram', '1');
      expect(state.getThread('telegram', '1')).toBeUndefined();
    });
  });

  describe('SessionMode', () => {
    it('returns full SessionMode with defaults', () => {
      const mode = state.getSessionMode('telegram', '1');
      expect(mode.permissionMode).toBe('default');
      expect(mode.effort).toBeUndefined();
    });

    it('accumulates settings into single SessionMode', () => {
      state.setPermMode('telegram', '1', 'off');
      state.setEffort('telegram', '1', 'high');
      const mode = state.getSessionMode('telegram', '1');
      expect(mode.permissionMode).toBe('bypassPermissions');
      expect(mode.effort).toBe('high');
    });
  });

  describe('activity tracking', () => {
    it('returns false on first call', () => {
      expect(state.checkAndUpdateLastActive('telegram', '1')).toBe(false);
    });

    it('returns false on second call within 30 min', () => {
      state.checkAndUpdateLastActive('telegram', '1');
      expect(state.checkAndUpdateLastActive('telegram', '1')).toBe(false);
    });

    it('returns true after >30 min gap', () => {
      state.checkAndUpdateLastActive('telegram', '1');
      // Fast-forward Date.now by 31 minutes
      const realNow = Date.now;
      const start = realNow.call(Date);
      vi.spyOn(Date, 'now').mockReturnValue(start + 31 * 60 * 1000);
      expect(state.checkAndUpdateLastActive('telegram', '1')).toBe(true);
      vi.restoreAllMocks();
    });

    it('clearLastActive resets tracking', () => {
      state.checkAndUpdateLastActive('telegram', '1');
      state.clearLastActive('telegram', '1');
      // After clear, next call should return false (like first call)
      expect(state.checkAndUpdateLastActive('telegram', '1')).toBe(false);
    });
  });
});
