import { describe, expect, it } from 'vitest';
import { canonicalEventSchema, type CanonicalEvent } from '../../canonical/schema.js';

describe('message-schema', () => {
  it('accepts every canonical event kind used at the provider boundary', () => {
    const validEvents: Array<{ kind: CanonicalEvent['kind']; event: unknown }> = [
      { kind: 'text_delta', event: { kind: 'text_delta', text: 'hello' } },
      { kind: 'thinking_delta', event: { kind: 'thinking_delta', text: 'reasoning...' } },
      { kind: 'tool_start', event: { kind: 'tool_start', id: 'tu_1', name: 'Bash', input: { command: 'ls' } } },
      { kind: 'tool_result', event: { kind: 'tool_result', toolUseId: 'tu_1', content: 'output', isError: false } },
      { kind: 'tool_progress', event: { kind: 'tool_progress', toolName: 'Bash', elapsed: 5.2 } },
      { kind: 'agent_start', event: { kind: 'agent_start', description: 'Explore codebase', taskId: 'task_1' } },
      { kind: 'agent_progress', event: { kind: 'agent_progress', description: 'Working...', lastTool: 'Read', usage: { toolUses: 5, durationMs: 3000 } } },
      { kind: 'agent_complete', event: { kind: 'agent_complete', summary: 'Done', status: 'completed' } },
      { kind: 'query_result', event: { kind: 'query_result', sessionId: 'sess_1', isError: false, usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.05 }, permissionDenials: [{ toolName: 'Bash', toolUseId: 'tu_1' }] } },
      { kind: 'error', event: { kind: 'error', message: 'fail' } },
      { kind: 'status', event: { kind: 'status', sessionId: 's' } },
      { kind: 'session_info', event: { kind: 'session_info', sessionId: 's', model: 'claude', tools: ['Read'] } },
      { kind: 'tool_use_summary', event: { kind: 'tool_use_summary', summary: 'Bash x1' } },
      { kind: 'api_retry', event: { kind: 'api_retry', attempt: 1, maxRetries: 3, retryDelayMs: 500, error: '429' } },
      { kind: 'compact_boundary', event: { kind: 'compact_boundary', trigger: 'auto', preTokens: 12000 } },
      { kind: 'prompt_suggestion', event: { kind: 'prompt_suggestion', suggestion: 'Try this' } },
      { kind: 'rate_limit', event: { kind: 'rate_limit', status: 'rejected', utilization: 0.95 } },
      { kind: 'todo_update', event: { kind: 'todo_update', todos: [{ content: 'Ship it', status: 'completed' }] } },
    ];

    for (const { kind, event } of validEvents) {
      expect(canonicalEventSchema.parse(event).kind).toBe(kind);
    }
  });

  it('strips unknown fields at the canonical boundary', () => {
    const result = canonicalEventSchema.parse({ kind: 'text_delta', text: 'hi', futureField: 42 });
    expect((result as Record<string, unknown>).futureField).toBeUndefined();
  });

  it('rejects unknown kinds and missing required fields', () => {
    expect(() => canonicalEventSchema.parse({ kind: 'unknown' })).toThrow();
    expect(() => canonicalEventSchema.parse({ kind: 'text_delta' })).toThrow();
  });
});
