import type { Client } from '@larksuiteoapi/node-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseChannelAdapter } from '../../server/channels/base.js';
import { classifyDefaultError, FormatError, NetworkError, RateLimitError } from '../../server/channels/errors.js';
import { collectFlowItems, estimatedTokenCount } from '../../server/channels/feishu/flow-blocks.js';
import { FeishuFormatter } from '../../server/channels/feishu/formatter.js';
import { sendFeishuMessage } from '../../server/channels/feishu/sender.js';
import { FeishuToolDetails } from '../../server/channels/feishu/tool-details.js';
import type { InboundMessage, RenderedMessage, SendResult } from '../../server/channels/types.js';
import { SubagentFlowPresenter } from '../../server/presentation/subagent-presenter.js';
import type { SubagentSnapshot } from '../../shared/canonical/schema.js';
import type { FormattableMessage, ProgressData } from '../../shared/formatting/message-types.js';
import { FEISHU_SNAPSHOT_REFRESH_MS } from '../../shared/feishu-card-config.js';

const instances: Array<{ presenter: SubagentFlowPresenter; details: FeishuToolDetails }> = [];
const releases: Array<() => void> = [];
/** Child cards share the main card's cadence, so every tick here means one refresh interval. */
const REFRESH = FEISHU_SNAPSHOT_REFRESH_MS;

function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  releases.push(() => resolve(fallback));
  return { promise, resolve };
}

function snapshot(childId = 'child', overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
  return {
    kind: 'subagent_snapshot', parentToolUseId: 'agent-call', childId,
    agentName: 'same-name', task: `Task ${childId}`, status: 'running', timeline: [], ...overrides,
  };
}

function thinking(text: string): SubagentSnapshot['timeline'] {
  return [{ kind: 'thinking', blockId: 'thinking-1', text, status: 'running' }];
}

function fixture(options: {
  inbound?: Partial<InboundMessage>;
  parentTurnId?: string;
  onError?: (error: unknown) => void;
  nativeStreaming?: boolean;
} = {}) {
  const inbound: InboundMessage = {
    channelType: 'feishu', chatId: 'chat', scopeId: 'chat#thread:topic', threadId: 'topic',
    replyTargetMessageId: 'topic-root', replyInThread: true,
    messageId: 'main-message-id', userId: 'owner', text: 'Parent task', ...options.inbound,
  };
  const details = new FeishuToolDetails({ cleanupIntervalMs: 0 });
  const formatter = new FeishuFormatter('zh', {
    toolDetails: details, nativeStreaming: options.nativeStreaming,
  });
  const data: ProgressData[] = [];
  const requests: Array<{ at: number; kind: 'send' | 'edit'; messageId: string; message: RenderedMessage }> = [];
  const messages = new Map<string, RenderedMessage>();
  let next = 0;
  const adapter = {
    channelType: 'feishu', getLocale: () => 'zh' as const,
    classifyError: classifyDefaultError,
    shouldSplitCompletedTrace: vi.fn(() => true),
    format: vi.fn((message: FormattableMessage) => {
      if (message.type !== 'progress') throw new Error('Child tried to send a non-progress message');
      data.push(message.data);
      return formatter.format(message);
    }),
    send: vi.fn(async (message: RenderedMessage): Promise<SendResult> => {
      const messageId = `child-card-${++next}`;
      requests.push({ at: Date.now(), kind: 'send', messageId, message });
      messages.set(messageId, message);
      details.bind(message, [messageId]);
      return { messageId, success: true };
    }),
    editMessage: vi.fn(async (_chatId: string, messageId: string, message: RenderedMessage) => {
      requests.push({ at: Date.now(), kind: 'edit', messageId, message });
      messages.set(messageId, message);
      details.bind(message, [messageId]);
    }),
  };
  const onError = options.onError ?? vi.fn();
  const presenter = new SubagentFlowPresenter({
    adapter: adapter as unknown as BaseChannelAdapter, inbound,
    parentTurnId: options.parentTurnId ?? 'trusted-parent-turn',
    cwd: '/tmp/child-work', model: 'parent-model', onError,
  });
  instances.push({ presenter, details });
  return { presenter, adapter, inbound, requests, messages, data, onError, details };
}

function nodes(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value as Record<string, unknown>, ...Object.values(value).flatMap(nodes)];
}

