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

    expect(adapter.mapEvent({
      type: 'agent_end',
      willRetry: false,
      messages: [
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
      ],
    } as any)).toEqual([
      {
        kind: 'query_result',
        sessionId: 'pi-session',
        isError: false,
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cachedInputTokens: 3,
          costUsd: 0.01,
        },
      },
    ]);

    expect(adapter.mapComplete()).toEqual([]);
  });
});
