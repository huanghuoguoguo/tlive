import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStateManager } from '../../engine/state/session-state.js';

describe('SessionStateManager', () => {
  let state: SessionStateManager;

  beforeEach(() => {
    state = new SessionStateManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('isolates permission mode by session while preserving legacy chat mode', () => {
    expect(state.getPermMode('feishu', 'chat-1')).toBe('on');
    expect(state.getSessionMode('feishu', 'chat-1').permissionMode).toBe('default');

    state.setPermMode('feishu', 'chat-1', 'session-a', 'off');
    expect(state.getPermMode('feishu', 'chat-1', 'session-a')).toBe('off');
    expect(state.getSessionMode('feishu', 'chat-1', 'session-a').permissionMode)
      .toBe('bypassPermissions');

    expect(state.getPermMode('feishu', 'chat-1', 'session-b')).toBe('on');
    expect(state.getPermMode('feishu', 'chat-1')).toBe('on');

    state.setPermMode('feishu', 'chat-1', undefined, 'off');
    expect(state.getPermMode('feishu', 'chat-1')).toBe('off');
    expect(state.getPermMode('feishu', 'chat-1', 'session-b')).toBe('on');
  });

  it('tracks processing state by logical key', () => {
    expect(state.stateKey('feishu', 'chat-1')).toBe('feishu:chat-1');
    expect(state.isProcessing('feishu:chat-1')).toBe(false);

    state.setProcessing('feishu:chat-1', true);
    expect(state.isProcessing('feishu:chat-1')).toBe(true);

    state.setProcessing('feishu:chat-1', false);
    expect(state.isProcessing('feishu:chat-1')).toBe(false);
  });

  it('detects idle expiry and resets activity tracking', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);

    expect(state.getLastActiveTime('feishu', 'chat-1')).toBeUndefined();
    expect(state.checkAndUpdateLastActive('feishu', 'chat-1')).toBe(false);
    expect(state.getLastActiveTime('feishu', 'chat-1')).toBe(1_000);

    now.mockReturnValue(1_000 + 10 * 60 * 1000);
    expect(state.checkAndUpdateLastActive('feishu', 'chat-1')).toBe(false);
    expect(state.getSessionAge('feishu', 'chat-1')).toBe(0);

    now.mockReturnValue(1_000 + 41 * 60 * 1000);
    expect(state.checkAndUpdateLastActive('feishu', 'chat-1')).toBe(true);

    state.clearLastActive('feishu', 'chat-1');
    expect(state.getSessionAge('feishu', 'chat-1')).toBeUndefined();
    expect(state.checkAndUpdateLastActive('feishu', 'chat-1')).toBe(false);
  });
});
