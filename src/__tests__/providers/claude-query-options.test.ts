import { describe, expect, it, vi } from 'vitest';
import { buildClaudeQueryOptions } from '../../client/providers/claude-query-options.js';

describe('buildClaudeQueryOptions', () => {
  it('builds shared Claude SDK options without hiding call-site policy', () => {
    const abort = new AbortController();
    const canUseTool = vi.fn();
    const options = buildClaudeQueryOptions({
      cwd: '/repo',
      model: 'claude-opus',
      resume: 'session-1',
      permissionMode: 'default',
      effort: 'high',
      settingSources: ['user'],
      appendSystemPrompt: 'extra prompt',
      cliPath: '/usr/bin/claude',
      stderr: vi.fn(),
      abortSignal: abort.signal,
      allowPermissions: ['Read(*)'],
      toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
      canUseTool,
    });

    expect(options).toMatchObject({
      cwd: '/repo',
      model: 'claude-opus',
      resume: 'session-1',
      permissionMode: 'default',
      effort: 'high',
      includePartialMessages: true,
      agentProgressSummaries: true,
      promptSuggestions: true,
      settingSources: ['user'],
      settings: {
        permissions: {
          allow: [
            'Read(*)',
            'mcp__tlive__tlive_send_file',
            'mcp__tlive__tlive_send_image',
            'mcp__tlive__tlive_status',
          ],
        },
      },
      mcpServers: {
        tlive: expect.objectContaining({
          type: 'http',
          url: 'http://127.0.0.1:8081/mcp',
        }),
      },
      toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'extra prompt' },
      pathToClaudeCodeExecutable: '/usr/bin/claude',
      canUseTool,
    });

    const forwardedAbortController = options.abortController as AbortController;
    expect(forwardedAbortController.signal.aborted).toBe(false);
    abort.abort('stop');
    expect(forwardedAbortController.signal.aborted).toBe(true);
  });
});
