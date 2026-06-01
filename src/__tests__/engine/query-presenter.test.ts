import { describe, expect, it, vi } from 'vitest';
import { FeishuFormatter } from '../../server/channels/feishu/formatter.js';
import { QueryExecutionPresenter } from '../../server/presentation/query-presenter.js';
import type { MessageRendererState } from '../../server/engine/messages/renderer.js';

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
  function createPresenter(overrides: {
    adapter?: Record<string, unknown>;
    inbound?: Record<string, unknown>;
    getMessageId?: () => string | undefined;
  } = {}): { presenter: QueryExecutionPresenter; sent: any[]; adapter: any } {
    const formatter = new FeishuFormatter('zh');
    const sent: any[] = [];
    const adapter = {
      getLocale: () => 'zh',
      shouldRenderProgressPhase: () => true,
      shouldSplitCompletedTrace: () => false,
      format: (msg: any) => formatter.format(msg),
      send: vi.fn().mockImplementation(async (message: any) => {
        sent.push(message);
        return { messageId: 'out-1', success: true };
      }),
      editMessage: vi.fn(),
      ...overrides.adapter,
    };
    const inbound = {
      channelType: 'feishu',
      chatId: 'chat-1',
      scopeId: 'chat-1#thread:thread-1',
      threadId: 'thread-1',
      replyInThread: true,
      replyTargetMessageId: 'topic-card',
      userId: 'user-1',
      text: 'run',
      messageId: 'msg-1',
      ...overrides.inbound,
    };

    return {
      adapter,
      sent,
      presenter: new QueryExecutionPresenter({
        adapter: adapter as any,
        inbound: inbound as any,
        platformLimit: 20_000,
        clearTyping: vi.fn(),
        getMessageId: overrides.getMessageId ?? (() => undefined),
        sessionKey: 'feishu:chat-1#thread:thread-1:session-1',
      }),
    };
  }

  it('does not show action buttons for completed topic progress cards', async () => {
    const { presenter, sent } = createPresenter();

    await presenter.flush('done', false, undefined, baseState());

    expect(collectActions(sent[0])).toEqual([]);
    expect(sent[0]).toMatchObject({
      replyToMessageId: 'topic-card',
      replyInThread: true,
    });
  });

  it('keeps footer metadata out of split task summary body', async () => {
    const { presenter, sent } = createPresenter({
      adapter: { shouldSplitCompletedTrace: () => true },
    });

    await presenter.flush('answer\n───────────────\n~/repo | #abcd', false, undefined, baseState({
      renderedText: 'answer\n───────────────\n~/repo | #abcd',
      responseText: 'answer',
      footerLine: '~/repo | #abcd',
      timeline: [{ kind: 'tool', toolName: 'Bash', toolInput: 'pwd' }],
      toolLogs: [{ name: 'Bash', input: 'pwd' }],
    }));

    const summaryCard = sent[1];
    const bodyText = (summaryCard.feishuElements ?? [])
      .filter((element: any) => element.tag === 'markdown')
      .map((element: any) => element.content)
      .join('\n');
    expect(bodyText).toContain('answer');
    expect(bodyText).not.toContain('~/repo | #abcd');
    const panel = (summaryCard.feishuElements ?? [])
      .find((element: any) => element.tag === 'collapsible_panel');
    expect(panel?.header?.title?.content).toBe('运行信息');
  });

  it('uses the final assistant text for split task summaries', async () => {
    const { presenter, sent } = createPresenter({
      adapter: { shouldSplitCompletedTrace: () => true },
    });

    await presenter.flush('final\n───────────────\n~/repo | #abcd', false, undefined, baseState({
      renderedText: 'final\n───────────────\n~/repo | #abcd',
      responseText: 'Plan first.\nDoing work.\nFinal result only.',
      footerLine: '~/repo | #abcd',
      timeline: [
        { kind: 'text', text: 'Plan first.' },
        { kind: 'tool', toolName: 'Bash', toolInput: 'npm test', toolResult: 'ok' },
        { kind: 'text', text: 'Final result only.' },
      ],
      toolLogs: [{ name: 'Bash', input: 'npm test' }],
    }));

    const summaryCard = sent[1];
    const bodyText = (summaryCard.feishuElements ?? [])
      .filter((element: any) => element.tag === 'markdown')
      .map((element: any) => element.content)
      .join('\n');
    expect(bodyText).toContain('Final result only.');
    expect(bodyText).not.toContain('Plan first.');
  });

  it('falls back to a new bubble when editing the progress card fails', async () => {
    const { presenter, sent, adapter } = createPresenter({
      adapter: {
        editMessage: vi.fn().mockRejectedValue(new Error('Request failed with status code 400')),
      },
      getMessageId: () => 'progress-card',
    });

    const messageId = await presenter.flush('updated progress', true, undefined, baseState({
      phase: 'executing',
      renderedText: 'updated progress',
    }));

    expect(adapter.editMessage).toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(messageId).toBe('out-1');
  });
});
