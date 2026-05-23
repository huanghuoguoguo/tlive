import { describe, expect, it, vi } from 'vitest';
import { SDKPermissionHandler } from '../../server/engine/sdk/permission-handler.js';
import { SessionStateManager } from '../../server/engine/state/session-state.js';

function createHandler(
  waitForResult: { behavior: 'allow' | 'allow_always' | 'deny'; grantScope?: 'same_command' | 'session_all' },
) {
  const state = new SessionStateManager();
  const waitFor = vi.fn().mockResolvedValue(waitForResult);
  const permissions = {
    isToolAllowed: vi.fn().mockReturnValue(false),
    getGateway: vi.fn().mockReturnValue({ waitFor, resolve: vi.fn() }),
    setPendingSdkPerm: vi.fn(),
    clearPendingSdkPerm: vi.fn(),
    notePermissionPending: vi.fn(),
    notePermissionResolved: vi.fn(),
    clearPendingPermissionSnapshot: vi.fn(),
    rememberSameCommandAllowance: vi.fn(),
    rememberSessionAllowance: vi.fn(),
  };
  const renderer = {
    onPermissionNeeded: vi.fn(),
    onPermissionResolved: vi.fn(),
  };
  const handler = new SDKPermissionHandler({
    adapter: { getLocale: () => 'zh' },
    msg: {
      channelType: 'feishu',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'run',
      messageId: 'msg-1',
    },
    binding: { sessionId: 'session-1' },
    permissions,
    state,
    router: {},
    renderer,
    reactions: { permission: 'Pin', processing: 'Loading' },
    askQuestionApproved: false,
  } as any);

  return { handler, permissions, renderer, state };
}

describe('SDKPermissionHandler', () => {
  it('renders localized four-button permission choices and remembers same command grants', async () => {
    const { handler, permissions, renderer } = createHandler({
      behavior: 'allow',
      grantScope: 'same_command',
    });

    const result = await handler.handle('Bash', { command: 'npm test' }, 'Need Bash');

    expect(result).toBe('allow');
    const buttons = renderer.onPermissionNeeded.mock.calls[0][3];
    expect(buttons.map((button: any) => button.label)).toEqual([
      '允许一次',
      '允许相同命令',
      '本 session 全部允许',
      '拒绝',
    ]);
    expect(buttons.map((button: any) => button.callbackData)).toEqual([
      buttons[0].callbackData,
      buttons[0].callbackData.replace('perm:allow:', 'perm:allow_same:'),
      buttons[0].callbackData.replace('perm:allow:', 'perm:allow_all_session:'),
      buttons[0].callbackData.replace('perm:allow:', 'perm:deny:'),
    ]);
    expect(permissions.rememberSameCommandAllowance).toHaveBeenCalledWith(
      'session-1',
      'Bash',
      { command: 'npm test' },
    );
  });

  it('turns off approval only for the current bridge session on session-wide grants', async () => {
    const { handler, state } = createHandler({
      behavior: 'allow',
      grantScope: 'session_all',
    });

    const result = await handler.handle('Edit', { file_path: 'src/main.ts' }, 'Need edit');

    expect(result).toBe('allow');
    expect(state.getPermMode('feishu', 'chat-1', 'session-1')).toBe('off');
    expect(state.getPermMode('feishu', 'chat-1', 'session-2')).toBe('on');
  });
});
