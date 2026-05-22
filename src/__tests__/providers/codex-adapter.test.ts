import { describe, expect, it } from 'vitest';
import type { ThreadEvent } from '@openai/codex-sdk';
import { CodexAdapter } from '../../providers/codex-adapter.js';

describe('CodexAdapter', () => {
  it('maps thread lifecycle and turn completion', () => {
    const adapter = new CodexAdapter({ model: 'gpt-5.5' });

    expect(adapter.mapEvent({ type: 'thread.started', thread_id: 'thread-1' })).toEqual([
      { kind: 'status', sessionId: 'thread-1', model: 'gpt-5.5' },
    ]);
    expect(adapter.mapEvent({ type: 'turn.started' })).toEqual([]);
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
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cachedInputTokens: 2,
          reasoningOutputTokens: 1,
        },
      },
    ]);
  });

  it('does not report provider name as a model when Codex SDK has no model metadata', () => {
    const adapter = new CodexAdapter();

    expect(adapter.mapEvent({ type: 'thread.started', thread_id: 'thread-1' })).toEqual([
      { kind: 'status', sessionId: 'thread-1' },
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
        name: 'Bash',
        input: { command: 'npm test' },
      },
    ]);
    expect(done).toEqual([
      {
        kind: 'tool_result',
        toolUseId: 'cmd-1',
        content: 'ok\nexit_code=0',
        isError: false,
        isFinal: true,
      },
    ]);
  });

  it('streams command output updates before command completion', () => {
    const adapter = new CodexAdapter({ sessionId: 'thread-1' });

    const first = adapter.mapEvent({
      type: 'item.updated',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: 'npm test',
        aggregated_output: 'running test 1',
        status: 'in_progress',
      },
    });
    const second = adapter.mapEvent({
      type: 'item.updated',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: 'npm test',
        aggregated_output: 'running test 1\nrunning test 2',
        status: 'in_progress',
      },
    });
    const duplicate = adapter.mapEvent({
      type: 'item.updated',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: 'npm test',
        aggregated_output: 'running test 1\nrunning test 2',
        status: 'in_progress',
      },
    });

    expect(first).toEqual([
      {
        kind: 'tool_start',
        id: 'cmd-1',
        name: 'Bash',
        input: { command: 'npm test' },
      },
      {
        kind: 'tool_result',
        toolUseId: 'cmd-1',
        content: 'running test 1',
        isError: false,
        isFinal: false,
      },
    ]);
    expect(second).toEqual([
      {
        kind: 'tool_result',
        toolUseId: 'cmd-1',
        content: 'running test 1\nrunning test 2',
        isError: false,
        isFinal: false,
      },
    ]);
    expect(duplicate).toEqual([]);
  });

  it('keeps command final result final after streamed output updates', () => {
    const adapter = new CodexAdapter({ sessionId: 'thread-1' });

    adapter.mapEvent({
      type: 'item.updated',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: 'npm test',
        aggregated_output: 'ok',
        status: 'in_progress',
      },
    });

    expect(adapter.mapEvent({
      type: 'item.completed',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: 'npm test',
        aggregated_output: 'ok',
        exit_code: 0,
        status: 'completed',
      },
    })).toEqual([
      {
        kind: 'tool_result',
        toolUseId: 'cmd-1',
        content: 'ok\nexit_code=0',
        isError: false,
        isFinal: true,
      },
    ]);
  });

  it('formats file changes and MCP text results for Feishu-friendly previews', () => {
    const adapter = new CodexAdapter({ sessionId: 'thread-1' });

    expect(adapter.mapEvent({
      type: 'item.started',
      item: {
        id: 'patch-1',
        type: 'file_change',
        changes: [
          { kind: 'update', path: 'src/a.ts' },
          { kind: 'add', path: 'src/b.ts' },
        ],
        status: 'completed',
      },
    })).toEqual([
      {
        kind: 'tool_start',
        id: 'patch-1',
        name: 'ApplyPatch',
        input: {
          path: 'src/a.ts, src/b.ts',
          changes: [
            { kind: 'update', path: 'src/a.ts' },
            { kind: 'add', path: 'src/b.ts' },
          ],
        },
      },
    ]);

    expect(adapter.mapEvent({
      type: 'item.completed',
      item: {
        id: 'mcp-1',
        type: 'mcp_tool_call',
        server: 'repo',
        tool: 'lookup',
        arguments: { q: 'test' },
        result: {
          content: [{ type: 'text', text: 'lookup result' }],
          structured_content: { ignored: true },
        },
        status: 'completed',
      },
    })).toEqual([
      {
        kind: 'tool_start',
        id: 'mcp-1',
        name: 'repo.lookup',
        input: { q: 'test' },
      },
      {
        kind: 'tool_result',
        toolUseId: 'mcp-1',
        content: 'lookup result',
        isError: false,
        isFinal: true,
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
