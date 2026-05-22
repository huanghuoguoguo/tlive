import { describe, expect, it, vi } from 'vitest';
import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import { InboundDispatcher } from '../../engine/coordinators/inbound-dispatcher.js';
import { TextDispatcher } from '../../engine/messages/text-dispatcher.js';
import { SessionStateManager } from '../../engine/state/session-state.js';

function createAdapter(): BaseChannelAdapter {
  return {
    channelType: 'feishu',
    isAuthorized: vi.fn().mockReturnValue(true),
    send: vi.fn().mockResolvedValue({ messageId: 'sent-1', success: true }),
    addReaction: vi.fn().mockResolvedValue(undefined),
    getLocale: vi.fn().mockReturnValue('zh'),
    getPermissionDecisionReaction: vi.fn().mockReturnValue('OK'),
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

type PendingInteraction = 'none' | 'question' | 'deferred';

function createTextHarness(pending: PendingInteraction) {
  const state = new SessionStateManager();
  const gateway = {
    isPending: vi.fn().mockReturnValue(pending !== 'none'),
    resolve: vi.fn().mockReturnValue(true),
  };
  const interactionState = {
    findPendingSdkQuestion: vi.fn().mockReturnValue(
      pending === 'question' ? { permId: 'askq-1' } : null,
    ),
    findPendingDeferredTool: vi.fn().mockReturnValue(
      pending === 'deferred' ? { permId: 'deferred-1', toolName: 'EnterPlanMode' } : null,
    ),
    setSdkQuestionOptionAnswer: vi.fn(),
    setSdkQuestionTextAnswer: vi.fn(),
    getSdkQuestion: vi.fn().mockReturnValue({
      chatId: 'chat-1',
      questions: [{
        question: 'Continue?',
        header: 'Question',
        options: [],
        multiSelect: false,
      }],
    }),
    getDeferredTool: vi.fn().mockReturnValue(undefined),
    setDeferredToolInput: vi.fn(),
    cleanupDeferredTool: vi.fn(),
  };
  const sdkEngine = {
    getInteractionState: vi.fn().mockReturnValue(interactionState),
  };
  const permissions = {
    parsePermissionText: vi.fn().mockReturnValue(null),
    tryResolveByText: vi.fn().mockReturnValue(false),
    getGateway: vi.fn().mockReturnValue(gateway),
  };
  const text = new TextDispatcher({
    permissions: permissions as any,
    sdkEngine: sdkEngine as any,
    state,
  });

  return { state, gateway, interactionState, sdkEngine, permissions, text };
}

function createDispatcher(harness: ReturnType<typeof createTextHarness>, commandsHandled = false) {
  const commands = {
    handle: vi.fn().mockResolvedValue(commandsHandled),
    handleAction: vi.fn().mockResolvedValue(false),
  };
  const query = {
    run: vi.fn().mockResolvedValue(true),
  };
  const ingress = {
    recordDeliveryTarget: vi.fn(),
    prepareAttachments: vi.fn().mockImplementation((msg: InboundMessage) => ({
      message: msg,
      handled: false,
    })),
  };

  const dispatcher = new InboundDispatcher({
    state: harness.state,
    ingress: ingress as any,
    text: harness.text,
    permissions: harness.permissions as any,
    sdkEngine: harness.sdkEngine as any,
    commands: commands as any,
    query: query as any,
  });

  return { dispatcher, commands, query, ingress };
}

describe('InboundDispatcher', () => {
  it('routes public /stop before pending SDK question text handling', async () => {
    const harness = createTextHarness('question');
    const { dispatcher, commands, query } = createDispatcher(harness, true);
    const textHandle = vi.spyOn(harness.text, 'handle');
    const adapter = createAdapter();

    const handled = await dispatcher.handle(adapter, createMessage('/stop'), 'req-stop');

    expect(handled).toBe(true);
    expect(commands.handle).toHaveBeenCalledWith(adapter, expect.objectContaining({ text: '/stop' }));
    expect(textHandle).not.toHaveBeenCalled();
    expect(harness.interactionState.setSdkQuestionTextAnswer).not.toHaveBeenCalled();
    expect(harness.gateway.resolve).not.toHaveBeenCalled();
    expect(query.run).not.toHaveBeenCalled();
  });

  it('routes public /stop before pending deferred tool input handling', async () => {
    const harness = createTextHarness('deferred');
    const { dispatcher, commands, query } = createDispatcher(harness, true);
    const textHandle = vi.spyOn(harness.text, 'handle');
    const adapter = createAdapter();

    const handled = await dispatcher.handle(adapter, createMessage('/stop'), 'req-stop');

    expect(handled).toBe(true);
    expect(commands.handle).toHaveBeenCalledWith(adapter, expect.objectContaining({ text: '/stop' }));
    expect(textHandle).not.toHaveBeenCalled();
    expect(harness.interactionState.setDeferredToolInput).not.toHaveBeenCalled();
    expect(harness.gateway.resolve).not.toHaveBeenCalled();
    expect(query.run).not.toHaveBeenCalled();
  });

  it('still submits ordinary text replies to a pending SDK question', async () => {
    const harness = createTextHarness('question');
    const { dispatcher, commands, query } = createDispatcher(harness);
    const adapter = createAdapter();

    const handled = await dispatcher.handle(adapter, createMessage('plain answer'), 'req-answer');

    expect(handled).toBe(true);
    expect(commands.handle).not.toHaveBeenCalled();
    expect(harness.interactionState.setSdkQuestionTextAnswer).toHaveBeenCalledWith(
      'askq-1',
      'plain answer',
    );
    expect(harness.gateway.resolve).toHaveBeenCalledWith('askq-1', 'allow');
    expect(query.run).not.toHaveBeenCalled();
  });

  it('keeps unknown slash input on the agent path inside a topic', async () => {
    const harness = createTextHarness('none');
    const { dispatcher, commands, query } = createDispatcher(harness);
    const adapter = createAdapter();
    const msg = createMessage('/agent-native-command arg', {
      threadId: 'thread-1',
      scopeId: 'chat-1#thread:thread-1',
    });

    const handled = await dispatcher.handle(adapter, msg, 'req-settings');

    expect(handled).toBe(true);
    expect(commands.handle).toHaveBeenCalledWith(adapter, msg);
    expect(query.run).toHaveBeenCalledWith(adapter, msg, 'req-settings');
  });
});
