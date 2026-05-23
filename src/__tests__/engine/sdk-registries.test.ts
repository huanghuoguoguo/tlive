import { describe, expect, it, vi } from 'vitest';
import type { DeliveryRoute } from '../../server/channels/delivery-route.js';
import type { QueryControls } from '../../shared/providers/base.js';
import { FileDeliveryRegistry } from '../../server/engine/sdk/file-delivery-registry.js';
import { TurnControlRegistry } from '../../server/engine/sdk/turn-control-registry.js';

function createControls(): QueryControls {
  return {
    interrupt: vi.fn().mockResolvedValue(undefined),
    stopTask: vi.fn().mockResolvedValue(undefined),
  };
}

function createRoute(): DeliveryRoute {
  return {
    channelType: 'feishu',
    chatId: 'chat-1',
    scopeId: 'chat-1#thread:thread-1',
    threadId: 'thread-1',
    replyToMessageId: 'msg-1',
    replyInThread: true,
  };
}

describe('TurnControlRegistry', () => {
  it('looks up controls by chat and session, then removes them on cleanup', () => {
    const registry = new TurnControlRegistry();
    const controls = createControls();
    const chatKey = 'feishu:chat-1';
    const sessionKey = 'feishu:chat-1:session-1';

    registry.setControlsForChat(chatKey, controls, sessionKey);

    expect(registry.getControlsForChat(chatKey)).toBe(controls);
    expect(registry.getControlsForSession(sessionKey)).toBe(controls);
    expect(registry.getActiveControls().get(chatKey)).toBe(controls);

    registry.cleanupSessionControls(sessionKey);

    expect(registry.getControlsForChat(chatKey)).toBeUndefined();
    expect(registry.getControlsForSession(sessionKey)).toBeUndefined();
    expect(registry.getActiveControls().has(chatKey)).toBe(false);
  });
});

describe('FileDeliveryRegistry', () => {
  it('consumes a file delivery token once', () => {
    const registry = new FileDeliveryRegistry({
      generateToken: () => 'route-token',
      now: () => 1_000,
    });

    const token = registry.register('feishu:chat-1:session-1', createRoute(), '/workdir');

    expect(token).toBe('route-token');
    expect(registry.resolve(token)).toMatchObject({
      chatId: 'chat-1',
      cwd: '/workdir',
      sessionKey: 'feishu:chat-1:session-1',
    });
    expect(registry.consume(token)).toMatchObject({
      chatId: 'chat-1',
      cwd: '/workdir',
      sessionKey: 'feishu:chat-1:session-1',
    });
    expect(registry.consume(token)).toBeUndefined();
    expect(registry.resolve(token)).toBeUndefined();
  });

  it('prunes expired file delivery tokens before resolving or consuming', () => {
    let now = 1_000;
    const registry = new FileDeliveryRegistry({
      ttlMs: 50,
      generateToken: () => 'expired-token',
      now: () => now,
    });
    const token = registry.register('feishu:chat-1:session-1', createRoute(), '/workdir');

    now = 1_051;

    expect(registry.resolve(token)).toBeUndefined();
    expect(registry.consume(token)).toBeUndefined();
  });
});
