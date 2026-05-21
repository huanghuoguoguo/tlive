import { describe, expect, it } from 'vitest';
import type { ThreadEvent } from '@openai/codex-sdk';
import { CodexAdapter } from '../../providers/codex-adapter.js';

describe('CodexAdapter', () => {
  it('maps thread lifecycle and turn completion', () => {
    const adapter = new CodexAdapter({ model: 'gpt-5.5' });

    expect(adapter.mapEvent({ type: 'thread.started', thread_id: 'thread-1' })).toEqual([
      { kind: 'status', sessionId: 'thread-1', model: 'gpt-5.5' },
    ]);
    expect(adapter.mapEvent({ type: 'turn.started' })).toEqual([
      { kind: 'session_state', state: 'running' },
    ]);
    expect(adapter.mapEvent({
      type: 'turn.completed',
      usage: {
        input_tokens: 10,
        cached_input_tokens: 2,
        output_tokens: 4,
        reasoning_output_tokens: 1,
      },
    })).toEqual([
      {
        kind: 'query_result',
        sessionId: 'thread-1',
        isError: false,
        usage: { inputTokens: 10, outputTokens: 4 },
      },
    ]);
  });

  it('emits text deltas without duplicating updated content', () => {
    const adapter = new CodexAdapter({ sessionId: 'thread-1' });

    const first = adapter.mapEvent(agentMessage('item-1', 'hello'));
    const second = adapter.mapEvent(agentMessage('item-1', 'hello world'));
    const completed = adapter.mapEvent({
      type: 'item.completed',
      item: { id: 'item-1', type: 'agent_message', text: 'hello world' },
    });

    expect(first).toEqual([{ kind: 'text_delta', text: 'hello' }]);
    expect(second).toEqual([{ kind: 'text_delta', text: ' world' }]);
    expect(completed).toEqual([]);
  });

  it('maps command execution as tool start and result', () => {
    const adapter = new CodexAdapter({ sessionId: 'thread-1' });

    const start = adapter.mapEvent({
      type: 'item.started',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: 'npm test',
        aggregated_output: '',
        status: 'in_progress',
      },
    });
    const done = adapter.mapEvent({
      type: 'item.completed',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: 'npm test',
        aggregated_output: 'ok',
        exit_code: 0,
        status: 'completed',
      },
    });

    expect(start).toEqual([
      {
        kind: 'tool_start',
        id: 'cmd-1',
        name: 'Shell',
        input: { command: 'npm test' },
      },
    ]);
    expect(done).toEqual([
      {
        kind: 'tool_result',
        toolUseId: 'cmd-1',
        content: 'ok\nexit_code=0',
        isError: false,
      },
    ]);
  });

  it('maps failed turn into a query_result error', () => {
    const adapter = new CodexAdapter({ sessionId: 'thread-1' });

    expect(adapter.mapEvent({
      type: 'turn.failed',
      error: { message: 'boom' },
    })).toEqual([
      {
        kind: 'query_result',
        sessionId: 'thread-1',
        isError: true,
        usage: { inputTokens: 0, outputTokens: 0 },
        error: 'boom',
      },
    ]);
  });
});

function agentMessage(id: string, text: string): ThreadEvent {
  return {
    type: 'item.updated',
    item: { id, type: 'agent_message', text },
  };
}
