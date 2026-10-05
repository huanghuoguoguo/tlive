import type { Client } from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import childProcess from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureFeishuCardBudget, measureFeishuCard } from '../../server/channels/feishu/card-budget.js';
import { feishuCardActionToInbound } from '../../server/channels/feishu/events.js';
import { feishuMessageEventToInbound } from '../../server/channels/feishu/inbound.js';
import { FeishuToolDetails, type FeishuToolDetailEntry, type FeishuToolDetailsOptions } from '../../server/channels/feishu/tool-details.js';
import type { FeishuRenderedMessage } from '../../server/channels/feishu/types.js';
import type { InboundMessage } from '../../server/channels/types.js';

interface Request {
  path?: { message_id?: string };
  data: { content: string; reply_in_thread?: boolean; root_id?: string };
}
interface Card {
  header: { template: string };
  body: { elements: Array<{ tag?: string; content?: string; text?: { content: string } }> };
}
const instances: FeishuToolDetails[] = [];
afterEach(() => {
  for (const details of instances.splice(0)) details.dispose();
});
function store(options: FeishuToolDetailsOptions = {}): FeishuToolDetails {
  const details = new FeishuToolDetails({ cleanupIntervalMs: 0, ...options });
  instances.push(details);
  return details;
}
function sdk() {
  let sequence = 0;
  const reply = vi.fn(async (_request: Request) => ({
    code: 0, data: { message_id: `detail-${++sequence}`, thread_id: 'thread' },
  }));
  const create = vi.fn(async (_request: Request) => ({ code: 0, data: { message_id: `created-${++sequence}` } }));
  const patch = vi.fn(async (_request: Request) => ({ code: 0 }));
  const del = vi.fn(async (_request: unknown) => ({ code: 0 }));
  const client = { im: { message: { reply, create, patch, delete: del } } } as unknown as Client;
  return { client, reply, create, patch, del };
}
function entry(overrides: Partial<FeishuToolDetailEntry> = {}): FeishuToolDetailEntry {
  return {
    kind: 'tool', toolId: 'call-1', toolName: 'write',
    inputData: { file_path: '/nonexistent/snapshot.txt', content: 'original' },
    toolResult: 'written', status: 'completed', ...overrides,
  };
}
function bind(details: FeishuToolDetails, id: string, overrides: Partial<FeishuRenderedMessage> = {}, sources = ['source']) {
  details.bind({
    chatId: 'chat', threadId: 'thread', replyToMessageId: 'root', replyInThread: true,
    flowDetailUserId: 'owner', feishuButtons: [{ label: '查看快照', callbackData: `flow_detail:open:${id}` }],
    ...overrides,
  }, sources);
}
function inbound(callbackData: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channelType: 'feishu', chatId: 'chat', threadId: 'thread', userId: 'owner',
    text: '', messageId: 'source', callbackData, ...overrides,
  };
}
function open(details: FeishuToolDetails, id: string, client: Client, overrides: Partial<InboundMessage> = {}) {
  return details.handle(inbound(`flow_detail:open:${id}`, overrides), client, true);
}
function action(details: FeishuToolDetails, id: string, verb: string, client: Client, messageId = 'detail-1') {
  return details.handle(inbound(`flow_detail:${verb}:${id}`, { messageId }), client, true);
}
function page(details: FeishuToolDetails, id: string, n: number, client: Client) {
  return details.handle(inbound(`flow_detail:page:${id}:${n}`, { messageId: 'detail-1' }), client, true);
}
function card(request: Request): Card { return JSON.parse(request.data.content) as Card; }
function body(request: Request): string {
  return card(request).body.elements.slice(1).map(element => {
    if (element.tag !== 'markdown') return element.text?.content ?? '';
    const content = element.content!;
    const opening = /^(`{3,})diff\n/.exec(content)!;
    const suffix = `\n${opening[1]}`;
    expect(content.endsWith(suffix)).toBe(true);
    // Strip only the generated framing, never trim original whitespace/boundaries.
    return content.slice(opening[0].length, -suffix.length);
  }).join('');
}
function responseType(response: Record<string, unknown> | undefined): string | undefined {
  return (response?.toast as { type?: string } | undefined)?.type;
}
async function allPages(details: FeishuToolDetails, id: string, mock: ReturnType<typeof sdk>) {
  expect(responseType(await open(details, id, mock.client))).toBe('success');
  const first = mock.reply.mock.calls[0][0];
  const heading = card(first).body.elements[0].text!.content;
  const total = Number(/^1 \/ (\d+)$/.exec(heading)![1]);
  const requests = [first];
  for (let n = 1; n < total; n++) {
    expect(responseType(await page(details, id, n, mock.client))).toBe('success');
    requests.push(mock.patch.mock.calls.at(-1)![0]);
  }
  return { requests, text: requests.map(body).join(''), total };
}

describe('FeishuToolDetails snapshot and scoped SDK integration', () => {
  it('authorizes only the bound owner/chat/thread/source and consumes invalid callbacks', async () => {
    const details = store();
    const mock = sdk();
    const id = details.register('chat', entry())!;
    bind(details, id);
    expect(responseType(await details.handle(inbound(`flow_detail:open:${id}`), mock.client, false))).toBe('error');
    for (const mismatch of [
      { userId: 'other' }, { chatId: 'other' }, { threadId: 'other' },
      { messageId: 'root' }, { messageId: 'unrelated' },
    ]) expect(responseType(await open(details, id, mock.client, mismatch))).toBe('error');
    expect(responseType(await details.handle(inbound('flow_detail:open:predictable-path'), mock.client, true))).toBe('error');
    expect(await details.handle(inbound('ordinary:callback'), mock.client, true)).toBeUndefined();
    expect(mock.reply).not.toHaveBeenCalled();
    expect(responseType(await open(details, id, mock.client))).toBe('success');
    expect(mock.reply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      path: { message_id: 'root' }, data: expect.objectContaining({ reply_in_thread: true }),
    }));
    expect(mock.create).not.toHaveBeenCalled();
    expect(responseType(await details.handle(inbound(`flow_detail:close:${id}`), mock.client, true))).toBe('error');
    expect(mock.del).not.toHaveBeenCalled();
  });

  it('does not let re-binding a known id transfer its ownership or route', async () => {
    const details = store(); const mock = sdk(); const id = details.register('chat', entry())!;
    bind(details, id);
    bind(details, id, { flowDetailUserId: 'attacker' }, ['attacker-source']);
    expect(responseType(await open(details, id, mock.client, { userId: 'attacker', messageId: 'attacker-source' }))).toBe('error');
    expect(responseType(await open(details, id, mock.client))).toBe('success');
  });

  it('uses the same user_id-first identity as actual inbound and card callbacks', async () => {
    const message = await feishuMessageEventToInbound({
      sender: { sender_id: { user_id: 'owner', open_id: 'ou-other' } },
      message: { chat_id: 'chat', message_id: 'request', message_type: 'text', chat_type: 'p2p',
        thread_id: 'thread', content: JSON.stringify({ text: 'hello' }) },
    }, {} as Parameters<typeof feishuMessageEventToInbound>[1]);
    expect(message?.userId).toBe('owner');
    const details = store(); const mock = sdk(); const id = details.register('chat', entry())!;
    bind(details, id, { flowDetailUserId: message!.userId });
    const callback = feishuCardActionToInbound({
      operator: { user_id: 'owner', open_id: 'ou-other' },
      context: { open_chat_id: 'chat', open_message_id: 'source', thread_id: 'thread' },
      action: { value: { action: `flow_detail:open:${id}` } },
    }).message!;
    expect(responseType(await details.handle(callback, mock.client, true))).toBe('success');
  });

  it('opens, pages and closes a topic snapshot with the official callback context lacking thread_id', async () => {
    const details = store({ pageBytes: 3000 });
    const mock = sdk();
    const id = details.register('chat', entry({ inputData: { path: '/x', content: 'x'.repeat(6000) } }))!;
    bind(details, id);
    const officialCallback = (verb: string, messageId: string) => feishuCardActionToInbound({
      operator: { user_id: 'owner', open_id: 'ou-owner' },
      context: { open_chat_id: 'chat', open_message_id: messageId },
      action: { value: { action: `flow_detail:${verb}:${id}` } },
    }).message!;
    const callback = officialCallback('open', 'source');
    expect(callback.threadId).toBeUndefined();
    expect(responseType(await details.handle(callback, mock.client, true))).toBe('success');
    expect(mock.reply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      path: { message_id: 'root' }, data: expect.objectContaining({ reply_in_thread: true }),
    }));
    const nextPage = officialCallback('page', 'detail-1');
    nextPage.callbackData = `flow_detail:page:${id}:1`;
    expect(responseType(await details.handle(nextPage, mock.client, true))).toBe('success');
    expect(mock.patch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      path: { message_id: 'detail-1' },
    }));
    expect(responseType(await details.handle(officialCallback('close', 'detail-1'), mock.client, true))).toBe('success');
    expect(mock.del).toHaveBeenCalledExactlyOnceWith({ path: { message_id: 'detail-1' } });
    expect(mock.create).not.toHaveBeenCalled();
  });

  it('still requires the exact owner/chat/source or detail message when callback thread_id is absent', async () => {
    const details = store(); const mock = sdk(); const id = details.register('chat', entry())!;
    bind(details, id);
    for (const mismatch of [
      { userId: 'other' }, { chatId: 'other' }, { messageId: 'root' },
      { messageId: 'unrelated' }, { messageId: '' },
    ]) {
      expect(responseType(await open(details, id, mock.client, { threadId: undefined, ...mismatch }))).toBe('error');
    }
    expect(responseType(await details.handle(inbound(`flow_detail:open:${id}`, { threadId: undefined }), mock.client, false))).toBe('error');
    expect(mock.reply).not.toHaveBeenCalled();
    expect(responseType(await open(details, id, mock.client))).toBe('success');
    for (const verb of ['close', `page:${id}:0`]) {
      const callbackData = verb === 'close' ? `flow_detail:close:${id}` : `flow_detail:${verb}`;
      for (const mismatch of [
        { userId: 'other', messageId: 'detail-1' }, { chatId: 'other', messageId: 'detail-1' },
        { messageId: 'source' }, { messageId: 'unrelated' }, { messageId: '' },
        { threadId: 'other', messageId: 'detail-1' },
      ]) {
        expect(responseType(await details.handle(inbound(callbackData, { threadId: undefined, ...mismatch }), mock.client, true))).toBe('error');
      }
    }
    expect(mock.del).not.toHaveBeenCalled();
    expect(mock.patch).not.toHaveBeenCalled();
  });

  it.each([
    ['write', { file_path: '/not/on/disk', content: 'original' }, '写入：'],
    ['replace', { path: '/not/on/disk', oldText: 'before', newText: 'after' }, '-before\n+after'],
    ['Edit', { file_path: '/not/on/disk', old_string: 'before', new_string: 'after' }, '-before\n+after'],
    ['MultiEdit', { file_path: '/not/on/disk', edits: [{ old_string: 'one', new_string: 'two' }, { old_string: 'three', new_string: 'four' }] }, '-three\n+four'],
  ])('freezes %s invocation input/result; never opens paths or executes tools', async (toolName, inputData, expected) => {
    const details = store(); const mock = sdk();
    const data = entry({ toolName, inputData, toolResult: { output: 'original-result' } });
    const id = details.register('chat', data)!;
    data.inputData = { file_path: '/not/on/disk', content: 'latest-file-content' };
    (data.toolResult as { output: string }).output = 'changed-result';
    bind(details, id);
    const result = await allPages(details, id, mock);
    expect(result.text).toContain(expected);
    expect(result.text).not.toContain('工具输入快照');
    expect(result.text).toContain('original-result');
    expect(result.text).not.toContain('latest-file-content');
    expect(result.text).not.toContain('changed-result');
    expect(result.text).not.toContain('--- /not/on/disk');
    expect(mock.create).not.toHaveBeenCalled();
  });

  it('shows line-prefixed changes without dumping the tool input snapshot', async () => {
    const details = store(); const mock = sdk();
    const id = details.register('chat', entry({ toolName: 'replace', inputData: {
      path: '/x', oldText: '旧第一行\n旧第二行', newText: '新第一行\n新第二行',
      privateMetadata: 'INPUT_METADATA_MUST_NOT_APPEAR',
    } }))!;
    bind(details, id);
    const result = await allPages(details, id, mock);
    expect(result.text).toContain('-旧第一行\n-旧第二行\n+新第一行\n+新第二行');
    expect(result.text).not.toContain('工具输入快照');
    expect(result.text).not.toContain('INPUT_METADATA_MUST_NOT_APPEAR');
    expect(result.text).not.toContain('"oldText"');
    expect(result.text).toContain('written');
  });

  it.each([
    [{ oldText: '', newText: '新增' }, '+新增', '-（'],
    [{ oldText: '删除', newText: '' }, '-删除', '+（'],
    [{ newText: '已知新内容' }, '+已知新内容', '未提供旧片段'],
    [{ oldText: '已知旧内容' }, '-已知旧内容', '未提供新片段'],
  ])('does not invent diff lines for empty or missing snippets %j', async (snippets, expected, absent) => {
    const details = store(); const mock = sdk();
    const id = details.register('chat', entry({ toolName: 'replace', inputData: { path: '/x', ...snippets } }))!;
    bind(details, id);
    const result = await allPages(details, id, mock);
    expect(result.text).toContain(expected);
    expect(result.text).not.toContain(absent);
    expect(result.text).not.toContain('工具输入快照');
  });

  it('preserves blank lines, CRLF and trailing newlines when prefixing edit snippets', async () => {
    const details = store(); const mock = sdk();
    const id = details.register('chat', entry({ toolName: 'Edit', inputData: {
      path: '/x', old_string: '旧😀\r\n\n旧二\n', new_string: '新🐾\n\n新二\n',
    } }))!;
    bind(details, id);
    const result = await allPages(details, id, mock);
    expect(result.text).toContain('-旧😀\r\n-\n-旧二\n-\n+新🐾\n+\n+新二\n+');
  });

  it('preserves both complete signed snippets across detail pagination', async () => {
    const details = store({ pageBytes: 3000 }); const mock = sdk();
    const oldText = '旧😀\n第二行\n'.repeat(400);
    const newText = '新🐾\n第二行\n'.repeat(400);
    const id = details.register('chat', entry({ toolName: 'replace', inputData: { path: '/x', oldText, newText } }))!;
    bind(details, id);
    const result = await allPages(details, id, mock);
    expect(result.total).toBeGreaterThan(1);
    const marker = '替换片段：\n';
    const from = result.text.indexOf(marker) + marker.length;
    const to = result.text.indexOf('\n\n工具结果快照：', from);
    const lines = result.text.slice(from, to).split('\n');
    expect(lines.filter(line => line.startsWith('-')).map(line => line.slice(1)).join('\n')).toBe(oldText);
    expect(lines.filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n')).toBe(newText);
    expect(result.text).not.toContain('工具输入快照');
    expect(mock.reply).toHaveBeenCalledTimes(1);
    expect(mock.patch).toHaveBeenCalledTimes(result.total - 1);
  });

  it('does not fabricate unknown content or completed-but-missing results', () => {
    const details = store();
    for (const data of [
      entry({ inputData: { path: '/x', command: 'edit it' } }),
      entry({ inputData: undefined, toolInput: 'not JSON' }),
      entry({ toolResult: undefined }), entry({ status: 'running' }),
    ]) expect(details.register('chat', data)).toBeUndefined();
    expect(details.stats.entries).toBe(0);
  });

  it('labels failed edits as errors with no success action', async () => {
    const details = store(); const mock = sdk();
    const id = details.register('chat', entry({ status: 'failed', isError: true, toolResult: 'permission denied' }))!;
    bind(details, id); await open(details, id, mock.client);
    const request = mock.reply.mock.calls[0][0];
    expect(card(request).header.template).toBe('red');
    expect(body(request)).toContain('工具执行失败 · 拟改动内容');
    expect(request.data.content).not.toContain('工具执行成功');
    expect(request.data.content).not.toContain('primary_filled');
    expect(request.data.content).not.toContain('查看改动');
  });

  it('issues opaque UUIDs, deduplicates renders without refreshing TTL and expires exactly', async () => {
    let now = 100;
    const details = store({ now: () => now, ttlMs: 50 }); const mock = sdk();
    const data = entry(); const id = details.register('chat', data)!;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    bind(details, id);
    now = 149;
    expect(details.register('chat', data)).toBe(id);
    expect(details.stats.entries).toBe(1);
    now = 150;
    expect(responseType(await open(details, id, mock.client))).toBe('error');
    expect(details.stats).toEqual({ entries: 0, bytes: 0 });
    expect(details.register('chat', data)).not.toBe(id);
    expect(mock.reply).not.toHaveBeenCalled();
  });

  it('enforces retained entry and byte limits including scope and page offsets', async () => {
    const details = store({ maxEntries: 1, maxBytes: 5000 }); const mock = sdk();
    const first = details.register('chat', entry())!;
    const second = details.register('chat', entry({ toolId: 'call-2' }))!;
    expect(second).not.toBe(first);
    expect(details.stats.entries).toBe(1);
    expect(responseType(await open(details, first, mock.client))).toBe('error');
    bind(details, second);
    expect(details.stats.bytes).toBeLessThanOrEqual(5000);
    expect(details.register('chat', entry({ inputData: { path: '/huge', content: '大'.repeat(10000) } }))).toBeUndefined();
    expect(details.stats.entries).toBe(1);
  });

  it('preserves every code point across pages at the real low client budget, one card per page', async () => {
    const content = '中文😀 \\"<b>literal</b>\n```ts\nconst a = "x";\n```\n'.repeat(180);
    const details = store(); const mock = sdk();
    configureFeishuCardBudget(mock.client, { maxBytes: 3200, maxElements: 40, maxTables: 1 });
    const id = details.register('chat', entry({ inputData: { file_path: '/nonexistent/snapshot.txt', content } }))!;
    bind(details, id);
    const result = await allPages(details, id, mock);
    expect(result.total).toBeGreaterThan(2);
    const added = content.split('\n').map(line => `+${line}`).join('\n');
    const expected = '工具执行成功 · 本次改动\n工具：write\n\n' +
      `文件：/nonexistent/snapshot.txt\n写入：\n${added}\n\n` +
      '工具结果快照：\nwritten';
    expect(result.text).toBe(expected);
    expect(mock.reply).toHaveBeenCalledTimes(1);
    expect(mock.patch).toHaveBeenCalledTimes(result.total - 1);
    expect(mock.create).not.toHaveBeenCalled();
    for (const request of result.requests) {
      const size = measureFeishuCard(request.data.content);
      expect(Math.max(size.bytes, size.requestBytes)).toBeLessThanOrEqual(3200);
      expect(Buffer.byteLength(JSON.stringify(request), 'utf8')).toBeLessThanOrEqual(3200);
      expect(body(request)).not.toBe(expected);
      expect(body(request)).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
  });

  it('rejects impossible component budgets before any SDK write', async () => {
    const details = store(); const mock = sdk();
    configureFeishuCardBudget(mock.client, { maxBytes: 3200, maxElements: 1 });
    const id = details.register('chat', entry())!; bind(details, id);
    expect(responseType(await open(details, id, mock.client))).toBe('error');
    expect(mock.reply).not.toHaveBeenCalled(); expect(mock.create).not.toHaveBeenCalled();
  });

  it('repeated open reuses the existing detail and serializes concurrent pages', async () => {
    const details = store({ pageBytes: 3000 }); const mock = sdk();
    const id = details.register('chat', entry({ inputData: { path: '/x', content: 'x'.repeat(6000) } }))!;
    bind(details, id);
    const opens = await Promise.all([open(details, id, mock.client), open(details, id, mock.client)]);
    expect(opens.map(responseType)).toEqual(['success', 'success']);
    expect(mock.reply).toHaveBeenCalledTimes(1);
    let release!: () => void;
    mock.patch.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { code: 0 }; });
    const first = page(details, id, 1, mock.client);
    await vi.waitFor(() => expect(mock.patch).toHaveBeenCalledTimes(1));
    const second = page(details, id, 2, mock.client);
    await Promise.resolve();
    expect(mock.patch).toHaveBeenCalledTimes(1);
    release();
    expect((await Promise.all([first, second])).map(responseType)).toEqual(['success', 'success']);
    expect(mock.patch).toHaveBeenCalledTimes(2);
    expect(card(mock.patch.mock.calls[1][0]).body.elements[0].text!.content).toMatch(/^3 \/ \d+$/);
  });

  it('withdraws the exact detail and makes reopen a single fresh detail', async () => {
    const details = store(); const mock = sdk(); const id = details.register('chat', entry())!;
    bind(details, id); await open(details, id, mock.client);
    const closed = await action(details, id, 'close', mock.client);
    expect(responseType(closed)).toBe('success');
    expect(JSON.stringify(closed)).toContain('撤回');
    expect(mock.del).toHaveBeenCalledExactlyOnceWith({ path: { message_id: 'detail-1' } });
    await open(details, id, mock.client);
    expect(mock.reply).toHaveBeenCalledTimes(2);
    expect(responseType(await page(details, id, 0, mock.client))).toBe('error');
  });

  it('falls back to an honest closed placeholder and reopens by patching the same message', async () => {
    const details = store(); const mock = sdk(); const id = details.register('chat', entry())!;
    bind(details, id); await open(details, id, mock.client);
    mock.del.mockResolvedValue({ code: 230001 });
    const closed = await action(details, id, 'close', mock.client);
    expect(responseType(closed)).toBe('success');
    expect(JSON.stringify(closed)).toContain('未能撤回');
    expect(mock.patch.mock.calls[0][0].path).toEqual({ message_id: 'detail-1' });
    expect(mock.patch.mock.calls[0][0].data.content).toContain('详情已关闭');
    expect(mock.patch.mock.calls[0][0].data.content).not.toContain('original');
    await open(details, id, mock.client);
    expect(mock.reply).toHaveBeenCalledTimes(1); expect(mock.patch).toHaveBeenCalledTimes(2);
    expect(body(mock.patch.mock.calls[1][0])).toContain('original');
  });

  it('never claims close succeeded when both delete and placeholder patch fail', async () => {
    const details = store(); const mock = sdk(); const id = details.register('chat', entry())!;
    bind(details, id); await open(details, id, mock.client);
    mock.del.mockRejectedValue(new Error('private SDK data'));
    mock.patch.mockResolvedValue({ code: 230099 });
    const closed = await action(details, id, 'close', mock.client);
    expect(responseType(closed)).toBe('error');
    expect(JSON.stringify(closed)).toContain('均未成功');
    expect(JSON.stringify(closed)).not.toContain('private SDK data');
    await open(details, id, mock.client);
    expect(mock.reply).toHaveBeenCalledTimes(1);
  });

  it('refuses fulfilled SDK errors and prevents escaped thread fallback sends', async () => {
    const details = store(); const mock = sdk(); const id = details.register('chat', entry())!;
    bind(details, id);
    mock.reply.mockResolvedValueOnce({ code: 230011, data: { message_id: '', thread_id: 'thread' } });
    expect(responseType(await open(details, id, mock.client))).toBe('error');
    expect(mock.create).not.toHaveBeenCalled();
    expect(responseType(await open(details, id, mock.client))).toBe('success');
    expect(mock.reply).toHaveBeenCalledTimes(2);
  });

  it('does not silently split one navigation page into overflow messages after a server limit rejection', async () => {
    const details = store({ pageBytes: 4000 }); const mock = sdk();
    configureFeishuCardBudget(mock.client, { maxBytes: 4000, maxElements: 60 });
    const id = details.register('chat', entry({ inputData: { path: '/x', content: 'x'.repeat(12000) } }))!;
    bind(details, id);
    mock.reply.mockRejectedValueOnce(Object.assign(new Error('card too large'), { code: 230025 }));
    expect(responseType(await open(details, id, mock.client))).toBe('error');
    expect(mock.reply).toHaveBeenCalledTimes(1);
    expect(mock.create).not.toHaveBeenCalled();
    expect(mock.del).not.toHaveBeenCalled();
  });

  it('never reads a file or re-executes tools while registering or viewing snapshots', async () => {
    const reads = [vi.spyOn(fs, 'readFileSync'), vi.spyOn(fsPromises, 'readFile')];
    const executes = [vi.spyOn(childProcess, 'execFile'), vi.spyOn(childProcess, 'execSync')];
    try {
      const details = store(); const mock = sdk();
      const data = entry({ toolName: 'Edit', inputData: { path: '/does-not-exist', old_string: 'old', new_string: 'new' } });
      const id = details.register('chat', data)!;
      (data.inputData as { new_string: string }).new_string = 'later mutation';
      bind(details, id); await open(details, id, mock.client);
      expect(body(mock.reply.mock.calls[0][0])).toContain('-old\n+new');
      for (const spy of [...reads, ...executes]) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of [...reads, ...executes]) spy.mockRestore();
    }
  });

  it('bounds source-message authorization and rejects unbound snapshots', async () => {
    const details = store({ maxSources: 1 }); const mock = sdk(); const id = details.register('chat', entry())!;
    expect(responseType(await open(details, id, mock.client))).toBe('error');
    bind(details, id, {}, ['source', 'overflow']);
    expect(responseType(await open(details, id, mock.client, { messageId: 'overflow' }))).toBe('error');
    expect(responseType(await open(details, id, mock.client))).toBe('success');
  });

  it('revalidates expiry after queued work and does not send a queued expired page', async () => {
    let now = 0;
    const details = store({ now: () => now, ttlMs: 100, pageBytes: 3000 }); const mock = sdk();
    const id = details.register('chat', entry({ inputData: { path: '/x', content: 'x'.repeat(6000) } }))!;
    bind(details, id); await open(details, id, mock.client);
    let release!: () => void;
    mock.patch.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { code: 0 }; });
    const first = page(details, id, 1, mock.client);
    await vi.waitFor(() => expect(mock.patch).toHaveBeenCalledTimes(1));
    const queued = page(details, id, 2, mock.client);
    now = 100; release();
    expect(responseType(await first)).toBe('success');
    expect(responseType(await queued)).toBe('error');
    expect(mock.patch).toHaveBeenCalledTimes(1);
    expect(details.stats).toEqual({ entries: 0, bytes: 0 });
  });

  it('does not commit a failed page update and retries the same page honestly', async () => {
    const details = store({ pageBytes: 3000 }); const mock = sdk();
    const id = details.register('chat', entry({ inputData: { path: '/x', content: 'x'.repeat(6000) } }))!;
    bind(details, id); await open(details, id, mock.client);
    mock.patch.mockResolvedValueOnce({ code: 230099 });
    expect(responseType(await page(details, id, 1, mock.client))).toBe('error');
    expect(responseType(await page(details, id, 1, mock.client))).toBe('success');
    expect(mock.patch).toHaveBeenCalledTimes(2);
  });

  it.each(['completed', 'failed', 'interrupted'])('retains a complete redacted generic %s input/result and pages in one message', async status => {
    const details = store({ pageBytes: 3000 }); const mock = sdk();
    configureFeishuCardBudget(mock.client, { maxBytes: 3000, maxElements: 16 });
    const secret = 'sk-proj-' + 'A'.repeat(80);
    const full = 'BEGIN\r\n' + '中文😀 \\ \" <at id="all">x</at>\n'.repeat(400) + secret + '\nEND';
    const input = { query: 'original', token: secret, nested: { value: 'original-input' } };
    const data = entry({ toolName: 'search', inputData: input, toolResult: full, status });
    const id = details.register('chat', data)!;
    expect(id).toBeTruthy();
    input.nested.value = 'mutated'; data.toolResult = 'mutated';
    bind(details, id);
    for (const mismatch of [{ userId: 'other' }, { chatId: 'other' }, { threadId: 'other' }, { messageId: 'parent-source' }]) {
      expect(responseType(await open(details, id, mock.client, mismatch))).toBe('error');
    }
    const result = await allPages(details, id, mock);
    expect(result.total).toBeGreaterThan(2);
    expect(result.text).toContain('状态：' + status);
    expect(result.text).toContain('original-input');
    expect(result.text).not.toContain('mutated');
    expect(result.text).not.toContain(secret);
    expect(result.text.split('工具结果快照：\n')[1]).toBe(full.replace(secret, 'sk-proj-[REDACTED]'));
    for (const request of result.requests) {
      expect(measureFeishuCard(request.data.content).requestBytes).toBeLessThanOrEqual(3000);
      expect(card(request).body.elements.every(node => node.tag !== 'markdown')).toBe(true);
    }
    expect(mock.reply).toHaveBeenCalledTimes(1);
    expect(mock.create).not.toHaveBeenCalled();
    expect(card(result.requests[0]).header.template).toBe(status === 'failed' ? 'red' : 'blue');
    expect(responseType(await action(details, id, 'close', mock.client))).toBe('success');
    expect(mock.del).toHaveBeenCalledExactlyOnceWith({ path: { message_id: 'detail-1' } });
  });

  it('accepts plain/absent input and structured results for generic oversized snapshots', async () => {
    for (const toolInput of ['plain input', undefined]) {
      const details = store(); const mock = sdk();
      const result = { output: '中'.repeat(4000) };
      const id = details.register('chat', entry({ toolName: 'custom', inputData: undefined, toolInput, toolResult: result }))!;
      expect(id).toBeTruthy(); bind(details, id);
      const pages = await allPages(details, id, mock);
      expect(pages.text).toContain(toolInput ?? '(未提供输入)');
      expect(JSON.parse(pages.text.split('工具结果快照：\n')[1])).toEqual(result);
    }
  });

  it('does not evict a hidden full result under entry/cache pressure and prepays binding offsets', async () => {
    const details = store({ maxEntries: 1, maxBytes: 400_000, pageBytes: 3000 }); const mock = sdk();
    const id = details.register('chat', entry({ toolName: 'search', toolResult: 'x'.repeat(10001) }))!;
    expect(id).toBeTruthy();
    expect(details.register('chat', entry({ toolId: 'next-edit' }))).toBeUndefined();
    expect(details.register('chat', entry({ toolId: 'next-search', toolResult: 'x'.repeat(10001) }))).toBeUndefined();
    expect(details.registerThinking('chat', { thinkingId: 'thought', text: 'x' })).toBeUndefined();
    const before = details.stats.bytes;
    bind(details, id);
    configureFeishuCardBudget(mock.client, { maxBytes: 3000, maxElements: 16 });
    const result = await allPages(details, id, mock);
    expect(result.text).toContain('x'.repeat(10001));
    expect(details.stats).toEqual({ entries: 1, bytes: before });
  });

});
