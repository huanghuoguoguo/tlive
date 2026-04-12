import { describe, it, expect, beforeEach } from 'vitest';
import { ClaudeAdapter, type SDKMessage } from '../../messages/claude-adapter.js';

describe('ClaudeAdapter', () => {
  let adapter: ClaudeAdapter;

  beforeEach(() => {
    adapter = new ClaudeAdapter();
  });

  // ── 1. text_delta from stream_event ──

  describe('text_delta from stream_event', () => {
    it('emits text_delta for content_block_delta with text type', () => {
      // First set block type to text
      adapter.mapMessage({
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'text' } },
      });

      const events = adapter.mapMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'text_delta', text: 'hello' });
    });

    it('emits text_delta without explicit block start (defaults to text)', () => {
      const events = adapter.mapMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'text_delta', text: 'hi' });
    });
  });

  // ── 2. thinking_delta from thinking blocks ──

  describe('thinking_delta from thinking blocks', () => {
    it('emits thinking_delta when block type is thinking', () => {
      adapter.mapMessage({
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'thinking' } },
      });

      const events = adapter.mapMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'reasoning...' } },
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'thinking_delta', text: 'reasoning...' });
    });
  });

  // ── 3. tool_start from content_block_start ──

  describe('tool_start from content_block_start', () => {
    it('emits tool_start immediately when tool_use start already includes full input', () => {
      const events = adapter.mapMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'tu_123', name: 'Read', input: { file_path: 'src/main.ts' } },
        },
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'tool_start',
        id: 'tu_123',
        name: 'Read',
        input: { file_path: 'src/main.ts' },
      });
    });

    it('emits tool_start on content_block_stop after input_json_delta arrives', () => {
      adapter.mapMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tu_bash', name: 'Bash' },
        },
      });

      adapter.mapMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"command":"git status --short"}' },
        },
      });

      const events = adapter.mapMessage({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'tool_start',
        id: 'tu_bash',
        name: 'Bash',
        input: { command: 'git status --short' },
      });
    });
  });

  // ── 4. hidden tool filtering ──

  describe('hidden tool filtering', () => {
    const hiddenTools = [
      'ToolSearch', 'TodoRead', 'TodoWrite',
      'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop', 'TaskOutput',
    ];

    for (const toolName of hiddenTools) {
      it(`filters out ${toolName} from stream_event`, () => {
        const events = adapter.mapMessage({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: `hidden_${toolName}`, name: toolName, input: {} },
          },
        });

        expect(events).toHaveLength(0);
      });
    }

    it('filters hidden tools from assistant messages', () => {
      const events = adapter.mapMessage({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu_hidden', name: 'ToolSearch', input: {} },
            { type: 'tool_use', id: 'tu_visible', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'tool_start', name: 'Bash' });
    });
  });

  // ── 5. hidden tool result filtering ──

  describe('hidden tool result filtering', () => {
    it('filters tool_result for hidden tool_use_id', () => {
      // First register a hidden tool
      adapter.mapMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'hidden_001', name: 'ToolSearch', input: {} },
        },
      });

      // Now a tool_result for that hidden ID
      const events = adapter.mapMessage({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'hidden_001', content: 'result data' }],
        },
      });

      expect(events).toHaveLength(0);
    });

    it('does not filter tool_result for visible tools', () => {
      const events = adapter.mapMessage({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'visible_001', content: 'output' }],
        },
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'tool_result', toolUseId: 'visible_001' });
    });
  });

  // ── 6. assistant message fallback ──

  describe('assistant message fallback', () => {
    it('emits text_delta from assistant text block when not already streamed', () => {
      const events = adapter.mapMessage({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello world' }],
        },
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'text_delta', text: 'Hello world' });
    });

    it('emits tool_use blocks from assistant message', () => {
      const events = adapter.mapMessage({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Let me check' },
            { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      });

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ kind: 'text_delta', text: 'Let me check' });
      expect(events[1]).toMatchObject({ kind: 'tool_start', name: 'Bash', id: 'tu_1' });
    });

    it('deduplicates assistant tool_use when stream_event already emitted the same tool', () => {
      adapter.mapMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tu_same', name: 'Bash' },
        },
      });
      adapter.mapMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' },
        },
      });
      adapter.mapMessage({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      });

      const events = adapter.mapMessage({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tu_same', name: 'Bash', input: { command: 'pwd' } }],
        },
      });

      expect(events).toHaveLength(0);
    });
  });

  // ── 7. skipping duplicate text when already streamed ──

  describe('skipping duplicate text when already streamed', () => {
    it('skips assistant text if stream_event already emitted text', () => {
      // Simulate streaming text first
      adapter.mapMessage({
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'text' } },
      });
      adapter.mapMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'streamed' } },
      });

      // Now assistant message with same text should be skipped
      const events = adapter.mapMessage({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'streamed' }],
        },
      });

      expect(events).toHaveLength(0);
    });

    it('still emits tool_use from assistant even when text was streamed', () => {
      // Stream some text
      adapter.mapMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
      });

      const events = adapter.mapMessage({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'hi' },
            { type: 'tool_use', id: 'tu_2', name: 'Edit', input: {} },
          ],
        },
      });

      // Text skipped, but tool_use emitted
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'tool_start', name: 'Edit' });
    });
  });

  // ── 8. user message tool_result (snake_case → camelCase) ──

  describe('user message tool_result mapping', () => {
    it('maps snake_case SDK fields to camelCase', () => {
      const events = adapter.mapMessage({
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'tu_abc',
            content: 'file contents here',
            is_error: false,
          }],
        },
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'tool_result',
        toolUseId: 'tu_abc',
        content: 'file contents here',
        isError: false,
      });
    });

    it('handles non-string content by JSON stringifying', () => {
      const events = adapter.mapMessage({
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'tu_xyz',
            content: [{ type: 'text', text: 'output' }],
            is_error: false,
          }],
        },
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'tool_result',
        toolUseId: 'tu_xyz',
        content: JSON.stringify([{ type: 'text', text: 'output' }]),
        isError: false,
      });
    });

    it('defaults is_error to false when missing', () => {
      const events = adapter.mapMessage({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu_def', content: 'ok' }],
        },
      });

      expect(events[0]).toMatchObject({ isError: false });
    });
  });

  // ── 9. result → query_result and error ──

  describe('result mapping', () => {
    it('maps success result to query_result', () => {
      const events = adapter.mapMessage({
        type: 'result',
        subtype: 'success',
        session_id: 'sess_123',
        is_error: false,
        usage: { input_tokens: 100, output_tokens: 50 },
        total_cost_usd: 0.005,
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'query_result',
        sessionId: 'sess_123',
        isError: false,
        usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.005 },
      });
    });

    it('maps success result with permission denials', () => {
      const events = adapter.mapMessage({
        type: 'result',
        subtype: 'success',
        session_id: 'sess_456',
        is_error: false,
        usage: { input_tokens: 200, output_tokens: 80 },
        permission_denials: [
          { tool_name: 'Bash', tool_use_id: 'tu_denied' },
        ],
      });

      expect(events).toHaveLength(1);
      const ev = events[0] as Record<string, unknown>;
      expect(ev.kind).toBe('query_result');
      expect(ev.permissionDenials).toEqual([
        { toolName: 'Bash', toolUseId: 'tu_denied' },
      ]);
    });

    it('maps non-success result to error', () => {
      const events = adapter.mapMessage({
        type: 'result',
        subtype: 'error',
        session_id: 'sess_err',
        errors: ['Rate limit exceeded', 'Timeout'],
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'query_result',
        sessionId: 'sess_err',
        isError: true,
        error: 'Rate limit exceeded; Timeout',
      });
    });

    it('handles missing errors array', () => {
      const events = adapter.mapMessage({
        type: 'result',
        subtype: 'error',
        session_id: 'sess_err2',
      });

      expect(events[0]).toMatchObject({
        kind: 'query_result',
        sessionId: 'sess_err2',
        isError: true,
        error: 'Unknown error',
      });
    });

    it('maps interrupt result to query_result with Interrupted error', () => {
      const events = adapter.mapMessage({
        type: 'result',
        subtype: 'error_during_execution',
        session_id: 'sess_int',
        is_error: true,
        usage: { input_tokens: 500, output_tokens: 200 },
        total_cost_usd: 0.01,
        errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'],
      });

      // Single query_result event with error included (prevents double flush)
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'query_result',
        sessionId: 'sess_int',
        isError: true,
        error: 'Interrupted',
        usage: { inputTokens: 500, outputTokens: 200, costUsd: 0.01 },
      });
    });

    it('maps non-interrupt error_during_execution to query_result with error', () => {
      const events = adapter.mapMessage({
        type: 'result',
        subtype: 'error_during_execution',
        session_id: 'sess_err',
        is_error: true,
        usage: { input_tokens: 300, output_tokens: 100 },
        total_cost_usd: 0.008,
        errors: ['Process crashed unexpectedly'],
      });

      // Single query_result event with error included (prevents double flush)
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'query_result',
        sessionId: 'sess_err',
        isError: true,
        error: 'Process crashed unexpectedly',
        usage: { inputTokens: 300, outputTokens: 100, costUsd: 0.008 },
      });
    });
  });

  // ── 10. system → status, agent_start, agent_progress, agent_complete ──

  describe('system message mapping', () => {
    it('maps init to status', () => {
      const events = adapter.mapMessage({
        type: 'system',
        subtype: 'init',
        session_id: 'sess_init',
        model: 'claude-sonnet-4-20250514',
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'status',
        sessionId: 'sess_init',
        model: 'claude-sonnet-4-20250514',
      });
    });

    it('maps task_started to agent_start', () => {
      const events = adapter.mapMessage({
        type: 'system',
        subtype: 'task_started',
        description: 'Analyzing code',
        task_id: 'task_1',
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'agent_start',
        description: 'Analyzing code',
        taskId: 'task_1',
      });
    });

    it('maps task_progress to agent_progress with summary preferred', () => {
      const events = adapter.mapMessage({
        type: 'system',
        subtype: 'task_progress',
        summary: 'Found 3 files to edit',
        description: 'Static description',
        last_tool_name: 'Grep',
        usage: { tool_uses: 5, duration_ms: 12000 },
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'agent_progress',
        description: 'Found 3 files to edit', // summary preferred over description
        lastTool: 'Grep',
        usage: { toolUses: 5, durationMs: 12000 },
      });
    });

    it('maps task_progress falling back to description', () => {
      const events = adapter.mapMessage({
        type: 'system',
        subtype: 'task_progress',
        description: 'Processing...',
      });

      expect(events[0]).toMatchObject({
        kind: 'agent_progress',
        description: 'Processing...',
      });
    });

    it('maps task_notification to agent_complete', () => {
      const events = adapter.mapMessage({
        type: 'system',
        subtype: 'task_notification',
        summary: 'All files updated',
        status: 'completed',
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'agent_complete',
        summary: 'All files updated',
        status: 'completed',
      });
    });
  });

  // ── 11. tool_progress (>3s filter) ──

  describe('tool_progress filtering', () => {
    it('emits tool_progress when elapsed > 3s', () => {
      const events = adapter.mapMessage({
        type: 'tool_progress',
        tool_name: 'Bash',
        elapsed_time_seconds: 5,
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'tool_progress',
        toolName: 'Bash',
        elapsed: 5,
      });
    });

    it('filters tool_progress when elapsed <= 3s', () => {
      const events = adapter.mapMessage({
        type: 'tool_progress',
        tool_name: 'Bash',
        elapsed_time_seconds: 2,
      });

      expect(events).toHaveLength(0);
    });

    it('filters tool_progress when elapsed is exactly 3s', () => {
      const events = adapter.mapMessage({
        type: 'tool_progress',
        tool_name: 'Bash',
        elapsed_time_seconds: 3,
      });

      expect(events).toHaveLength(0);
    });
  });

  // ── 12. rate_limit ──

  describe('rate_limit mapping', () => {
    it('emits rate_limit for rejected status', () => {
      const events = adapter.mapMessage({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', utilization: 0.95, resetsAt: 1700000000 },
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'rate_limit',
        status: 'rejected',
        utilization: 0.95,
        resetsAt: 1700000000,
      });
    });

    it('emits rate_limit for allowed_warning status', () => {
      const events = adapter.mapMessage({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed_warning', utilization: 0.8 },
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'rate_limit', status: 'allowed_warning' });
    });

    it('filters out non-rejected/warning rate_limit events', () => {
      const events = adapter.mapMessage({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed' },
      });

      expect(events).toHaveLength(0);
    });
  });

  // ── 13. prompt_suggestion ──

  describe('prompt_suggestion mapping', () => {
    it('emits prompt_suggestion', () => {
      const events = adapter.mapMessage({
        type: 'prompt_suggestion',
        suggestion: 'Try asking about the API',
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'prompt_suggestion',
        suggestion: 'Try asking about the API',
      });
    });

    it('skips prompt_suggestion without suggestion text', () => {
      const events = adapter.mapMessage({
        type: 'prompt_suggestion',
      });

      expect(events).toHaveLength(0);
    });
  });

  // ── 14. parentToolUseId propagation ──

  describe('parentToolUseId propagation', () => {
    it('propagates parentToolUseId to text_delta', () => {
      const events = adapter.mapMessage({
        type: 'stream_event',
        parent_tool_use_id: 'parent_1',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'sub' } },
      });

      expect(events[0]).toMatchObject({
        kind: 'text_delta',
        parentToolUseId: 'parent_1',
      });
    });

    it('propagates parentToolUseId to tool_start', () => {
      const events = adapter.mapMessage({
        type: 'stream_event',
        parent_tool_use_id: 'parent_2',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'tu_sub', name: 'Read', input: { file_path: 'src/sub.ts' } },
        },
      });

      expect(events[0]).toMatchObject({
        kind: 'tool_start',
        parentToolUseId: 'parent_2',
      });
    });

    it('propagates parentToolUseId to agent_start', () => {
      const events = adapter.mapMessage({
        type: 'system',
        subtype: 'task_started',
        parent_tool_use_id: 'parent_3',
        description: 'Sub-task',
      });

      expect(events[0]).toMatchObject({
        kind: 'agent_start',
        parentToolUseId: 'parent_3',
      });
    });

    it('propagates parentToolUseId to tool_result', () => {
      const events = adapter.mapMessage({
        type: 'user',
        parent_tool_use_id: 'parent_4',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu_res', content: 'ok', is_error: false }],
        },
      });

      expect(events[0]).toMatchObject({
        kind: 'tool_result',
        parentToolUseId: 'parent_4',
      });
    });

    it('does not include parentToolUseId when not present', () => {
      const events = adapter.mapMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'no parent' } },
      });

      expect(events[0]).not.toHaveProperty('parentToolUseId');
    });
  });

  // ── 15. unknown message types ──

  describe('unknown message types', () => {
    it('returns empty array for unknown types', () => {
      const events = adapter.mapMessage({ type: 'some_unknown_type' });
      expect(events).toHaveLength(0);
    });
  });

  // ── reset ──

  describe('reset', () => {
    it('resets all state', () => {
      // Stream text to set hasStreamedText
      adapter.mapMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'first' } },
      });

      adapter.reset();

      // After reset, assistant text should not be skipped
      const events = adapter.mapMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'second' }] },
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'text_delta', text: 'second' });
    });
  });

  // ── Zod validation ──

  describe('Zod validation', () => {
    it('all emitted events pass Zod validation', () => {
      // This is implicitly tested by every other test since mapMessage
      // calls canonicalEventSchema.parse(), but let's be explicit
      const events = adapter.mapMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'valid' } },
      });

      expect(events).toHaveLength(1);
      // If Zod validation failed, mapMessage would have thrown
    });
  });
});
