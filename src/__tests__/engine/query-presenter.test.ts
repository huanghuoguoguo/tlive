import { describe, expect, it, vi } from 'vitest';
import { FeishuFormatter } from '../../channels/feishu/formatter.js';
import { QueryExecutionPresenter } from '../../engine/messages/query-presenter.js';
import type { MessageRendererState } from '../../engine/messages/renderer.js';

function collectActions(message: any): string[] {
  const actions: string[] = [];
  const visit = (item: any): void => {
    if (!item) return;
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    const action = item.behaviors?.[0]?.value?.action;
    if (action) actions.push(action);
    if (item.elements) visit(item.elements);
    if (item.columns) visit(item.columns);
  };
  visit(message?.feishuElements ?? []);
  return actions;
}

function baseState(overrides: Partial<MessageRendererState> = {}): MessageRendererState {
  return {
    phase: 'completed',
    renderedText: 'done',
    responseText: 'done',
    elapsedSeconds: 1,
    totalTools: 0,
    toolSummary: '',
    permissionRequests: 0,
    currentTool: null,
    todoItems: [],
    thinkingText: '',
    toolLogs: [],
    timeline: [],
    ...overrides,
  };
}

describe('QueryExecutionPresenter', () => {
  it('uses only the Help action for completed topic progress cards', async () => {
    const formatter = new FeishuFormatter('zh');
    const sent: any[] = [];
    const presenter = new QueryExecutionPresenter({
      adapter: {
        getLocale: () => 'zh',
        shouldRenderProgressPhase: () => true,
        shouldSplitCompletedTrace: () => false,
        format: (msg: any) => formatter.format(msg),
        send: vi.fn().mockImplementation(async (message: any) => {
          sent.push(message);
          return { messageId: 'out-1', success: true };
        }),
        editMessage: vi.fn(),
      } as any,
      inbound: {
        channelType: 'feishu',
        chatId: 'chat-1',
        scopeId: 'chat-1#thread:thread-1',
        threadId: 'thread-1',
        replyInThread: true,
        replyTargetMessageId: 'topic-card',
        userId: 'user-1',
        text: 'run',
        messageId: 'msg-1',
      },
      platformLimit: 20_000,
      clearTyping: vi.fn(),
      getMessageId: () => undefined,
      sessionKey: 'feishu:chat-1#thread:thread-1:session-1',
    });

    await presenter.flush('done', false, undefined, baseState());

    expect(collectActions(sent[0])).toEqual(['cmd:help']);
    expect(sent[0]).toMatchObject({
      replyToMessageId: 'topic-card',
      replyInThread: true,
    });
  });
});
