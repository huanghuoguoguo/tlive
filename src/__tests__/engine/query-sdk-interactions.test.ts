import { describe, expect, it, vi } from 'vitest';
import { FeishuFormatter } from '../../server/channels/feishu/formatter.js';
import { QuerySdkInteractionsFactory } from '../../server/engine/coordinators/query-sdk-interactions.js';
import { InteractionState } from '../../server/engine/state/interaction-state.js';
import { SessionStateManager } from '../../server/engine/state/session-state.js';

describe('QuerySdkInteractionsFactory', () => {
  it('auto-allows the next tool after AskUserQuestion is approved', async () => {
    const formatter = new FeishuFormatter('zh');
    const gateway = {
      waitFor: vi.fn().mockResolvedValue({ behavior: 'allow' }),
      resolve: vi.fn(),
    };
    const permissions = {
      getGateway: vi.fn().mockReturnValue(gateway),
      isToolAllowed: vi.fn().mockReturnValue(false),
      trackPermissionMessage: vi.fn(),
      cleanupQuestion: vi.fn(),
      storeQuestionData: vi.fn(),
      setPendingSdkPerm: vi.fn(),
      clearPendingSdkPerm: vi.fn(),
      notePermissionPending: vi.fn(),
      notePermissionResolved: vi.fn(),
      clearPendingPermissionSnapshot: vi.fn(),
      rememberSameCommandAllowance: vi.fn(),
      rememberSessionAllowance: vi.fn(),
    };
    const adapter = {
      channelType: 'feishu',
      getLocale: vi.fn().mockReturnValue('zh'),
      format: vi.fn().mockImplementation((msg) => formatter.format(msg)),
      send: vi.fn().mockResolvedValue({ messageId: 'question-card', success: true }),
      editCardResolution: vi.fn().mockResolvedValue(undefined),
    };
    const renderer = {
      onPermissionNeeded: vi.fn(),
      onPermissionResolved: vi.fn(),
    };

    const factory = new QuerySdkInteractionsFactory({
      permissions: permissions as any,
      state: new SessionStateManager(),
      router: {} as any,
      interactionState: new InteractionState(),
    });

    const interactions = factory.create({
      adapter: adapter as any,
      msg: {
        channelType: 'feishu',
        chatId: 'chat-1',
        userId: 'user-1',
        text: 'run',
        messageId: 'msg-1',
      },
      binding: { channelType: 'feishu', chatId: 'chat-1', sessionId: 'session-1', createdAt: '' },
      renderer: renderer as any,
      reactions: { permission: 'Pin', processing: 'Typing' },
    });

    const answers = await interactions.askQuestion([
      {
        question: 'Continue?',
        header: 'Confirm',
        options: [{ label: 'Yes' }],
        multiSelect: false,
      },
    ]);
    const permission = await interactions.permission('Bash', { command: 'rm -rf tmp' }, 'Need Bash');

    expect(answers).toEqual({ 'Continue?': '' });
    expect(permission).toBe('allow');
    expect(gateway.waitFor).toHaveBeenCalledTimes(1);
    expect(renderer.onPermissionNeeded).not.toHaveBeenCalled();
  });
});
