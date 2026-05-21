import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import { SessionStateManager } from '../../engine/state/session-state.js';
import { TextDispatcher } from '../../engine/messages/text-dispatcher.js';

function createAdapter(channelType = 'feishu'): BaseChannelAdapter {
  return {
    channelType,
    send: vi.fn().mockResolvedValue({ messageId: '1', success: true }),
    addReaction: vi.fn().mockResolvedValue(undefined),
    getPermissionDecisionReaction: vi.fn().mockImplementation((decision: string) => {
      if (channelType === 'feishu') {
        return decision === 'deny' ? 'No' : decision === 'allow_always' ? 'DONE' : 'OK';
      }
      return decision === 'deny' ? '👎' : decision === 'allow_always' ? '👌' : '👍';
    }),
  } as unknown as BaseChannelAdapter;
}

function createMessage(text: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channelType: 'feishu',
    chatId: 'chat-1',
    userId: 'user-1',
    text,
    messageId: 'msg-1',
    ...overrides,
  };
}

describe('TextDispatcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves text-based SDK permissions with a reaction', async () => {
    const gateway = {
      isPending: vi.fn().mockReturnValue(false),
      resolve: vi.fn(),
    };
    const permissions = {
      parsePermissionText: vi.fn().mockReturnValue('allow'),
      tryResolveByText: vi.fn().mockReturnValue(true),
      pendingPermissionCount: vi.fn().mockReturnValue(0),
      getGateway: vi.fn().mockReturnValue(gateway),
    } as any;
    const sdkEngine = {
      getInteractionState: vi.fn().mockReturnValue({
        findPendingSdkQuestion: vi.fn().mockReturnValue(null),
        findPendingDeferredTool: vi.fn().mockReturnValue(null),
        setSdkQuestionOptionAnswer: vi.fn(),
        setSdkQuestionTextAnswer: vi.fn(),
        getSdkQuestion: vi.fn().mockReturnValue(undefined),
        getDeferredTool: vi.fn().mockReturnValue(undefined),
        setDeferredToolInput: vi.fn(),
        cleanupDeferredTool: vi.fn(),
      }),
      getQuestionState: vi.fn().mockReturnValue({
        sdkQuestionData: new Map(),
        sdkQuestionAnswers: new Map(),
        sdkQuestionTextAnswers: new Map(),
      }),
    } as any;

    const dispatcher = new TextDispatcher({
      permissions,
      sdkEngine,
      state: new SessionStateManager(),
    });
    const adapter = createAdapter();

    const handled = await dispatcher.handle(adapter, createMessage('allow'));

    expect(handled).toBe(true);
    expect(adapter.addReaction).toHaveBeenCalledWith('chat-1', 'msg-1', 'OK');
  });

  it('uses Feishu-supported reaction identifiers for text-based permissions', async () => {
    const gateway = {
      isPending: vi.fn().mockReturnValue(false),
      resolve: vi.fn(),
    };
    const permissions = {
      parsePermissionText: vi.fn().mockReturnValue('deny'),
      tryResolveByText: vi.fn().mockReturnValue(true),
      pendingPermissionCount: vi.fn().mockReturnValue(0),
      getGateway: vi.fn().mockReturnValue(gateway),
    } as any;
    const sdkEngine = {
      getInteractionState: vi.fn().mockReturnValue({
        findPendingSdkQuestion: vi.fn().mockReturnValue(null),
        findPendingDeferredTool: vi.fn().mockReturnValue(null),
        setSdkQuestionOptionAnswer: vi.fn(),
        setSdkQuestionTextAnswer: vi.fn(),
        getSdkQuestion: vi.fn().mockReturnValue(undefined),
        getDeferredTool: vi.fn().mockReturnValue(undefined),
        setDeferredToolInput: vi.fn(),
        cleanupDeferredTool: vi.fn(),
      }),
      getQuestionState: vi.fn().mockReturnValue({
        sdkQuestionData: new Map(),
        sdkQuestionAnswers: new Map(),
        sdkQuestionTextAnswers: new Map(),
      }),
    } as any;

    const dispatcher = new TextDispatcher({
      permissions,
      sdkEngine,
      state: new SessionStateManager(),
    });
    const adapter = createAdapter('feishu');

    const handled = await dispatcher.handle(
      adapter,
      createMessage('deny', { channelType: 'feishu' }),
    );

    expect(handled).toBe(true);
    expect(adapter.addReaction).toHaveBeenCalledWith('chat-1', 'msg-1', 'No');
  });

  it('routes numeric replies into pending SDK AskUserQuestion state', async () => {
    const gateway = {
      isPending: vi.fn().mockReturnValue(true),
      resolve: vi.fn().mockReturnValue(true),
    };
    const sdkQuestionAnswers = new Map<string, number>();
    const permissions = {
      parsePermissionText: vi.fn().mockReturnValue(null),
      tryResolveByText: vi.fn().mockReturnValue(false),
      pendingPermissionCount: vi.fn().mockReturnValue(0),
      getGateway: vi.fn().mockReturnValue(gateway),
    } as any;
    const sdkEngine = {
      getInteractionState: vi.fn().mockReturnValue({
        findPendingSdkQuestion: vi.fn().mockReturnValue({ permId: 'askq-1' }),
        findPendingDeferredTool: vi.fn().mockReturnValue(null),
        setSdkQuestionOptionAnswer: vi.fn((permId: string, optionIndex: number) => {
          sdkQuestionAnswers.set(permId, optionIndex);
        }),
        setSdkQuestionTextAnswer: vi.fn(),
        getSdkQuestion: vi.fn().mockReturnValue({
          chatId: 'chat-1',
          questions: [{
            question: 'Pick one',
            header: 'Question',
            options: [{ label: 'One' }, { label: 'Two' }],
            multiSelect: false,
          }],
        }),
        getDeferredTool: vi.fn().mockReturnValue(undefined),
        setDeferredToolInput: vi.fn(),
        cleanupDeferredTool: vi.fn(),
      }),
      getQuestionState: vi.fn().mockReturnValue({
        sdkQuestionData: new Map([
          ['askq-1', {
            chatId: 'chat-1',
            questions: [{
              question: 'Pick one',
              header: 'Question',
              options: [{ label: 'One' }, { label: 'Two' }],
              multiSelect: false,
            }],
          }],
        ]),
        sdkQuestionAnswers,
        sdkQuestionTextAnswers: new Map<string, string>(),
      }),
    } as any;

    const dispatcher = new TextDispatcher({
      permissions,
      sdkEngine,
      state: new SessionStateManager(),
    });

    const handled = await dispatcher.handle(createAdapter(), createMessage('2'));

    expect(handled).toBe(true);
    expect(sdkQuestionAnswers.get('askq-1')).toBe(1);
    expect(gateway.resolve).toHaveBeenCalledWith('askq-1', 'allow');
  });

});
