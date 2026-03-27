import { describe, it, expect } from 'vitest';
import { CodexAdapter } from '../messages/codex-adapter.js';

describe('CodexAdapter', () => {
  function create() { return new CodexAdapter(); }

  describe('thread events', () => {
    it('maps thread.started to status', () => {
      const a = create();
      const events = a.adapt({ type: 'thread.started', thread_id: 'th_1', model: 'o3' });
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('status');
      expect((events[0] as any).sessionId).toBe('th_1');
    });

    it('maps turn.started to empty', () => {
      expect(create().adapt({ type: 'turn.started' })).toHaveLength(0);
    });
  });

  describe('agent_message', () => {
    it('emits text_delta on item.updated', () => {
      const a = create();
      a.adapt({ type: 'item.started', item: { type: 'agent_message', id: 'msg_1' } });
      const events = a.adapt({ type: 'item.updated', item: { type: 'agent_message', id: 'msg_1', text: 'Hello' } });
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('text_delta');
      expect((events[0] as any).text).toBe('Hello');
    });

    it('emits delta (not full text) on subsequent updates', () => {
      const a = create();
      a.adapt({ type: 'item.started', item: { type: 'agent_message', id: 'msg_1' } });
      a.adapt({ type: 'item.updated', item: { type: 'agent_message', id: 'msg_1', text: 'Hello' } });
      const events = a.adapt({ type: 'item.updated', item: { type: 'agent_message', id: 'msg_1', text: 'Hello world' } });
      expect(events).toHaveLength(1);
      expect((events[0] as any).text).toBe(' world');
    });

    it('emits full text on completed if no updates were received', () => {
      const a = create();
      a.adapt({ type: 'item.started', item: { type: 'agent_message', id: 'msg_1' } });
      const events = a.adapt({ type: 'item.completed', item: { type: 'agent_message', id: 'msg_1', text: 'Final answer' } });
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('text_delta');
      expect((events[0] as any).text).toBe('Final answer');
    });
  });

  describe('command_execution', () => {
    it('maps item.started to tool_start (Bash)', () => {
      const a = create();
      const events = a.adapt({ type: 'item.started', item: { type: 'command_execution', id: 'cmd_1', command: ['npm', 'test'] } });
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('tool_start');
      expect((events[0] as any).name).toBe('Bash');
      expect((events[0] as any).input.command).toBe('npm test');
    });

    it('handles string command', () => {
      const a = create();
      const events = a.adapt({ type: 'item.started', item: { type: 'command_execution', id: 'cmd_1', command: 'ls -la' } });
      expect((events[0] as any).input.command).toBe('ls -la');
    });

    it('maps item.completed to tool_result', () => {
      const a = create();
      a.adapt({ type: 'item.started', item: { type: 'command_execution', id: 'cmd_1', command: ['ls'] } });
      const events = a.adapt({ type: 'item.completed', item: { type: 'command_execution', id: 'cmd_1', output: 'file1\nfile2', exit_code: 0 } });
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('tool_result');
      expect((events[0] as any).content).toBe('file1\nfile2');
      expect((events[0] as any).isError).toBe(false);
    });

    it('marks failed commands as errors', () => {
      const a = create();
      a.adapt({ type: 'item.started', item: { type: 'command_execution', id: 'cmd_1', command: ['bad'] } });
      const events = a.adapt({ type: 'item.completed', item: { type: 'command_execution', id: 'cmd_1', output: 'not found', exit_code: 127 } });
      expect((events[0] as any).isError).toBe(true);
    });

    it('links tool_result back to tool_start via toolUseId', () => {
      const a = create();
      const startEvents = a.adapt({ type: 'item.started', item: { type: 'command_execution', id: 'cmd_1', command: ['echo', 'hi'] } });
      const toolId = (startEvents[0] as any).id;
      const endEvents = a.adapt({ type: 'item.completed', item: { type: 'command_execution', id: 'cmd_1', output: 'hi', exit_code: 0 } });
      expect((endEvents[0] as any).toolUseId).toBe(toolId);
    });
  });

  describe('file_change', () => {
    it('maps add to Write tool_start', () => {
      const a = create();
      const events = a.adapt({ type: 'item.started', item: { type: 'file_change', id: 'fc_1', kind: 'add', path: '/src/new.ts' } });
      expect(events[0].kind).toBe('tool_start');
      expect((events[0] as any).name).toBe('Write');
      expect((events[0] as any).input.file_path).toBe('/src/new.ts');
    });

    it('maps update to Edit tool_start', () => {
      const a = create();
      const events = a.adapt({ type: 'item.started', item: { type: 'file_change', id: 'fc_1', kind: 'update', path: '/src/old.ts' } });
      expect((events[0] as any).name).toBe('Edit');
    });

    it('maps completed file_change to tool_result', () => {
      const a = create();
      a.adapt({ type: 'item.started', item: { type: 'file_change', id: 'fc_1', kind: 'add', path: '/src/new.ts' } });
      const events = a.adapt({ type: 'item.completed', item: { type: 'file_change', id: 'fc_1', status: 'completed' } });
      expect(events[0].kind).toBe('tool_result');
      expect((events[0] as any).content).toBe('Applied');
      expect((events[0] as any).isError).toBe(false);
    });

    it('marks failed file_change as error', () => {
      const a = create();
      a.adapt({ type: 'item.started', item: { type: 'file_change', id: 'fc_1', kind: 'update', path: '/src/old.ts' } });
      const events = a.adapt({ type: 'item.completed', item: { type: 'file_change', id: 'fc_1', status: 'failed' } });
      expect((events[0] as any).isError).toBe(true);
    });
  });

  describe('reasoning', () => {
    it('maps reasoning update to thinking_delta', () => {
      const a = create();
      a.adapt({ type: 'item.started', item: { type: 'reasoning', id: 'r_1' } });
      const events = a.adapt({ type: 'item.updated', item: { type: 'reasoning', id: 'r_1', summary: 'Analyzing code...' } });
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('thinking_delta');
      expect((events[0] as any).text).toBe('Analyzing code...');
    });

    it('skips reasoning item.started (no output)', () => {
      const events = create().adapt({ type: 'item.started', item: { type: 'reasoning', id: 'r_1' } });
      expect(events).toHaveLength(0);
    });
  });

  describe('mcp_tool_call', () => {
    it('maps item.started to tool_start', () => {
      const a = create();
      const events = a.adapt({ type: 'item.started', item: { type: 'mcp_tool_call', id: 'mcp_1', tool: 'search', arguments: { q: 'test' } } });
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('tool_start');
      expect((events[0] as any).name).toBe('search');
      expect((events[0] as any).input).toEqual({ q: 'test' });
    });

    it('maps item.completed to tool_result', () => {
      const a = create();
      a.adapt({ type: 'item.started', item: { type: 'mcp_tool_call', id: 'mcp_1', tool: 'search', arguments: {} } });
      const events = a.adapt({ type: 'item.completed', item: { type: 'mcp_tool_call', id: 'mcp_1', result: { data: 'found' } } });
      expect(events[0].kind).toBe('tool_result');
      expect((events[0] as any).content).toBe('{"data":"found"}');
    });

    it('handles string result', () => {
      const a = create();
      a.adapt({ type: 'item.started', item: { type: 'mcp_tool_call', id: 'mcp_1', tool: 'echo', arguments: {} } });
      const events = a.adapt({ type: 'item.completed', item: { type: 'mcp_tool_call', id: 'mcp_1', result: 'hello' } });
      expect((events[0] as any).content).toBe('hello');
    });
  });

  describe('turn lifecycle', () => {
    it('maps turn.completed to query_result', () => {
      const a = create();
      const events = a.adapt({ type: 'turn.completed', thread_id: 'th_1', usage: { input_tokens: 500, output_tokens: 200 } });
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('query_result');
      expect((events[0] as any).usage.inputTokens).toBe(500);
      expect((events[0] as any).usage.outputTokens).toBe(200);
    });

    it('maps turn.completed with costUsd', () => {
      const a = create();
      const events = a.adapt({ type: 'turn.completed', thread_id: 'th_1', usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.01 } });
      expect((events[0] as any).usage.costUsd).toBe(0.01);
    });

    it('maps turn.failed to error', () => {
      const a = create();
      const events = a.adapt({ type: 'turn.failed', error: { message: 'Rate limited' } });
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('error');
      expect((events[0] as any).message).toBe('Rate limited');
    });
  });

  describe('error event', () => {
    it('maps top-level error to error event', () => {
      const events = create().adapt({ type: 'error', message: 'Connection lost' });
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('error');
      expect((events[0] as any).message).toBe('Connection lost');
    });

    it('uses default message when none provided', () => {
      const events = create().adapt({ type: 'error' });
      expect((events[0] as any).message).toBe('Unknown Codex error');
    });
  });

  describe('unknown events', () => {
    it('returns empty for unknown types', () => {
      expect(create().adapt({ type: 'unknown_future' })).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('handles missing item gracefully', () => {
      expect(create().adapt({ type: 'item.started' })).toHaveLength(0);
      expect(create().adapt({ type: 'item.updated' })).toHaveLength(0);
      expect(create().adapt({ type: 'item.completed' })).toHaveLength(0);
    });

    it('handles empty text update (no delta)', () => {
      const a = create();
      a.adapt({ type: 'item.started', item: { type: 'agent_message', id: 'msg_1' } });
      const events = a.adapt({ type: 'item.updated', item: { type: 'agent_message', id: 'msg_1', text: '' } });
      expect(events).toHaveLength(0);
    });
  });
});
