import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import { SessionStateManager } from '../engine/session-state.js';
import { TextDispatcher } from '../engine/text-dispatcher.js';

function createAdapter(channelType = 'telegram'): BaseChannelAdapter {
  return {
    channelType,
    send: vi.fn().mockResolvedValue({ messageId: '1', success: true }),
    addReaction: vi.fn().mockResolvedValue(undefined),
  } as unknown as BaseChannelAdapter;
}

function createMessage(text: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channelType: 'telegram',
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
      findHookPermission: vi.fn(),
      getLatestPendingQuestion: vi.fn().mockReturnValue(null),
      isHookMessage: vi.fn().mockReturnValue(false),
      getGateway: vi.fn().mockReturnValue(gateway),
    } as any;
    const sdkEngine = {
      getInteractionState: vi.fn().mockReturnValue({
        findPendingSdkQuestion: vi.fn().mockReturnValue(null),
        setSdkQuestionOptionAnswer: vi.fn(),
        setSdkQuestionTextAnswer: vi.fn(),
        getSdkQuestion: vi.fn().mockReturnValue(undefined),
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
    expect(adapter.addReaction).toHaveBeenCalledWith('chat-1', 'msg-1', '👍');
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
      findHookPermission: vi.fn(),
      getLatestPendingQuestion: vi.fn().mockReturnValue(null),
      isHookMessage: vi.fn().mockReturnValue(false),
      getGateway: vi.fn().mockReturnValue(gateway),
    } as any;
    const sdkEngine = {
      getInteractionState: vi.fn().mockReturnValue({
        findPendingSdkQuestion: vi.fn().mockReturnValue(null),
        setSdkQuestionOptionAnswer: vi.fn(),
        setSdkQuestionTextAnswer: vi.fn(),
        getSdkQuestion: vi.fn().mockReturnValue(undefined),
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
      findHookPermission: vi.fn(),
      getLatestPendingQuestion: vi.fn().mockReturnValue(null),
      isHookMessage: vi.fn().mockReturnValue(false),
      getGateway: vi.fn().mockReturnValue(gateway),
    } as any;
    const sdkEngine = {
      getInteractionState: vi.fn().mockReturnValue({
        findPendingSdkQuestion: vi.fn().mockReturnValue({ permId: 'askq-1' }),
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

  it('shows warning for hook replies (feature removed with Go Core)', async () => {
    const permissions = {
      parsePermissionText: vi.fn().mockReturnValue(null),
      tryResolveByText: vi.fn().mockReturnValue(false),
      pendingPermissionCount: vi.fn().mockReturnValue(0),
      findHookPermission: vi.fn(),
      getLatestPendingQuestion: vi.fn().mockReturnValue(null),
      isHookMessage: vi.fn().mockReturnValue(true),
      getHookMessage: vi.fn().mockReturnValue({ sessionId: 'session-1', timestamp: Date.now() }),
      getQuestionData: vi.fn().mockReturnValue(undefined),
      storeQuestionData: vi.fn(),
      trackPermissionMessage: vi.fn(),
      resolveAskQuestion: vi.fn(),
      resolveAskQuestionWithText: vi.fn(),
      getGateway: vi.fn().mockReturnValue({
        isPending: vi.fn().mockReturnValue(false),
        resolve: vi.fn(),
      }),
    } as any;
    const sdkEngine = {
      getInteractionState: vi.fn().mockReturnValue({
        findPendingSdkQuestion: vi.fn().mockReturnValue(null),
        setSdkQuestionOptionAnswer: vi.fn(),
        setSdkQuestionTextAnswer: vi.fn(),
        getSdkQuestion: vi.fn().mockReturnValue(undefined),
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

    const handled = await dispatcher.handle(adapter, createMessage('send this', { replyToMessageId: 'hook-1' }));

    expect(handled).toBe(true);
    expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({ text: '⚠️ Hook reply feature no longer available' }));
  });
});
