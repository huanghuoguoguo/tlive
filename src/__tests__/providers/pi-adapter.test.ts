import { describe, expect, it } from 'vitest';
import { PiAdapter } from '../../client/providers/pi-adapter.js';

describe('PiAdapter', () => {
  it('maps text, thinking, and tool execution events', () => {
    const adapter = new PiAdapter({ sessionId: 'pi-session' });

    expect(adapter.mapEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    } as any)).toEqual([{ kind: 'text_delta', text: 'hello' }]);

    expect(adapter.mapEvent({
      type: 'message_update',
      message: {},
      assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking' },
    } as any)).toEqual([{ kind: 'thinking_delta', text: 'thinking' }]);

    expect(adapter.mapEvent({
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'bash',
      args: { command: 'npm test' },
    } as any)).toEqual([
      {
        kind: 'tool_start',
        id: 'tool-1',
        name: 'bash',
        input: { command: 'npm test' },
      },
    ]);

    expect(adapter.mapEvent({
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'ok' }], details: {} },
      isError: false,
    } as any)).toEqual([
      {
        kind: 'tool_result',
        toolUseId: 'tool-1',
        content: 'ok',
        isError: false,
        isFinal: true,
      },
    ]);
  });

  it('maps final usage into a canonical query result', () => {
    const adapter = new PiAdapter({ sessionId: 'pi-session' });
    const messages = [
      {
        role: 'assistant',
        usage: {
          input: 10,
          output: 4,
          cacheRead: 2,
          cacheWrite: 1,
          cost: { total: 0.01 },
        },
      },
    ];

    expect(adapter.mapEvent({
      type: 'agent_end',
      willRetry: false,
      messages,
    } as any)).toEqual([]);
    expect(adapter.mapComplete(messages, 17)).toEqual([
      {
        kind: 'query_result',
        sessionId: 'pi-session',
        isError: false,
        usage: {
          inputTokens: 13,
          outputTokens: 4,
          cachedInputTokens: 2,
          contextTokens: 17,
          costUsd: 0.01,
        },
      },
    ]);

    expect(adapter.mapComplete()).toEqual([]);
  });

  it('uses current-turn messages across multiple conversations and falls back after an empty agent_end', () => {
    const previousTurn = assistantUsage(1000, 100, 800);
    const currentTurn = assistantUsage(20, 5, 15);

    const adapter = new PiAdapter({ sessionId: 'pi-session' });
    adapter.mapEvent({
      type: 'agent_end',
      willRetry: false,
      messages: [currentTurn],
    } as any);

    expect(adapter.mapComplete([previousTurn, currentTurn], 40)[0]).toMatchObject({
      usage: {
        inputTokens: 35,
        cachedInputTokens: 15,
        outputTokens: 5,
        contextTokens: 40,
      },
    });

    const emptyEndAdapter = new PiAdapter({ sessionId: 'pi-session' });
    emptyEndAdapter.mapEvent({
      type: 'agent_end',
      willRetry: false,
      messages: [],
    } as any);

    expect(emptyEndAdapter.mapComplete([currentTurn], 40)[0]).toMatchObject({
      usage: {
        inputTokens: 35,
        cachedInputTokens: 15,
        outputTokens: 5,
        contextTokens: 40,
      },
    });
  });

  it('reports both compaction phases so the indicator can clear', () => {
    const adapter = new PiAdapter({ sessionId: 'pi-session' });

    expect(
      adapter.mapEvent({ type: 'compaction_start', reason: 'threshold' } as any),
    ).toEqual([{ kind: 'compact_boundary', trigger: 'auto', phase: 'start' }]);

    expect(
      adapter.mapEvent({
        type: 'compaction_end',
        reason: 'manual',
        result: { summary: 's', firstKeptEntryId: 'e4', tokensBefore: 99072 },
        aborted: false,
        willRetry: false,
      } as any),
    ).toEqual([
      { kind: 'compact_boundary', trigger: 'manual', phase: 'end', preTokens: 99072 },
    ]);

    expect(
      adapter.mapEvent({
        type: 'compaction_end',
        reason: 'overflow',
        result: undefined,
        aborted: false,
        willRetry: false,
        errorMessage: 'Context overflow recovery failed',
      } as any),
    ).toEqual([
      {
        kind: 'compact_boundary',
        trigger: 'auto',
        phase: 'end',
        errorMessage: 'Context overflow recovery failed',
      },
    ]);
  });
});

function assistantUsage(input: number, output: number, cacheRead: number): unknown {
  return {
    role: 'assistant',
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite: 0,
      cost: { total: 0 },
    },
  };
}
