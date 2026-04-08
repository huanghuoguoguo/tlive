import { describe, expect, it, vi } from 'vitest';
import type { BaseChannelAdapter } from '../channels/base.js';
import { HookNotificationDispatcher } from '../engine/hook-notification-dispatcher.js';

function createAdapter(channelType = 'telegram'): BaseChannelAdapter {
  return {
    channelType,
    send: vi.fn().mockResolvedValue({ messageId: 'msg-1', success: true }),
  } as unknown as BaseChannelAdapter;
}

describe('HookNotificationDispatcher', () => {
  it('formats stop notifications and tracks reply routing', async () => {
    const permissions = {
      trackHookMessage: vi.fn(),
    } as any;
    const dispatcher = new HookNotificationDispatcher({
      permissions,
      isCoreAvailable: () => true,
      buildTerminalUrl: (sessionId) => `http://localhost:8080/terminal.html?id=${sessionId}&token=t`,
    });
    const adapter = createAdapter();

    await dispatcher.send(adapter, 'chat-1', {
      tlive_hook_type: 'stop',
      tlive_session_id: 'sess-1',
      last_output: 'task finished',
    });

    const sent = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const content = sent.html ?? sent.text ?? '';
    expect(content).toContain('Terminal');
    expect(permissions.trackHookMessage).toHaveBeenCalledWith('msg-1', 'sess-1');
  });

  it('formats idle prompt notifications with the message text', async () => {
    const dispatcher = new HookNotificationDispatcher({
      permissions: { trackHookMessage: vi.fn() } as any,
      isCoreAvailable: () => false,
      buildTerminalUrl: () => '',
    });
    const adapter = createAdapter('discord');

    await dispatcher.send(adapter, 'chat-1', {
      notification_type: 'idle_prompt',
      message: 'Claude is waiting for input',
      tlive_session_id: 'sess-2',
    });

    const sent = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const content = JSON.stringify(sent);
    expect(content).toContain('Claude is waiting for input');
  });
});
