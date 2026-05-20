import { describe, it, expect, vi } from 'vitest';
import { handleCallbackMessage } from '../../engine/messages/callback-dispatcher.js';

function createAdapter() {
  return {
    channelType: 'feishu',
    send: vi.fn().mockResolvedValue({}),
    editCardResolution: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function createDeps() {
  const resolve = vi.fn();
  const cleanupQuestion = vi.fn();
  const sdkQuestionData = new Map([
    ['perm-1', {
      questions: [{
        question: 'Proceed?',
        header: 'Confirm',
        options: [{ label: 'Allow' }, { label: 'Deny' }],
        multiSelect: false,
      }],
    }],
  ]);
  const sdkQuestionAnswers = new Map<string, number>();
  const sdkQuestionTextAnswers = new Map<string, string>();

  return {
    resolve,
    cleanupQuestion,
    sdkQuestionAnswers,
    sdkQuestionTextAnswers,
    deps: {
      permissions: {
        cleanupQuestion,
        getGateway: () => ({ resolve }),
      },
      sdkEngine: {
        getSessionForBubble: vi.fn().mockReturnValue(undefined),
        getSessionContext: vi.fn().mockReturnValue(undefined),
        getInteractionState: () => ({
          getSdkQuestion: (permId: string) => sdkQuestionData.get(permId),
          getDeferredTool: (permId: string) => undefined,
          setSdkQuestionOptionAnswer: (permId: string, optionIndex: number) => {
            sdkQuestionAnswers.set(permId, optionIndex);
          },
          setSdkQuestionTextAnswer: (permId: string, text: string) => {
            sdkQuestionTextAnswers.set(permId, text);
          },
          cleanupSdkQuestion: (permId: string) => {
            sdkQuestionData.delete(permId);
            sdkQuestionAnswers.delete(permId);
            sdkQuestionTextAnswers.delete(permId);
          },
        }),
        getQuestionState: () => ({
          sdkQuestionData,
          sdkQuestionAnswers,
          sdkQuestionTextAnswers,
        }),
      },
      replayMessage: vi.fn(),
    } as any,
  };
}

describe('handleCallbackMessage form submissions', () => {
  it('does not resolve empty Feishu form submissions', async () => {
    const adapter = createAdapter();
    const { deps, resolve, cleanupQuestion } = createDeps();

    const handled = await handleCallbackMessage(adapter, {
      channelType: 'feishu',
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'msg-1',
      callbackData: 'form:perm-1:{"_text_answer":"   ","_select":""}',
    } as any, deps);

    expect(handled).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
    expect(cleanupQuestion).not.toHaveBeenCalled();
    expect(adapter.editCardResolution).not.toHaveBeenCalled();
    expect(adapter.send).toHaveBeenCalledWith({
      chatId: 'chat-1',
      text: '⚠️ Please enter an answer or choose an option before submitting.',
    });
  });

  it('does not resolve invalid select values', async () => {
    const adapter = createAdapter();
    const { deps, resolve, cleanupQuestion } = createDeps();

    const handled = await handleCallbackMessage(adapter, {
      channelType: 'feishu',
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'msg-1',
      callbackData: 'form:perm-1:{"_select":"Maybe"}',
    } as any, deps);

    expect(handled).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
    expect(cleanupQuestion).not.toHaveBeenCalled();
    expect(adapter.editCardResolution).not.toHaveBeenCalled();
    expect(adapter.send).toHaveBeenCalledWith({
      chatId: 'chat-1',
      text: '⚠️ Invalid selection, please try again.',
    });
  });

  it('resolves valid text submissions', async () => {
    const adapter = createAdapter();
    const { deps, resolve, cleanupQuestion, sdkQuestionTextAnswers } = createDeps();

    const handled = await handleCallbackMessage(adapter, {
      channelType: 'feishu',
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'msg-1',
      callbackData: 'form:perm-1:{"_text_answer":"hello"}',
    } as any, deps);

    expect(handled).toBe(true);
    expect(sdkQuestionTextAnswers.get('perm-1')).toBe('hello');
    expect(cleanupQuestion).toHaveBeenCalledWith('perm-1');
    expect(resolve).toHaveBeenCalledWith('perm-1', 'allow');
    expect(adapter.editCardResolution).toHaveBeenCalled();
  });

  it('infers Feishu topic scope from a callback card bubble', async () => {
    const adapter = createAdapter();
    const { deps } = createDeps();
    deps.sdkEngine.getSessionForBubble.mockReturnValue('feishu:chat-1#thread:thread-1:session-1');
    deps.sdkEngine.getSessionContext.mockReturnValue({
      channelType: 'feishu',
      chatId: 'chat-1#thread:thread-1',
      bindingSessionId: 'session-1',
      workdir: '/tmp/project',
      lastActiveAt: Date.now(),
    });

    const handled = await handleCallbackMessage(adapter, {
      channelType: 'feishu',
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'msg-card-1',
      callbackData: 'cmd:home',
    } as any, deps);

    expect(handled).toBe(true);
    expect(deps.replayMessage).toHaveBeenCalledWith(adapter, expect.objectContaining({
      chatId: 'chat-1',
      scopeId: 'chat-1#thread:thread-1',
      threadId: 'thread-1',
      replyInThread: true,
      replyTargetMessageId: 'msg-card-1',
      text: '/home',
    }));
  });
});