/** A thought body is plain markdown now; strip a fence if a payload still arrives wrapped in one. */
const thoughtBody = (content: unknown): string =>
  /^(`{3,})\n([\s\S]*)\n\1$/u.exec(String(content))?.[2] ?? String(content);

/** A thought only asks for its detail panel once part of it has left the card. */
const LONG_THOUGHT = '完'.repeat(601);

function detailAction(message: RenderedMessage): string {
  const action = nodes(message).map((node) => node.action)
    .find((value) => typeof value === 'string' && value.startsWith('flow_detail:open:'));
  expect(action).toBeTypeOf('string');
  return action as string;
}

async function settle() { await vi.advanceTimersByTimeAsync(0); }

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(instances.map(({ presenter }) => presenter.dispose()));
  for (const { details } of instances.splice(0)) details.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SubagentFlowPresenter', () => {
  it('immediately starts 5 same-name children in parallel, keyed by parent tool and child ID', async () => {
    const f = fixture();
    const gate = deferred<SendResult>({ success: true, messageId: 'unused' });
    f.adapter.send.mockImplementation(async (message) => {
      const ordinal = f.adapter.send.mock.calls.length;
      await gate.promise;
      return { success: true, messageId: `independent-${ordinal}-${message.deliveryId}` };
    });
    const children = [snapshot('a'), snapshot('b'), snapshot('c'), snapshot('d'),
      snapshot('a', { parentToolUseId: 'another-call', status: 'queued' })];
    children.forEach((child) => f.presenter.update(child));
    expect(f.adapter.send).toHaveBeenCalledTimes(5);
    const deliveries = f.adapter.send.mock.calls.map(([message]) => message.deliveryId);
    expect(new Set(deliveries).size).toBe(5);
    expect(f.data.map((data) => data.subagent?.agentName)).toEqual(Array(5).fill('same-name'));
    expect(f.data[4].phase).toBe('starting');
    expect(f.data.every((data) => data.turnId?.startsWith('trusted-parent-turn:subagent:'))).toBe(true);
    children.forEach((child) => f.presenter.update({ ...child, status: 'completed' }));
    gate.resolve({ success: true, messageId: 'unused' });
    await vi.advanceTimersByTimeAsync(REFRESH);
    await f.presenter.finish();
    expect(f.adapter.send).toHaveBeenCalledTimes(5);
    expect(f.adapter.editMessage).toHaveBeenCalledTimes(5);
    expect(new Set(f.adapter.editMessage.mock.calls.map(([, id]) => id)).size).toBe(5);
    f.adapter.editMessage.mock.calls.forEach(([, id, message]) => {
      expect(id).toContain(message.deliveryId);
      expect(id).not.toBe('main-message-id');
    });
    expect(f.adapter.shouldSplitCompletedTrace).not.toHaveBeenCalled();
  });

  it('paces every physical child at the refresh interval from request start, including terminal patches', async () => {
    const f = fixture();
    for (let child = 0; child < 5; child++) f.presenter.update(snapshot(String(child)));
    await settle();
    for (let step = 1; step <= 3; step++) {
      await vi.advanceTimersByTimeAsync(100);
      for (let child = 0; child < 5; child++) {
        f.presenter.update(snapshot(String(child), { timeline: thinking(`step ${step}`) }));
      }
    }
    expect(f.requests).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(REFRESH - 301);
    expect(f.requests).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.requests).toHaveLength(10);
    expect(f.data.slice(5).every((data) => data.thinkingText === 'step 3')).toBe(true);
    for (let child = 0; child < 5; child++) f.presenter.update(snapshot(String(child), { status: 'completed' }));
    const finished = f.presenter.finish();
    await vi.advanceTimersByTimeAsync(REFRESH);
    await finished;
    for (const id of new Set(f.requests.map((request) => request.messageId))) {
      expect(f.requests.filter((request) => request.messageId === id).map((request) => request.at))
        .toEqual([0, REFRESH, REFRESH * 2]);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps only the newest snapshot behind slow send/edit, without slowing other children', async () => {
    const f = fixture();
    const sendGate = deferred<SendResult>({ success: true, messageId: 'slow-card' });
    const editGate = deferred<void>(undefined);
    const defaultSend = f.adapter.send.getMockImplementation()!;
    const defaultEdit = f.adapter.editMessage.getMockImplementation()!;
    f.adapter.send.mockImplementation((message) => message.deliveryId === f.data[0].turnId
      ? sendGate.promise : defaultSend(message));
    f.adapter.editMessage.mockImplementation((chatId, id, message) => id === 'slow-card'
      ? editGate.promise : defaultEdit(chatId, id, message));
    f.presenter.update(snapshot('slow'));
    f.presenter.update(snapshot('fast'));
    for (let step = 0; step < 10; step++) {
      f.presenter.update(snapshot('slow', { timeline: thinking(`send ${step}`) }));
    }
    f.presenter.update(snapshot('fast', { status: 'completed' }));
    await vi.advanceTimersByTimeAsync(REFRESH + 200);
    expect(f.adapter.send).toHaveBeenCalledTimes(2);
    expect(f.adapter.editMessage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    sendGate.resolve({ success: true, messageId: 'slow-card' });
    await settle();
    expect(f.data.at(-1)?.thinkingText).toBe('send 9');
    expect(f.adapter.editMessage).toHaveBeenCalledTimes(2);
    for (let step = 0; step < 10; step++) {
      f.presenter.update(snapshot('slow', { timeline: thinking(`edit ${step}`) }));
    }
    f.presenter.update(snapshot('slow', { status: 'completed', timeline: thinking('FINAL') }));
    f.presenter.update(snapshot('slow', { timeline: thinking('LATE RUNNING') }));
    await vi.advanceTimersByTimeAsync(REFRESH + 200);
    expect(f.adapter.editMessage).toHaveBeenCalledTimes(2);
    const finished = f.presenter.finish();
    editGate.resolve();
    await settle();
    await finished;
    expect(f.adapter.editMessage).toHaveBeenCalledTimes(3);
    expect(f.data.at(-1)).toMatchObject({ phase: 'completed', thinkingText: 'FINAL' });
    expect(f.adapter.send).toHaveBeenCalledTimes(2);
  });

  it('owns deeply frozen in-flight and pending snapshots, not mutable caller inputData', async () => {
    const f = fixture();
    const initial = snapshot('child', { timeline: [{
      kind: 'tool', blockId: 'block', toolId: 'call', toolName: 'Edit', toolInput: '/tmp/file',
      inputData: { nested: { value: 'original' } }, status: 'running',
    }] });
    f.presenter.update(initial);
    initial.timeline[0].inputData!.nested = { value: 'mutated' };
    initial.timeline[0].toolName = 'Bash';
    await settle();
    const pending = snapshot('child', { status: 'completed', timeline: [{
      ...initial.timeline[0], toolName: 'Edit', toolResult: 'ok', status: 'completed',
      inputData: { nested: { value: 'pending original' } },
    }] });
    f.presenter.update(pending);
    pending.timeline[0].toolResult = 'mutated result';
    pending.timeline[0].inputData!.nested = { value: 'mutated pending' };
    await vi.advanceTimersByTimeAsync(REFRESH);
    await f.presenter.finish();
    expect(f.data[0].timeline?.[0]).toMatchObject({ toolName: 'Edit', inputData: { nested: { value: 'original' } } });
    expect(f.data[1].timeline?.[0]).toMatchObject({ toolResult: 'ok', inputData: { nested: { value: 'pending original' } } });
    expect(Object.isFrozen(f.data[0].timeline?.[0].inputData?.nested)).toBe(true);
    expect(f.data[0].timeline?.[0].toolId).toBe(f.data[1].timeline?.[0].toolId);
    expect(f.data[0].timeline?.[0].blockId).toBe(f.data[1].timeline?.[0].blockId);
  });

  it('uses normal 300-token thinking previews/full details and complete tool classification', async () => {
    const f = fixture();
    const full = 'ORIGINAL_BEGIN' + '完整思考'.repeat(1200) + 'ORIGINAL_END';
    const names = ['Read', 'Bash', 'Edit', 'custom_tool'];
    f.presenter.update(snapshot('child', { timeline: [
      ...thinking(full),
      ...names.map((toolName, index) => ({
        kind: 'tool' as const, blockId: `tool-${index}`, toolId: `call-${index}`, toolName,
        toolInput: '/tmp/file', inputData: { file_path: '/tmp/file', old_string: 'before', new_string: 'after' },
        toolResult: 'success', status: 'completed' as const,
      })),
    ] }));
    await settle();
    expect(f.data[0]).toMatchObject({ thinkingText: full, renderedText: '', totalTools: 4 });
    const groups = collectFlowItems(f.data[0]).filter((block) => block.kind === 'tool');
    expect(groups.map((block) => block.category)).toEqual(['exploration', 'execution', 'editing', 'generic']);
    expect(f.data[0].toolLogs?.[2]).toMatchObject({
      name: 'Edit', input: '/tmp/file', inputData: { old_string: 'before', new_string: 'after' },
      result: 'success', status: 'completed',
    });
    const message = f.messages.get('child-card-1')!;
    expect(JSON.stringify(message)).not.toContain('ORIGINAL_BEGIN');
    const preview = nodes(message).find((node) => node.tag === 'markdown' && String(node.content).includes('ORIGINAL_END'))!;
    expect(estimatedTokenCount(thoughtBody(preview.content))).toBeLessThanOrEqual(300);
    expect(f.data[0].timeline?.every((entry) => entry.blockId?.startsWith(f.data[0].turnId!))).toBe(true);
    expect(f.data[0].toolLogs?.every((entry) => entry.toolId?.startsWith(f.data[0].turnId!))).toBe(true);
    const register = vi.spyOn(f.details, 'registerThinking');
    f.presenter.update(snapshot('child', { status: 'completed', timeline: thinking(full) }));
    await vi.advanceTimersByTimeAsync(REFRESH);
    await f.presenter.finish();
    expect(register).toHaveBeenCalledWith('chat', expect.objectContaining({ text: full }));
    expect(f.adapter.send).toHaveBeenCalledOnce();
  });

  it.each(['completed', 'failed'] as const)('routes a huge %s child search result to details, including the derived error alias', async status => {
    const f = fixture();
    const full = 'RESULT_BEGIN' + '完整工具结果😀\n'.repeat(1200) + 'RESULT_END';
    const child = snapshot('search-child', { status, timeline: [{
      kind: 'tool', blockId: 'search-block', toolId: 'search-call', toolName: 'search',
      inputData: { query: 'complete query' }, toolInput: 'complete query', toolResult: full, status,
    }] });
    const before = structuredClone(child);
    f.presenter.update(child);
    await settle(); await f.presenter.finish();
    const message = f.messages.get('child-card-1')!;
    expect(JSON.stringify(message)).not.toContain('RESULT_BEGIN');
    expect(JSON.stringify(message)).not.toContain('RESULT_END');
    expect(JSON.stringify(message)).toContain('查看详情');
    expect(f.data[0].timeline?.[0].toolResult).toBe(full);
    expect(f.data[0].toolLogs?.[0].result).toBe(full);
    if (status === 'failed') {
      expect(f.data[0].errorMessage).toBe(full);
      expect(JSON.stringify(message)).toContain('失败');
    }
    expect(child).toEqual(before);
    const reply = vi.fn(async () => ({ code: 0, data: { message_id: 'search-detail', thread_id: 'topic' } }));
    const client = { im: { message: { reply, create: vi.fn() } } } as unknown as Client;
    const callback = { ...f.inbound, text: '', callbackData: detailAction(message), messageId: 'child-card-1' };
    expect(await f.details.handle({ ...callback, messageId: 'main-message-id' }, client, true))
      .toMatchObject({ toast: { type: 'error' } });
    expect(await f.details.handle(callback, client, true)).toMatchObject({ toast: { type: 'success' } });
    expect(reply).toHaveBeenCalledOnce();
  });

  it('never fabricates answer/timeline text for queued or thinking-only snapshots', async () => {
    const f = fixture();
    f.presenter.update(snapshot('child', { status: 'queued' }));
    expect(f.data[0]).toMatchObject({ renderedText: '', thinkingText: '', timeline: [], taskSummary: 'Task child' });
    await settle();
    f.presenter.update(snapshot('child', { timeline: thinking('real thought') }));
    await vi.advanceTimersByTimeAsync(REFRESH);
    expect(f.data[1].renderedText).toBe('');
    expect(f.data[1].timeline?.map((entry) => entry.kind)).toEqual(['thinking']);
  });

  it('preserves failed terminal status and error summary against late running/completed updates', async () => {
    const f = fixture();
    f.presenter.update(snapshot('child', { status: 'failed', error: 'Original failure', timeline: [{
      kind: 'tool', blockId: 'tool', toolId: 'call', toolName: 'Bash', status: 'failed', toolResult: 'tool failed',
    }] }));
    await settle();
    f.presenter.update(snapshot('child', { timeline: thinking('late') }));
    expect(f.data).toHaveLength(1);
    f.presenter.update(snapshot('child', { status: 'completed' }));
    await vi.advanceTimersByTimeAsync(REFRESH);
    await f.presenter.finish();
    expect(f.data.at(-1)).toMatchObject({ phase: 'failed', errorMessage: 'Original failure' });
    expect(JSON.stringify(f.messages.get('child-card-1'))).toContain('Original failure');
    expect(f.adapter.send).toHaveBeenCalledOnce();
  });

  it('retains failed tool result as an error summary when provider supplies no error string', async () => {
    const f = fixture();
    f.presenter.update(snapshot('child', { status: 'failed', timeline: [{
      kind: 'tool', blockId: 'tool', toolName: 'Bash', status: 'failed', toolResult: 'Exit 42',
    }] }));
    await settle();
    await f.presenter.finish();
    expect(f.data[0].errorMessage).toBe('Exit 42');
    expect(f.data[0].toolLogs?.[0].toolId).toContain(':tool:');
    expect(JSON.stringify(f.messages.get('child-card-1'))).toContain('Exit 42');
  });

  it.each([0, 5500])('honors rate-limit backoff (%sms) even when newer terminal content arrives', async retryAfterMs => {
    const f = fixture();
    f.adapter.send.mockRejectedValueOnce(new RateLimitError('fixture rate limit', retryAfterMs));
    f.presenter.update(snapshot('child'));
    await settle();
    f.presenter.update(snapshot('child', { status: 'completed', timeline: [{ kind: 'text', blockId: 'done', text: 'newest' }] }));
    const finished = f.presenter.finish();
    const delay = Math.max(2000, retryAfterMs);
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(f.adapter.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await finished;
    expect(f.adapter.send).toHaveBeenCalledTimes(2);
    expect(f.data.at(-1)?.renderedText).toBe('newest');
    expect(f.adapter.send.mock.calls[0][0].deliveryId).toBe(f.adapter.send.mock.calls[1][0].deliveryId);
  });

  it('retries unknown committed sends with the same delivery identity and platform UUID', async () => {
    const f = fixture();
    const remote = new Map<string, string>();
    const uuids: string[] = [];
    let lost = false;
    const reply = vi.fn(async (request: { data: { uuid: string; content: string } }) => {
      uuids.push(request.data.uuid);
      remote.set(request.data.uuid, request.data.content);
      if (!lost) { lost = true; throw new NetworkError('response lost after commit'); }
      return { code: 0, data: { message_id: 'committed-child', thread_id: 'topic' } };
    });
    const patch = vi.fn(async (request: { path: { message_id: string }; data: { content: string } }) => {
      expect(request.path.message_id).toBe('committed-child');
      remote.set(uuids[0], request.data.content);
      return { code: 0 };
    });
    const client = { im: { message: { reply, create: reply, patch } } } as unknown as Client;
    f.adapter.send.mockImplementation((message) => sendFeishuMessage(client, message, classifyDefaultError));
    f.presenter.update(snapshot('child'));
    await settle();
    expect(f.onError).toHaveBeenCalledOnce();
    f.presenter.update(snapshot('child', { status: 'completed', timeline: [{ kind: 'text', blockId: 'answer', text: 'final answer' }] }));
    const finished = f.presenter.finish();
    await vi.advanceTimersByTimeAsync(REFRESH);
    await finished;
    expect(f.adapter.send).toHaveBeenCalledTimes(2);
    expect(new Set(f.adapter.send.mock.calls.map(([message]) => message.deliveryId)).size).toBe(1);
    expect(new Set(uuids).size).toBe(1);
    expect(remote.size).toBe(1);
    expect([...remote.values()][0]).toContain('final answer');
    expect(f.data.at(-1)?.phase).toBe('completed');
    expect(f.adapter.editMessage).not.toHaveBeenCalled();
  });

  it('treats missing send acknowledgements as unknown and retries the latest state', async () => {
    const f = fixture();
    f.adapter.send.mockResolvedValueOnce({ messageId: '', success: false });
    f.presenter.update(snapshot('child'));
    await settle();
    f.presenter.update(snapshot('child', { status: 'completed' }));
    const finished = f.presenter.finish();
    await vi.advanceTimersByTimeAsync(REFRESH);
    await finished;
    expect(f.adapter.send).toHaveBeenCalledTimes(2);
    expect(f.adapter.send.mock.calls[0][0].deliveryId).toBe(f.adapter.send.mock.calls[1][0].deliveryId);
    expect(f.onError).toHaveBeenCalledWith(expect.objectContaining({ retryable: true }));
  });

  it('does not fallback-send on edit errors and exposes failures to logging/toast handlers and finish', async () => {
    const f = fixture();
    const failure = new FormatError('card edit failed');
    f.presenter.update(snapshot('child'));
    await settle();
    f.adapter.editMessage.mockRejectedValue(failure);
    f.presenter.update(snapshot('child', { status: 'completed' }));
    const finished = f.presenter.finish();
    const assertion = expect(finished).rejects.toMatchObject({ errors: [failure] });
    await vi.advanceTimersByTimeAsync(REFRESH);
    await assertion;
    expect(f.onError).toHaveBeenCalledWith(failure);
    expect(f.adapter.send).toHaveBeenCalledOnce();
    expect(f.adapter.editMessage).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds retryable failures instead of hanging finish indefinitely', async () => {
    const f = fixture();
    const failure = new NetworkError('offline');
    f.adapter.send.mockRejectedValue(failure);
    f.presenter.update(snapshot('child', { status: 'failed', error: 'provider failure' }));
    const finished = f.presenter.finish();
    const assertion = expect(finished).rejects.toMatchObject({ errors: [failure] });
    await vi.advanceTimersByTimeAsync(REFRESH * 3);
    await assertion;
    expect(f.adapter.send).toHaveBeenCalledTimes(3);
    expect(f.onError).toHaveBeenCalledTimes(3);
    expect(new Set(f.adapter.send.mock.calls.map(([message]) => message.deliveryId)).size).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports errors even if the notification handler throws', async () => {
    const failure = new FormatError('cannot format');
    const handlerFailure = new Error('toast failed');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture({ onError: () => { throw handlerFailure; } });
    f.adapter.format.mockImplementation(() => { throw failure; });
    f.presenter.update(snapshot('child', { status: 'completed' }));
    await settle();
    await expect(f.presenter.finish()).rejects.toMatchObject({ errors: [failure] });
    expect(warn).toHaveBeenCalledWith(expect.any(String), handlerFailure, failure);
    expect(f.adapter.send).not.toHaveBeenCalled();
  });

  it.each([false, true])('finish(%s) interrupts unfinished children, preserves terminal children and waits for flushes', async (interrupted) => {
    const f = fixture();
    f.presenter.update(snapshot('running', { timeline: [{ kind: 'tool', blockId: 'tool', toolName: 'Bash', status: 'running' }, ...thinking('working')] }));
    f.presenter.update(snapshot('queued', { status: 'queued' }));
    f.presenter.update(snapshot('completed', { status: 'completed' }));
    f.presenter.update(snapshot('failed', { status: 'failed', error: 'retained error' }));
    await settle();
    const finished = f.presenter.finish(interrupted);
    expect(f.presenter.finish(interrupted)).toBe(finished);
    let done = false;
    void finished.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(REFRESH - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await finished;
    expect(f.adapter.send).toHaveBeenCalledTimes(4);
    expect(f.adapter.editMessage).toHaveBeenCalledTimes(2);
    expect(f.data.slice(4).map((data) => data.errorMessage)).toEqual(['Interrupted', 'Interrupted']);
    expect(f.data[4].toolLogs?.[0].status).toBe('interrupted');
    expect(f.data[4].timeline?.[1].status).toBe('interrupted');
    expect(f.data[2].phase).toBe('completed');
    expect(f.data[3].errorMessage).toBe('retained error');
    f.presenter.update(snapshot('new'));
    expect(f.adapter.send).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses inbound reply routing/ACL when threadId is missing, and does not trust snapshot metadata', async () => {
    const f = fixture({ inbound: { threadId: undefined, replyInThread: undefined } });
    const child = Object.assign(snapshot('child', { status: 'completed', timeline: thinking(LONG_THOUGHT) }), {
      turnId: 'attacker-turn', userId: 'attacker', threadId: 'wrong-topic', flowDetailUserId: 'attacker',
    });
    f.presenter.update(child);
    await settle();
    await f.presenter.finish();
    const message = f.messages.get('child-card-1')!;
    expect(message).toMatchObject({ chatId: 'chat', threadId: 'topic', replyInThread: true,
      replyToMessageId: 'topic-root', flowDetailUserId: 'owner' });
    const action = detailAction(message);
    const reply = vi.fn(async () => ({ code: 0, data: { message_id: 'detail', thread_id: 'topic' } }));
    const client = { im: { message: { reply, create: reply, patch: vi.fn() } } } as unknown as Client;
    const inbound = { ...f.inbound, text: '', callbackData: action, messageId: 'child-card-1' };
    expect(await f.details.handle({ ...inbound, userId: 'attacker' }, client, true)).toMatchObject({ toast: { type: 'error' } });
    expect(await f.details.handle({ ...inbound, messageId: 'main-message-id' }, client, true)).toMatchObject({ toast: { type: 'error' } });
    expect(reply).not.toHaveBeenCalled();
    expect(await f.details.handle(inbound, client, true)).toMatchObject({ toast: { type: 'success' } });
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ path: { message_id: 'topic-root' }, data: expect.objectContaining({ reply_in_thread: true }) }));
    expect(f.data[0].turnId).not.toContain('attacker-turn');
  });

  it('namespaces identical child/tool/block IDs by trusted parent turns and keeps detail owners separate', async () => {
    const left = fixture({ parentTurnId: 'parent-one' });
    const right = fixture({ parentTurnId: 'parent-two', inbound: { userId: 'other-owner', threadId: 'other-topic' } });
    const child = snapshot('same', { status: 'completed', timeline: [...thinking('thought'), {
      kind: 'tool', blockId: 'tool', toolId: 'same-call', toolName: 'Edit', toolInput: '/tmp/file',
      inputData: { file_path: '/tmp/file', old_string: 'before', new_string: 'after' }, toolResult: 'ok', status: 'completed',
    }] });
    left.presenter.update(child); right.presenter.update(child);
    await settle();
    await Promise.all([left.presenter.finish(), right.presenter.finish()]);
    expect(left.data[0].turnId).not.toBe(right.data[0].turnId);
    expect(left.data[0].timeline?.[0].blockId).not.toBe(right.data[0].timeline?.[0].blockId);
    expect(left.data[0].toolLogs?.[0].toolId).not.toBe(right.data[0].toolLogs?.[0].toolId);
    expect(left.adapter.send.mock.calls[0][0].flowDetailUserId).toBe('owner');
    expect(right.adapter.send.mock.calls[0][0].flowDetailUserId).toBe('other-owner');
  });

  it('dispose clears timers/drops pending states and waits only for already-issued requests', async () => {
    const f = fixture();
    f.presenter.update(snapshot('one')); f.presenter.update(snapshot('two'));
    await settle();
    f.presenter.update(snapshot('one', { timeline: thinking('pending') }));
    f.presenter.update(snapshot('two', { timeline: thinking('pending') }));
    expect(vi.getTimerCount()).toBe(2);
    const disposed = f.presenter.dispose();
    expect(f.presenter.dispose()).toBe(disposed);
    await disposed;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(REFRESH * 2);
    f.presenter.update(snapshot('new'));
    await f.presenter.finish();
    expect(f.adapter.send).toHaveBeenCalledTimes(2);
    expect(f.adapter.editMessage).not.toHaveBeenCalled();
  });

  it('dispose during send waits for that request without retrying or flushing pending states', async () => {
    const f = fixture();
    const gate = deferred<SendResult>({ messageId: 'slow', success: true });
    f.adapter.send.mockReturnValue(gate.promise);
    f.presenter.update(snapshot('one')); f.presenter.update(snapshot('one', { status: 'completed' }));
    const disposed = f.presenter.dispose();
    let done = false;
    void disposed.then(() => { done = true; });
    await settle();
    expect(done).toBe(false);
    gate.resolve({ messageId: 'slow', success: true });
    await disposed;
    expect(f.adapter.send).toHaveBeenCalledOnce();
    expect(f.adapter.editMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
