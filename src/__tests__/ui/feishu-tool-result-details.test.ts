import type { Client } from '@larksuiteoapi/node-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeishuFormatter } from '../../server/channels/feishu/formatter.js';
import { buildFeishuCard } from '../../server/channels/feishu/card-builder.js';
import { planFeishuCards } from '../../server/channels/feishu/card-budget.js';
import { collectFlowItems } from '../../server/channels/feishu/flow-blocks.js';
import { FeishuToolDetails } from '../../server/channels/feishu/tool-details.js';
import { ToolDisplayRegistry, isOversizedToolResult } from '../../server/channels/feishu/tool-display.js';
import type { FeishuRenderedMessage } from '../../server/channels/feishu/types.js';
import type { ProgressData } from '../../shared/formatting/message-types.js';
import type { InboundMessage } from '../../server/channels/types.js';

const stores: FeishuToolDetails[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.dispose()); vi.restoreAllMocks(); });
function store(options: ConstructorParameters<typeof FeishuToolDetails>[0] = {}) {
  const details = new FeishuToolDetails({ cleanupIntervalMs: 0, ...options });
  stores.push(details);
  return details;
}
function progress(toolName = 'search', result = 'BEGIN' + '中文😀\r\n'.repeat(1200) + 'END', status: 'completed' | 'failed' | 'interrupted' = 'completed'): ProgressData {
  return {
    phase: status === 'completed' ? 'completed' : 'failed', turnId: 'turn',
    elapsedSeconds: 1, totalTools: 1, renderedText: '', taskSummary: 'test', todoItems: [],
    errorMessage: status === 'failed' ? result : status === 'interrupted' ? 'Interrupted' : undefined,
    timeline: [{ kind: 'tool', toolId: 'call', toolName, toolInput: 'plain input',
      inputData: { query: 'original query', nested: { keep: true } }, toolResult: result, status }],
  };
}
function nodes(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [value as Record<string, unknown>, ...Object.values(value).flatMap(nodes)];
}
function detailActions(message: FeishuRenderedMessage): string[] {
  return nodes(message.feishuElements).map(node => node.action).filter((value): value is string =>
    typeof value === 'string' && value.startsWith('flow_detail:open:'));
}
function bind(details: FeishuToolDetails, message: FeishuRenderedMessage) {
  details.bind({ ...message, threadId: 'thread', replyToMessageId: 'root', replyInThread: true,
    flowDetailUserId: 'owner' }, ['source']);
}
function inbound(callbackData: string, messageId = 'source'): InboundMessage {
  return { channelType: 'feishu', chatId: 'chat', threadId: 'thread', userId: 'owner', text: '',
    messageId, callbackData };
}

