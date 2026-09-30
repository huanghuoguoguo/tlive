import { describe, expect, it } from 'vitest';
import { CodexAppServerAdapter } from '../../client/providers/codex-app-server-adapter.js';
import { FeishuFormatter } from '../../server/channels/feishu/formatter.js';

// ErrorNotification.willRetry and the warning fields are from the local Codex CLI's
// `app-server generate-json-schema`, not inferred from the error message.
describe('Codex app-server recoverable notifications', () => {
  it('shows retrying errors without turning them into terminal failures', () => {
    const adapter = new CodexAppServerAdapter({ sessionId: 'thread-1' });
    const notification = {
      method: 'error',
      params: { error: { message: 'stream disconnected' }, willRetry: true },
    };
    expect(adapter.mapNotification(notification)).toEqual([
      { kind: 'api_retry', attempt: 1, maxRetries: 0, retryDelayMs: 0, error: 'stream disconnected' },
    ]);
    expect(adapter.mapNotification(notification)[0]).toMatchObject({ kind: 'api_retry', attempt: 2 });
    expect(adapter.mapNotification({ method: 'item/agentMessage/delta',
      params: { itemId: 'item-1', delta: 'recovered' } })).toEqual([
      { kind: 'text_delta', text: 'recovered' },
    ]);
    expect(adapter.mapNotification({ method: 'turn/completed',
      params: { turn: { status: 'completed' } } })[0]).toMatchObject({
      kind: 'query_result', isError: false,
    });
  });

  it('keeps non-retrying errors terminal', () => {
    const adapter = new CodexAppServerAdapter();
    expect(adapter.mapNotification({ method: 'error',
      params: { error: { message: 'fatal' }, willRetry: false } })).toEqual([
      { kind: 'error', message: 'fatal' },
    ]);
  });

  it('keeps warnings visible but advisory', () => {
    const adapter = new CodexAppServerAdapter();
    expect(adapter.mapNotification({ method: 'warning', params: { message: 'model mismatch' } }))
      .toEqual([{ kind: 'warning', message: 'model mismatch' }]);
    expect(adapter.mapNotification({ method: 'configWarning', params: { summary: 'bad setting' } }))
      .toEqual([{ kind: 'warning', message: 'bad setting' }]);
  });

  it('does not invent a retry limit when the app-server omits it', () => {
    const formatter = new FeishuFormatter('zh');
    const message = formatter.formatProgress('chat', {
      phase: 'executing', taskSummary: 'task', elapsedSeconds: 1,
      renderedText: '', todoItems: [], totalTools: 0,
      apiRetry: { attempt: 2, maxRetries: 0, retryDelayMs: 0 },
    });
    const card = JSON.stringify(message);
    expect(card).toContain('(2)');
    expect(card).not.toContain('2/0');
  });
});