describe('oversized tool result display policy', () => {
  it.each([
    ['a'.repeat(10000), false], ['a'.repeat(10001), true],
    ['中'.repeat(3333) + 'a', false], ['中'.repeat(3334), true],
    ['😀'.repeat(2500), false], ['😀'.repeat(2501), true],
  ])('uses strictly > 10,000 UTF-8 bytes, not JS length (%#)', (result, oversized) => {
    expect(isOversizedToolResult(result)).toBe(oversized);
    const details = store();
    const message = new FeishuFormatter('zh', { toolDetails: details }).formatProgress('chat', progress('custom', result));
    expect(detailActions(message)).toHaveLength(oversized ? 1 : 0);
    expect(JSON.stringify(message).includes(result)).toBe(!oversized);
  });

  for (const child of [false, true]) {
    describe(child ? 'child cards' : 'main cards', () => {
      it.each(['search', 'Bash', 'write', 'Edit', 'custom'])('removes %s full output and retains an owner-scoped snapshot without changing source events', async toolName => {
        const details = store();
        const data = progress(toolName);
        if (child) data.subagent = { agentName: 'scout', task: 'task', parentToolUseId: 'parent', childId: 'child' };
        const before = structuredClone(data);
        const sourceItems = collectFlowItems(data);
        Object.freeze(data.timeline![0].inputData!.nested);
        Object.freeze(data.timeline![0].inputData);
        Object.freeze(data.timeline![0]); Object.freeze(data.timeline); Object.freeze(data);
        const message = new FeishuFormatter('zh', { toolDetails: details }).formatProgress('chat', data);
        const serialized = JSON.stringify(message);
        expect(serialized).not.toContain('BEGIN');
        expect(serialized).not.toContain('END');
        expect(serialized).toContain('查看详情');
        expect(data).toEqual(before);
        expect(collectFlowItems(data)).toEqual(sourceItems);
        expect(data.timeline![0]).not.toHaveProperty('detailId');
        expect(Buffer.byteLength(serialized)).toBeLessThan(5000);
        const card = buildFeishuCard({ header: message.feishuHeader as any, elements: message.feishuElements as any });
        expect(planFeishuCards(JSON.parse(card))).toHaveLength(1);
        if (child) {
          expect(message.feishuSingleCard).toBe(true);
          expect(message.feishuSubagentCard!.chunks.some(chunk => chunk.kind === 'tool' && chunk.elementIds.length > 1)).toBe(true);
        }
        const action = detailActions(message)[0];
        bind(details, message);
        const reply = vi.fn(async () => ({ code: 0, data: { message_id: 'detail', thread_id: 'thread' } }));
        const client = { im: { message: { reply, create: vi.fn() } } } as unknown as Client;
        expect(await details.handle(inbound(action), client, true)).toMatchObject({ toast: { type: 'success' } });
        expect(reply).toHaveBeenCalledOnce();
      });

      it.each(['failed', 'interrupted'] as const)('keeps %s visible but not a giant errorMessage alias', status => {
        const details = store(); const data = progress('search', undefined, status);
        if (child) data.subagent = { agentName: 'scout', task: 'task', parentToolUseId: 'parent', childId: 'child' };
        const message = new FeishuFormatter('zh', { toolDetails: details }).formatProgress('chat', data);
        expect(detailActions(message)).toHaveLength(1);
        expect(JSON.stringify(message)).toContain(status === 'failed' ? '失败' : '已中断');
        expect(JSON.stringify(message)).not.toContain('BEGIN');
        expect(data.timeline![0].toolResult).toContain('BEGIN');
        if (status === 'failed') expect(data.errorMessage).toBe(data.timeline![0].toolResult);
      });
    });
  }

  it('registers after split start/result events are merged and also supports toolLogs-only payloads', () => {
    const details = store(); const formatter = new FeishuFormatter('zh', { toolDetails: details });
    const data = progress(); const original = data.timeline![0];
    data.timeline = [{ ...original, toolResult: undefined, status: 'running' },
      { kind: 'tool', toolId: original.toolId, toolResult: original.toolResult, status: 'completed' }];
    expect(detailActions(formatter.formatProgress('chat', data))).toHaveLength(1);
    const legacy = { ...data, timeline: undefined, toolLogs: [{ name: 'search', input: 'plain input',
      toolId: 'legacy-call', result: original.toolResult, status: 'completed' as const }] };
    expect(detailActions(formatter.formatProgress('chat', legacy))).toHaveLength(1);
  });

  it.each(['no store', 'byte budget', 'disposed', 'exception'] as const)('falls back to full redacted inline results for every category on %s', failure => {
    const details = store(failure === 'byte budget' ? { maxBytes: 1024 } : {});
    if (failure === 'disposed') details.dispose();
    if (failure === 'exception') vi.spyOn(details, 'register').mockImplementation(() => { throw new Error('cache failure'); });
    const formatter = new FeishuFormatter('zh', { toolDetails: failure === 'no store' ? undefined : details });
    const secret = 'sk-proj-' + 'A'.repeat(80);
    const result = 'BEGIN' + 'x'.repeat(10001) + secret + ' END';
    for (const name of ['search', 'Bash', 'Edit', 'custom']) {
      const data = progress(name, result);
      // A stale model/legacy entry point must never suppress the result on failed registration.
      data.timeline![0].detailId = '11111111-1111-4111-8111-111111111111';
      const message = formatter.formatProgress('chat', data);
      expect(detailActions(message)).toHaveLength(0);
      expect(JSON.stringify(message)).toContain(result.replace(secret, 'sk-proj-[REDACTED]'));
      expect(JSON.stringify(message)).not.toContain(secret);
      expect(data.timeline![0].toolResult).toBe(result);
    }
  });

  it('falls back for a second huge result without evicting the first still-reachable snapshot', async () => {
    const details = store({ maxEntries: 1 }); const data = progress();
    const second = 'SECOND_BEGIN' + 'y'.repeat(10001) + 'SECOND_END';
    data.timeline!.push({ ...data.timeline![0], toolId: 'second', toolResult: second });
    const message = new FeishuFormatter('zh', { toolDetails: details }).formatProgress('chat', data);
    expect(detailActions(message)).toHaveLength(1);
    expect(JSON.stringify(message)).toContain(second);
    expect(JSON.stringify(message)).not.toContain(data.timeline![0].toolResult!);
    bind(details, message);
    const reply = vi.fn(async () => ({ code: 0, data: { message_id: 'detail', thread_id: 'thread' } }));
    expect(await details.handle(inbound(detailActions(message)[0]), { im: { message: { reply } } } as unknown as Client, true))
      .toMatchObject({ toast: { type: 'success' } });
  });

  it('does not return a dead button when TTL expires during a pending callback; source stays available for refresh', async () => {
    let now = 0; const details = store({ ttlMs: 10, now: () => now }); const data = progress();
    const formatter = new FeishuFormatter('zh', { toolDetails: details });
    const message = formatter.formatProgress('chat', data); bind(details, message);
    let release!: () => void;
    const reply = vi.fn(async () => { await new Promise<void>(done => { release = done; });
      return { code: 0, data: { message_id: 'detail', thread_id: 'thread' } }; });
    const opening = details.handle(inbound(detailActions(message)[0]), { im: { message: { reply } } } as unknown as Client, true);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce());
    now = 10;
    const expired = formatter.formatProgress('chat', data);
    expect(detailActions(expired)).toHaveLength(0);
    expect(JSON.stringify(expired)).toContain('BEGIN');
    expect(JSON.stringify(expired)).toContain('END');
    release(); await opening;
    const refreshed = formatter.formatProgress('chat', data);
    expect(detailActions(refreshed)).toHaveLength(1);
    expect(detailActions(refreshed)).not.toEqual(detailActions(message));
    expect(data.timeline![0].toolResult).toContain('BEGIN');
  });

  it('applies the size rule outside custom renderers and plan suppression', () => {
    const details = store(); const custom = vi.fn(call => ({ elements: [{ tag: 'markdown', content: call.toolResult }] }));
    const registry = new ToolDisplayRegistry().register('custom', { category: 'generic', render: custom });
    const formatter = new FeishuFormatter('zh', { toolDetails: details, flowOptions: { registry } });
    const data = progress('custom');
    data.timeline![0].inputData = { todos: [{ content: 'task', status: 'pending' }] };
    const message = formatter.formatProgress('chat', data);
    expect(custom).not.toHaveBeenCalled();
    expect(detailActions(message)).toHaveLength(1);
    expect(JSON.stringify(message)).not.toContain('BEGIN');
    const fallback = new FeishuFormatter('zh', { flowOptions: { registry } }).formatProgress('chat', data);
    expect(JSON.stringify(fallback)).toContain('BEGIN');
    expect(JSON.stringify(fallback)).toContain('END');
  });

  it('keeps unscoped ID-less legacy calls inline rather than reusing a cross-turn synthetic identity', () => {
    const details = store(); const data = progress();
    data.turnId = undefined; data.timeline![0].toolId = undefined;
    const message = new FeishuFormatter('zh', { toolDetails: details }).formatProgress('chat', data);
    expect(detailActions(message)).toHaveLength(0);
    expect(JSON.stringify(message)).toContain('BEGIN');
    expect(JSON.stringify(message)).toContain('END');
  });

  it('keeps short exploration output omitted and short execution/error output unchanged', () => {
    for (const toolName of ['search', 'Bash', 'Edit', 'custom']) {
      for (const status of ['completed', 'failed'] as const) {
        const data = progress(toolName, 'short result', status);
        const withStore = new FeishuFormatter('zh', { toolDetails: store() }).formatProgress('chat', data);
        const without = new FeishuFormatter('zh').formatProgress('chat', data);
        expect(withStore).toEqual(without);
        expect(detailActions(withStore)).toHaveLength(0);
      }
    }
  });
});
