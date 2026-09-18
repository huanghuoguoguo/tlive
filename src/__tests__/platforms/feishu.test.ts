import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @larksuiteoapi/node-sdk before importing the adapter
const mockMessageCreate = vi.fn();
const mockMessageReply = vi.fn();
const mockMessagePatch = vi.fn().mockResolvedValue({});
const mockMessageDelete = vi.fn().mockResolvedValue({});
const mockPinCreate = vi.fn().mockResolvedValue({});
const mockImageCreate = vi.fn();
const mockFileCreate = vi.fn();
const mockV1MessageResourceGet = vi.fn().mockResolvedValue({ data: null });
const mockMessageResourceGet = vi.fn().mockResolvedValue(null);
const mockImageGet = vi.fn().mockResolvedValue(null);
const eventHandlers = new Map<string, (...args: any[]) => any>();
const mockEventHandler = vi.fn(async (event: any) => {
  const handler = eventHandlers.get('im.message.receive_v1');
  if (handler) await handler(event);
});
const mockWsStart = vi.fn().mockResolvedValue(undefined);

vi.mock('@larksuiteoapi/node-sdk', () => {
  const MockClient = vi.fn(function (this: any) {
    this.im = {
      message: {
        create: mockMessageCreate,
        reply: mockMessageReply,
        patch: mockMessagePatch,
        delete: mockMessageDelete,
      },
      pin: {
        create: mockPinCreate,
      },
      file: { create: mockFileCreate },
      v1: { messageResource: { get: mockV1MessageResourceGet } },
      image: { create: mockImageCreate, get: mockImageGet },
      messageResource: { get: mockMessageResourceGet },
    };
  });

  const MockEventDispatcher = vi.fn(function (this: any) {
    this.register = vi.fn((handlers: Record<string, (...args: any[]) => any>) => {
      for (const [key, fn] of Object.entries(handlers)) {
        eventHandlers.set(key, fn);
      }
    });
    this.invoke = vi.fn(async (body: string) => {
      const parsed = JSON.parse(body);
      if (parsed.type === 'url_verification') {
        return { challenge: parsed.challenge };
      }
      if (parsed.event) {
        await mockEventHandler(parsed.event);
      }
      return {};
    });
  });

  const MockWSClient = vi.fn(function (this: any) {
    this.close = vi.fn();
    this.start = mockWsStart;
  });

  return {
    Client: MockClient,
    EventDispatcher: MockEventDispatcher,
    WSClient: MockWSClient,
  };
});

import { FeishuAdapter } from '../../server/channels/feishu/adapter.js';
import { FormatError, RateLimitError } from '../../server/channels/errors.js';
import { FeishuFormatter } from '../../server/channels/feishu/formatter.js';
import { MAX_TABLES_PER_CARD } from '../../server/channels/feishu/markdown.js';

function markdownTable(prefix: string, rows: number): string {
  return [
    '| Name | Value |',
    '|---|---|',
    ...Array.from({ length: rows }, (_, i) => `| ${prefix}${i + 1} | ${i + 1} |`),
  ].join('\n');
}

function markdownContents(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  const own = typeof object.content === 'string' && object.tag === 'markdown' ? [object.content] : [];
  const elements = Array.isArray(object.elements) ? object.elements.flatMap(markdownContents) : [];
  const body = object.body && typeof object.body === 'object'
    ? markdownContents(object.body)
    : [];
  return [...own, ...elements, ...body];
}

function elementsByTag(value: unknown, tag: string): Array<Record<string, any>> {
  if (!value || typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  const own = object.tag === tag ? [object as Record<string, any>] : [];
  const elements = Array.isArray(object.elements)
    ? object.elements.flatMap((element) => elementsByTag(element, tag))
    : [];
  const body = object.body && typeof object.body === 'object'
    ? elementsByTag(object.body, tag)
    : [];
  return [...own, ...elements, ...body];
}

function tableCountInCard(content: string): number {
  const card = JSON.parse(content);
  return markdownContents(card).reduce(
    (total, markdown) =>
      total + [...markdown.matchAll(/^(\|.*\|)\n(\|[-:| ]+\|)\n((?:\|.*\|\n?)+)/gm)].length,
    0,
  );
}

describe('FeishuAdapter', () => {
  let adapter: FeishuAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessageCreate.mockResolvedValue({ data: { message_id: 'msg-feishu-1' } });
    mockMessageReply.mockResolvedValue({ data: { message_id: 'msg-feishu-reply-1' } });
    mockMessagePatch.mockResolvedValue({});
    mockMessageDelete.mockResolvedValue({});
    mockPinCreate.mockResolvedValue({});
    mockImageCreate.mockResolvedValue({ image_key: 'img-uploaded' });
    mockFileCreate.mockResolvedValue({ file_key: 'file-uploaded' });
    mockV1MessageResourceGet.mockResolvedValue({ data: null });
    mockMessageResourceGet.mockResolvedValue(null);
    mockImageGet.mockResolvedValue(null);
    adapter = new FeishuAdapter({
      appId: 'cli_test123',
      appSecret: 'secret_abc',
      verificationToken: 'verify_token',
      encryptKey: '',
      allowedUsers: ['user1', 'user2'],
    }, {
      botOpenId: 'ou_bot',
      botName: 'openclaw',
    });
  });

  describe('validateConfig()', () => {
    it('returns error when appId is missing', () => {
      const bad = new FeishuAdapter({ appId: '', appSecret: 'sec', verificationToken: '', encryptKey: '', allowedUsers: [] });
      expect(bad.validateConfig()).toContain('TL_FS_APP_ID');
    });

    it('returns error when appSecret is missing', () => {
      const bad = new FeishuAdapter({ appId: 'id', appSecret: '', verificationToken: '', encryptKey: '', allowedUsers: [] });
      expect(bad.validateConfig()).toContain('TL_FS_APP_SECRET');
    });

    it('returns null when config is valid', () => {
      expect(adapter.validateConfig()).toBeNull();
    });
  });

  describe('classifyError()', () => {
    it('treats Feishu message patch frequency errors as rate limits', () => {
      const err = adapter.classifyError({ code: 230020, message: 'frequency limit' });
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBe(2000);
    });

    it('reads retry-after headers for 429 responses', () => {
      const err = adapter.classifyError({
        status: 429,
        message: 'too many requests',
        headers: { 'retry-after': '3' },
      });
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBe(3000);
    });

    it('recognizes nested Feishu table-limit responses as format errors', () => {
      const err = adapter.classifyError({
        message: 'Request failed with status code 400',
        response: {
          status: 400,
          data: {
            code: 230099,
            msg: 'Failed to create card content, ext=ErrCode: 11310; ErrMsg: card table number over limit;',
          },
        },
      });

      expect(err).toBeInstanceOf(FormatError);
      expect(err.message).toContain('11310');
    });
  });

  describe('isAuthorized()', () => {
    it('allows users in allowedUsers list', () => {
      expect(adapter.isAuthorized('user1', 'chat1')).toBe(true);
    });

    it('denies users not in allowedUsers list', () => {
      expect(adapter.isAuthorized('unknown', 'chat1')).toBe(false);
    });

    it('allows all users when allowedUsers is empty', () => {
      const open = new FeishuAdapter({ appId: 'id', appSecret: 'sec', verificationToken: '', encryptKey: '', allowedUsers: [] });
      expect(open.isAuthorized('anyone', 'anychat')).toBe(true);
    });
  });

  describe('send()', () => {
    it('always sends interactive card', async () => {
      await adapter.start();
      const result = await adapter.send({
        chatId: 'oc_chat123',
        text: 'Hello from TermLive',
      });

      expect(mockMessageCreate).toHaveBeenCalledOnce();
      const call = mockMessageCreate.mock.calls[0][0];
      expect(call.data.msg_type).toBe('interactive');
      const card = JSON.parse(call.data.content);
      expect(card.config.wide_screen_mode).toBe(true);
      expect(card.body.elements[0].tag).toBe('markdown');
      expect(card.body.elements[0].content).toBe('Hello from TermLive');

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('msg-feishu-1');
      await adapter.stop();
    });

    it('sets receive_id and receive_id_type correctly', async () => {
      await adapter.start();
      await adapter.send({ chatId: 'oc_specific_chat', text: 'hi' });

      const call = mockMessageCreate.mock.calls[0][0];
      expect(call.params.receive_id_type).toBe('chat_id');
      expect(call.data.receive_id).toBe('oc_specific_chat');
      await adapter.stop();
    });

    it('splits tables from the final structured element tree across safe cards', async () => {
      const content = [
        'Before',
        markdownTable('Long', 25),
        markdownTable('SmallA', 2),
        markdownTable('SmallB', 2),
        markdownTable('SmallC', 2),
        'After',
      ].join('\n\n');
      await adapter.start();

      const result = await adapter.send({
        chatId: 'oc_chat123',
        text: '',
        feishuHeader: { template: 'green', title: 'Summary' },
        feishuElements: [
          {
            tag: 'collapsible_panel',
            expanded: true,
            header: { title: { tag: 'plain_text', content: 'Details' } },
            elements: [{ tag: 'markdown', content }],
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(mockMessageCreate).toHaveBeenCalledTimes(2);
      const cardContents = mockMessageCreate.mock.calls.map((call) => call[0].data.content);
      for (const cardContent of cardContents) {
        expect(tableCountInCard(cardContent)).toBeLessThanOrEqual(MAX_TABLES_PER_CARD);
      }
      const delivered = cardContents
        .flatMap((cardContent) => markdownContents(JSON.parse(cardContent)))
        .join('\n');
      for (let i = 1; i <= 25; i++) expect(delivered).toContain(`Long${i}`);
      expect(delivered).toContain('SmallA1');
      expect(delivered).toContain('SmallB1');
      expect(delivered).toContain('SmallC1');
      expect(delivered).toContain('Before');
      expect(delivered).toContain('After');
      await adapter.stop();
    });

    it('counts tables created by long-table normalization before splitting plain cards', async () => {
      const content = [
        markdownTable('Long', 25),
        markdownTable('SmallA', 1),
        markdownTable('SmallB', 1),
        markdownTable('SmallC', 1),
      ].join('\n\n');
      await adapter.start();

      await adapter.send({ chatId: 'oc_chat123', text: content });

      expect(mockMessageCreate).toHaveBeenCalledTimes(2);
      for (const call of mockMessageCreate.mock.calls) {
        expect(tableCountInCard(call[0].data.content)).toBeLessThanOrEqual(MAX_TABLES_PER_CARD);
      }
      await adapter.stop();
    });

    it('splits five ordinary tables before reaching the streaming parser boundary', async () => {
      const content = Array.from({ length: 5 }, (_, i) =>
        markdownTable(`Boundary${i + 1}Row`, 1),
      ).join('\n\n');
      await adapter.start();

      await adapter.send({ chatId: 'oc_chat123', text: content });

      expect(mockMessageCreate).toHaveBeenCalledTimes(2);
      expect(
        mockMessageCreate.mock.calls.map((call) => tableCountInCard(call[0].data.content)),
      ).toEqual([MAX_TABLES_PER_CARD, 1]);
      await adapter.stop();
    });

    it('splits before a fifth streaming table receives its first data row', async () => {
      const partialTable = '| Name | Value |\n|---|---|';
      const content = [
        ...Array.from({ length: 4 }, (_, i) => markdownTable(`Complete${i + 1}Row`, 1)),
        partialTable,
      ].join('\n\n');
      await adapter.start();

      await adapter.send({ chatId: 'oc_chat123', text: content });

      expect(mockMessageCreate).toHaveBeenCalledTimes(2);
      const cardContents = mockMessageCreate.mock.calls.map((call) => call[0].data.content);
      expect(tableCountInCard(cardContents[0])).toBe(MAX_TABLES_PER_CARD);
      expect(markdownContents(JSON.parse(cardContents[1])).join('\n')).toContain(partialTable);
      await adapter.stop();
    });

    it('splits a structured summary with nine ordinary tables without dropping content', async () => {
      const content = Array.from({ length: 9 }, (_, i) =>
        markdownTable(`Table${i + 1}Row`, 1),
      ).join('\n\n');
      mockMessageCreate
        .mockResolvedValueOnce({ data: { message_id: 'summary-root' } })
        .mockResolvedValueOnce({ data: { message_id: 'summary-overflow-1' } })
        .mockResolvedValueOnce({ data: { message_id: 'summary-overflow-2' } });
      await adapter.start();

      const message = {
        chatId: 'oc_chat123',
        text: '',
        feishuElements: [{ tag: 'markdown', content }],
      };
      const result = await adapter.send(message);

      expect(mockMessageCreate).toHaveBeenCalledTimes(3);
      const cardContents = mockMessageCreate.mock.calls.map((call) => call[0].data.content);
      for (const cardContent of cardContents) {
        expect(tableCountInCard(cardContent)).toBeLessThanOrEqual(MAX_TABLES_PER_CARD);
      }
      const delivered = cardContents
        .flatMap((cardContent) => markdownContents(JSON.parse(cardContent)))
        .join('\n');
      for (let i = 1; i <= 9; i++) expect(delivered).toContain(`Table${i}Row1`);

      await adapter.editMessage('oc_chat123', result.messageId, message);

      expect(mockMessageCreate).toHaveBeenCalledTimes(3);
      expect(mockMessagePatch).toHaveBeenCalledWith({
        path: { message_id: 'summary-root' },
        data: { content: expect.any(String) },
      });
      expect(mockMessagePatch).toHaveBeenCalledWith({
        path: { message_id: 'summary-overflow-1' },
        data: { content: expect.any(String) },
      });
      expect(mockMessagePatch).toHaveBeenCalledWith({
        path: { message_id: 'summary-overflow-2' },
        data: { content: expect.any(String) },
      });
      await adapter.stop();
    });

    it('passes root_id when replyToMessageId is set', async () => {
      await adapter.start();
      await adapter.send({
        chatId: 'oc_chat123',
        text: 'Reply text',
        replyToMessageId: 'msg-parent-1',
      });

      const call = mockMessageCreate.mock.calls[0][0];
      expect(call.data.root_id).toBe('msg-parent-1');
      await adapter.stop();
    });

    it('uses Feishu threaded reply when replyInThread is set', async () => {
      await adapter.start();
      await adapter.send({
        chatId: 'oc_chat123',
        text: 'Reply text',
        replyToMessageId: 'msg-topic-1',
        replyInThread: true,
      });

      expect(mockMessageReply).toHaveBeenCalledOnce();
      expect(mockMessageCreate).not.toHaveBeenCalled();
      const call = mockMessageReply.mock.calls[0][0];
      expect(call.path.message_id).toBe('msg-topic-1');
      expect(call.data.reply_in_thread).toBe(true);
      await adapter.stop();
    });

    it('sends uploaded files as Feishu file messages', async () => {
      await adapter.start();
      await adapter.send({
        chatId: 'oc_chat123',
        text: 'caption',
        media: {
          type: 'file',
          filename: 'notes.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('hello'),
        },
      });

      expect(mockFileCreate).toHaveBeenCalledWith({
        data: {
          file_type: 'stream',
          file_name: 'notes.txt',
          file: expect.any(Buffer),
        },
      });
      expect(mockMessageCreate).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_chat123',
          msg_type: 'file',
          content: JSON.stringify({ file_key: 'file-uploaded' }),
        },
      });
      await adapter.stop();
    });

    it('accepts legacy nested upload key responses', async () => {
      mockFileCreate.mockResolvedValueOnce({ data: { file_key: 'nested-file-key' } });
      await adapter.start();

      await adapter.send({
        chatId: 'oc_chat123',
        text: 'caption',
        media: {
          type: 'file',
          filename: 'notes.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('hello'),
        },
      });

      expect(mockMessageCreate).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_chat123',
          msg_type: 'file',
          content: JSON.stringify({ file_key: 'nested-file-key' }),
        },
      });
      await adapter.stop();
    });

    it('does not fall back to text when media delivery fails', async () => {
      mockFileCreate.mockRejectedValueOnce(new Error('upload failed'));
      await adapter.start();

      await expect(adapter.send({
        chatId: 'oc_chat123',
        text: 'caption',
        media: {
          type: 'file',
          filename: 'notes.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('hello'),
        },
      })).rejects.toThrow('upload failed');

      expect(mockMessageCreate).not.toHaveBeenCalled();
      await adapter.stop();
    });

    it('starts a Feishu topic from a main-chat message', async () => {
      mockMessageReply.mockResolvedValueOnce({
        data: { message_id: 'msg-topic-start', thread_id: 'thread-1' },
      });
      await adapter.start();

      const result = await adapter.startThreadFromMessage('oc_chat123', 'msg-main-1');

      expect(result).toEqual({ messageId: 'msg-topic-start', rootMessageId: 'msg-main-1', threadId: 'thread-1' });
      expect(mockMessageReply).toHaveBeenCalledWith({
        path: { message_id: 'msg-main-1' },
        data: expect.objectContaining({
          msg_type: 'interactive',
          reply_in_thread: true,
        }),
      });
      await adapter.stop();
    });

    it('starts a Feishu topic from a new title message', async () => {
      mockMessageCreate.mockResolvedValueOnce({
        data: { message_id: 'msg-topic-title' },
      });
      mockMessageReply.mockResolvedValueOnce({
        data: { message_id: 'msg-topic-start', thread_id: 'thread-1' },
      });
      await adapter.start();

      const result = await adapter.startThreadWithTitle('oc_chat123', 'Continue previous Claude task');

      expect(result).toEqual({
        messageId: 'msg-topic-start',
        rootMessageId: 'msg-topic-title',
        threadId: 'thread-1',
      });
      expect(mockMessageCreate).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_chat123',
          msg_type: 'text',
          content: JSON.stringify({ text: 'Continue previous Claude task' }),
        },
      });
      expect(mockMessageReply).toHaveBeenCalledWith({
        path: { message_id: 'msg-topic-title' },
        data: expect.objectContaining({
          msg_type: 'interactive',
          reply_in_thread: true,
        }),
      });
      await adapter.stop();
    });

    it('pins the topic entry message when autoPinTopics is enabled', async () => {
      adapter = new FeishuAdapter({
        appId: 'cli_test123',
        appSecret: 'secret_abc',
        verificationToken: 'verify_token',
        encryptKey: '',
        allowedUsers: [],
      }, { autoPinTopics: true });
      mockMessageReply.mockResolvedValueOnce({
        data: { message_id: 'msg-topic-start', thread_id: 'thread-1' },
      });
      await adapter.start();

      await adapter.startThreadFromMessage('oc_chat123', 'msg-main-1');

      expect(mockPinCreate).toHaveBeenCalledWith({
        data: { message_id: 'msg-topic-start' },
      });
      await adapter.stop();
    });

    it('publishes pinned topic metadata as a readable post thread reply', async () => {
      adapter = new FeishuAdapter({
        appId: 'cli_test123',
        appSecret: 'secret_abc',
        verificationToken: 'verify_token',
        encryptKey: '',
        allowedUsers: [],
      }, { autoPinTopics: true });
      mockMessageReply.mockResolvedValueOnce({
        data: { message_id: 'msg-topic-metadata', thread_id: 'thread-1' },
      });
      await adapter.start();

      const result = await adapter.publishTopicMetadata(
        'oc_chat123',
        'msg-topic-root',
        'TLive 会话索引\ntlive-topic:abc',
      );

      expect(result).toBe('msg-topic-metadata');
      expect(mockMessageReply).toHaveBeenCalledWith({
        path: { message_id: 'msg-topic-root' },
        data: {
          msg_type: 'post',
          content: JSON.stringify({
            zh_cn: {
              title: 'TLive 会话索引',
              content: [
                [
                  {
                    tag: 'a',
                    text: 'TLive 会话索引',
                    href: 'https://tlive.local/session#tlive-topic:abc',
                  },
                ],
              ],
            },
          }),
          reply_in_thread: true,
        },
      });
      expect(mockPinCreate).toHaveBeenCalledWith({
        data: { message_id: 'msg-topic-metadata' },
      });
      await adapter.stop();
    });

    it('throws when client is not started', async () => {
      await expect(adapter.send({ chatId: 'oc_chat123', text: 'hi' })).rejects.toThrow(
        'Feishu client not started',
      );
    });
  });

  describe('start() / stop()', () => {
    it('starts websocket transport before accepting sends', async () => {
      await adapter.start();
      expect(mockWsStart).toHaveBeenCalledOnce();

      await adapter.send({ chatId: 'oc_chat', text: 'test' });
      expect(mockMessageCreate).toHaveBeenCalledOnce();

      await adapter.stop();
    });

    it('clears client on stop so subsequent sends fail', async () => {
      await adapter.start();
      await adapter.stop();
      await expect(adapter.send({ chatId: 'oc_chat', text: 'test' })).rejects.toThrow(
        'Feishu client not started',
      );
    });
  });

  describe('editMessage()', () => {
    it('collapses earlier chunks while keeping the latest long text chunk expanded', async () => {
      const remoteCards = new Map<string, string>();
      let nextMessageId = 1;
      mockMessageCreate.mockImplementation(async (call) => {
        const messageId = `text-overflow-${nextMessageId++}`;
        remoteCards.set(messageId, call.data.content);
        return { data: { message_id: messageId } };
      });
      mockMessagePatch.mockImplementation(async (call) => {
        remoteCards.set(call.path.message_id, call.data.content);
        return {};
      });
      const formatter = new FeishuFormatter('zh');
      const formatStreamingText = (text: string) => formatter.formatProgress('oc_chat123', {
        phase: 'executing',
        taskSummary: 'long text streaming test',
        elapsedSeconds: 10,
        renderedText: text,
        totalTools: 0,
        todoItems: [],
        timeline: [{ kind: 'text', text }],
      });
      const firstText = `PURE_TEXT_START\n\n${'连续输出的长文本。'.repeat(5000)}\n\nPURE_TEXT_TAIL_1`;
      await adapter.start();

      await adapter.editMessage(
        'oc_chat123',
        'text-root',
        formatStreamingText(firstText),
      );

      let cards = [...remoteCards.values()].map((content) => JSON.parse(content));
      let panels = cards.flatMap((card) => elementsByTag(card, 'collapsible_panel'));
      expect(panels.length).toBeGreaterThan(1);
      expect(panels.slice(0, -1).every((panel) => panel.expanded === false)).toBe(true);
      expect(panels.at(-1)?.expanded).toBe(true);
      expect(markdownContents(panels.at(-1)).join('\n')).toContain('PURE_TEXT_TAIL_1');

      const secondText = `${firstText}\n\n${'后续流式内容。'.repeat(500)}\n\nPURE_TEXT_TAIL_2`;
      await adapter.editMessage(
        'oc_chat123',
        'text-root',
        formatStreamingText(secondText),
      );

      cards = [...remoteCards.values()].map((content) => JSON.parse(content));
      panels = cards.flatMap((card) => elementsByTag(card, 'collapsible_panel'));
      expect(panels.slice(0, -1).every((panel) => panel.expanded === false)).toBe(true);
      expect(panels.at(-1)?.expanded).toBe(true);
      const delivered = cards.flatMap(markdownContents).join('\n');
      expect(delivered.match(/PURE_TEXT_START/g)).toHaveLength(1);
      expect(delivered.match(/PURE_TEXT_TAIL_2/g)).toHaveLength(1);
      await adapter.stop();
    });

    it('reuses table overflow bubbles while a streamed table set grows and shrinks', async () => {
      const remoteCards = new Map<string, string>();
      mockMessageCreate.mockImplementation(async (call) => {
        remoteCards.set('table-overflow', call.data.content);
        return { data: { message_id: 'table-overflow' } };
      });
      mockMessagePatch.mockImplementation(async (call) => {
        remoteCards.set(call.path.message_id, call.data.content);
        return {};
      });
      mockMessageDelete.mockImplementation(async (call) => {
        remoteCards.delete(call.path.message_id);
        return {};
      });
      const tableMessage = (count: number) => ({
        chatId: 'oc_chat123',
        text: Array.from({ length: count }, (_, i) =>
          markdownTable(`Growing${i + 1}Row`, 1),
        ).join('\n\n'),
      });
      await adapter.start();

      await adapter.editMessage('oc_chat123', 'table-root', tableMessage(4));
      expect(mockMessageCreate).not.toHaveBeenCalled();

      const partialFifthTable = {
        chatId: 'oc_chat123',
        text: `${tableMessage(4).text}\n\n| Name | Value |\n|---|---|`,
      };
      await adapter.editMessage('oc_chat123', 'table-root', partialFifthTable);
      expect(mockMessageCreate).toHaveBeenCalledTimes(1);

      await adapter.editMessage('oc_chat123', 'table-root', tableMessage(5));
      expect(mockMessageCreate).toHaveBeenCalledTimes(1);
      expect(mockMessagePatch).toHaveBeenCalledWith({
        path: { message_id: 'table-overflow' },
        data: { content: expect.any(String) },
      });
      expect([...remoteCards.values()].map(tableCountInCard)).toEqual([
        MAX_TABLES_PER_CARD,
        1,
      ]);
      const delivered = [...remoteCards.values()]
        .flatMap((cardContent) => markdownContents(JSON.parse(cardContent)))
        .join('\n');
      for (let i = 1; i <= 5; i++) {
        expect(delivered.match(new RegExp(`Growing${i}Row1`, 'g'))).toHaveLength(1);
      }

      await adapter.editMessage('oc_chat123', 'table-root', tableMessage(5));
      expect(mockMessageCreate).toHaveBeenCalledTimes(1);

      await adapter.editMessage('oc_chat123', 'table-root', tableMessage(4));
      expect(mockMessageDelete).toHaveBeenCalledWith({
        path: { message_id: 'table-overflow' },
      });
      expect(remoteCards.has('table-overflow')).toBe(false);
      expect(tableCountInCard(remoteCards.get('table-root')!)).toBe(MAX_TABLES_PER_CARD);
      await adapter.stop();
    });

    it('uses one stable physical split set when text and table limits trigger together', async () => {
      const remoteCards = new Map<string, string>();
      let nextMessageId = 1;
      mockMessageCreate.mockImplementation(async (call) => {
        const messageId = `combined-${nextMessageId++}`;
        remoteCards.set(messageId, call.data.content);
        return { data: { message_id: messageId } };
      });
      mockMessagePatch.mockImplementation(async (call) => {
        remoteCards.set(call.path.message_id, call.data.content);
        return {};
      });
      mockMessageDelete.mockImplementation(async (call) => {
        remoteCards.delete(call.path.message_id);
        return {};
      });
      const stressText = [
        'COMBINED_START',
        '长文本内容'.repeat(5000),
        ...Array.from({ length: 9 }, (_, i) => markdownTable(`Combined${i + 1}Row`, 1)),
        'COMBINED_END',
      ].join('\n\n');
      const formatter = new FeishuFormatter('zh');
      const executing = formatter.formatProgress('oc_chat123', {
        phase: 'executing',
        taskSummary: 'combined split stress test',
        elapsedSeconds: 10,
        renderedText: stressText,
        totalTools: 0,
        todoItems: [],
        timeline: [{ kind: 'text', text: stressText }],
      });
      await adapter.start();

      const result = await adapter.send(executing);
      const createdAfterInitialSend = mockMessageCreate.mock.calls.length;
      expect(createdAfterInitialSend).toBeGreaterThan(1);

      await adapter.editMessage('oc_chat123', result.messageId, executing);
      expect(mockMessageCreate).toHaveBeenCalledTimes(createdAfterInitialSend);

      const completed = formatter.formatProgress('oc_chat123', {
        phase: 'completed',
        taskSummary: 'combined split stress test',
        elapsedSeconds: 20,
        renderedText: stressText,
        totalTools: 0,
        todoItems: [],
        timeline: [{ kind: 'text', text: stressText }],
      });
      await adapter.editMessage('oc_chat123', result.messageId, completed);

      expect(mockMessageCreate).toHaveBeenCalledTimes(createdAfterInitialSend);
      for (const cardContent of remoteCards.values()) {
        expect(tableCountInCard(cardContent)).toBeLessThanOrEqual(MAX_TABLES_PER_CARD);
        expect(Buffer.byteLength(cardContent, 'utf8')).toBeLessThan(24 * 1024);
      }
      const delivered = [...remoteCards.values()]
        .flatMap((cardContent) => markdownContents(JSON.parse(cardContent)))
        .join('\n');
      expect(delivered.match(/COMBINED_START/g)).toHaveLength(1);
      expect(delivered.match(/COMBINED_END/g)).toHaveLength(1);
      for (let i = 1; i <= 9; i++) {
        expect(delivered.match(new RegExp(`Combined${i}Row1`, 'g'))).toHaveLength(1);
      }
      await adapter.stop();
    });

    it('updates existing overflow bubbles instead of recreating them on every stream flush', async () => {
      mockMessageCreate
        .mockResolvedValueOnce({ data: { message_id: 'overflow-1' } })
        .mockResolvedValueOnce({ data: { message_id: 'overflow-2' } });
      const message = { chatId: 'oc_chat123', text: 'stream '.repeat(5000) };
      await adapter.start();

      await adapter.editMessage('oc_chat123', 'stream-root', message);
      await adapter.editMessage('oc_chat123', 'stream-root', message);

      expect(mockMessageCreate).toHaveBeenCalledTimes(2);
      expect(mockMessagePatch).toHaveBeenCalledTimes(4);
      expect(mockMessagePatch).toHaveBeenCalledWith({
        path: { message_id: 'overflow-1' },
        data: { content: expect.any(String) },
      });
      expect(mockMessagePatch).toHaveBeenCalledWith({
        path: { message_id: 'overflow-2' },
        data: { content: expect.any(String) },
      });
      await adapter.stop();
    });

    it('propagates edit failures so the renderer can fall back to a new bubble', async () => {
      await adapter.start();
      mockMessagePatch.mockRejectedValueOnce(new Error('Request failed with status code 400'));
      await expect(adapter.editMessage('oc_chat123', 'msg-feishu-1', {
        chatId: 'oc_chat123',
        text: 'Updated content',
      })).rejects.toMatchObject({ retryable: false, statusCode: 400 });
      await adapter.stop();
    });

    it('propagates rate limits so the renderer can back off', async () => {
      await adapter.start();
      mockMessagePatch.mockRejectedValueOnce({ code: 230020, message: 'frequency limit' });

      await expect(adapter.editMessage('oc_chat123', 'msg-feishu-1', {
        chatId: 'oc_chat123',
        text: 'Updated content',
      })).rejects.toBeInstanceOf(RateLimitError);

      await adapter.stop();
    });

    it('does nothing when client is not started', async () => {
      await adapter.editMessage('oc_chat', 'msg-1', { chatId: 'oc_chat', text: 'hi' });
      expect(mockMessagePatch).not.toHaveBeenCalled();
    });
  });

  describe('event handling via WSClient', () => {
    it('processes text messages and strips @mentions', async () => {
      await adapter.start();

      // Simulate event handler being called (via registered handler)
      await mockEventHandler({
        message: {
          message_id: 'msg_1', chat_id: 'chat_1',
          message_type: 'text',
          content: JSON.stringify({ text: '@_user_1 Hello' }),
        },
        sender: { sender_id: { user_id: 'user_1', open_id: 'ou_123' } },
      });

      const msg = await adapter.consumeOne();
      expect(msg).not.toBeNull();
      expect(msg!.text).toBe('Hello');
      expect(msg!.chatId).toBe('chat_1');
      expect(msg!.userId).toBe('user_1');

      await adapter.stop();
    });

    it('ignores group messages that do not mention the current bot', async () => {
      await adapter.start();

      await mockEventHandler({
        message: {
          message_id: 'msg_group_1',
          chat_id: 'chat_1',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: 'done' }),
        },
        sender: { sender_id: { user_id: 'user_1', open_id: 'ou_123' } },
      });

      await mockEventHandler({
        message: {
          message_id: 'msg_group_2',
          chat_id: 'chat_1',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '@_user_1 done' }),
          mentions: [
            {
              key: '@_user_1',
              id: { open_id: 'ou_someone_else' },
              name: 'someone else',
            },
          ],
        },
        sender: { sender_id: { user_id: 'user_1', open_id: 'ou_123' } },
      });

      expect(await adapter.consumeOne()).toBeNull();

      await adapter.stop();
    });

    it('accepts group messages that mention the current bot', async () => {
      await adapter.start();

      await mockEventHandler({
        message: {
          message_id: 'msg_group_bot',
          chat_id: 'chat_1',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '@_user_1 /home' }),
          mentions: [
            {
              key: '@_user_1',
              id: { open_id: 'ou_bot' },
              name: 'openclaw',
            },
          ],
        },
        sender: { sender_id: { user_id: 'user_1', open_id: 'ou_123' } },
      });

      const msg = await adapter.consumeOne();
      expect(msg).not.toBeNull();
      expect(msg!.text).toBe('/home');
      expect(msg!.chatId).toBe('chat_1');

      await adapter.stop();
    });

    it('ignores group topic replies that do not mention the current bot', async () => {
      await adapter.start();

      await mockEventHandler({
        message: {
          message_id: 'msg_group_topic',
          chat_id: 'chat_1',
          chat_type: 'group',
          thread_id: 'thread_1',
          message_type: 'text',
          content: JSON.stringify({ text: 'continue this topic' }),
          root_id: 'msg_root',
        },
        sender: { sender_id: { user_id: 'user_1', open_id: 'ou_123' } },
      });

      expect(await adapter.consumeOne()).toBeNull();

      await adapter.stop();
    });

    it('accepts group topic replies that mention the current bot', async () => {
      await adapter.start();

      await mockEventHandler({
        message: {
          message_id: 'msg_group_topic_mention',
          chat_id: 'chat_1',
          chat_type: 'group',
          thread_id: 'thread_1',
          message_type: 'text',
          content: JSON.stringify({ text: '@_user_1 continue this topic' }),
          root_id: 'msg_root',
          mentions: [
            {
              key: '@_user_1',
              id: { open_id: 'ou_bot' },
              name: 'openclaw',
            },
          ],
        },
        sender: { sender_id: { user_id: 'user_1', open_id: 'ou_123' } },
      });

      const msg = await adapter.consumeOne();
      expect(msg).toMatchObject({
        text: 'continue this topic',
        chatId: 'chat_1',
        scopeId: 'chat_1#thread:thread_1',
        threadId: 'thread_1',
        replyInThread: true,
      });

      await adapter.stop();
    });

    it('keeps group topic replies that only mention the current bot for reaction handling', async () => {
      await adapter.start();

      await mockEventHandler({
        message: {
          message_id: 'msg_group_topic_empty_mention',
          chat_id: 'chat_1',
          chat_type: 'group',
          thread_id: 'thread_1',
          message_type: 'text',
          content: JSON.stringify({ text: '@_user_1 ' }),
          root_id: 'msg_root',
          mentions: [
            {
              key: '@_user_1',
              id: { open_id: 'ou_bot' },
              name: 'openclaw',
            },
          ],
        },
        sender: { sender_id: { user_id: 'user_1', open_id: 'ou_123' } },
      });

      expect(await adapter.consumeOne()).toMatchObject({
        text: '',
        chatId: 'chat_1',
        scopeId: 'chat_1#thread:thread_1',
        threadId: 'thread_1',
        replyInThread: true,
      });

      await adapter.stop();
    });

    it('uses open_id when user_id is empty', async () => {
      await adapter.start();

      await mockEventHandler({
        message: {
          message_id: 'msg_1', chat_id: 'chat_1',
          message_type: 'text',
          content: JSON.stringify({ text: 'hi' }),
        },
        sender: { sender_id: { user_id: '', open_id: 'ou_456' } },
      });

      const msg = await adapter.consumeOne();
      expect(msg!.userId).toBe('ou_456');

      await adapter.stop();
    });

    it('extracts replyToMessageId from parent_id or root_id', async () => {
      await adapter.start();

      await mockEventHandler({
        message: {
          message_id: 'msg_2', chat_id: 'chat_1',
          message_type: 'text',
          content: JSON.stringify({ text: 'reply' }),
          root_id: 'msg_parent',
        },
        sender: { sender_id: { user_id: 'user_1' } },
      });

      const msg = await adapter.consumeOne();
      expect(msg!.replyToMessageId).toBe('msg_parent');

      await adapter.stop();
    });

    it('maps Feishu topic messages to a logical scope and replies to the current message', async () => {
      await adapter.start();

      await mockEventHandler({
        message: {
          message_id: 'msg_topic_reply',
          chat_id: 'chat_1',
          thread_id: 'thread_abc',
          message_type: 'text',
          content: JSON.stringify({ text: 'topic message' }),
          root_id: 'msg_root',
        },
        sender: { sender_id: { user_id: 'user_1' } },
      });

      const msg = await adapter.consumeOne();
      expect(msg).toMatchObject({
        chatId: 'chat_1',
        scopeId: 'chat_1#thread:thread_abc',
        threadId: 'thread_abc',
        replyInThread: true,
        replyTargetMessageId: 'msg_topic_reply',
      });
      expect(msg!.replyToMessageId).toBeUndefined();

      await adapter.stop();
    });

    it('downloads image messages into attachments', async () => {
      await adapter.start();
      mockMessageResourceGet.mockResolvedValue(Buffer.from('fake-image'));

      await mockEventHandler({
        message: {
          message_id: 'msg_image',
          chat_id: 'chat_1',
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_key' }),
        },
        sender: { sender_id: { user_id: 'user_1' } },
      });

      const msg = await adapter.consumeOne();
      expect(msg).toMatchObject({
        text: '',
        messageId: 'msg_image',
      });
      expect(msg?.attachments).toHaveLength(1);
      expect(msg?.attachments?.[0]).toMatchObject({
        type: 'image',
        name: 'image.png',
        mimeType: 'image/png',
      });

      await adapter.stop();
    });

    it('downloads file messages with filename and inferred mime type', async () => {
      await adapter.start();
      mockV1MessageResourceGet.mockResolvedValue({ data: Buffer.from('hello from file') });

      await mockEventHandler({
        message: {
          message_id: 'msg_file',
          chat_id: 'chat_1',
          message_type: 'file',
          content: JSON.stringify({ file_key: 'file_key', file_name: 'notes.txt' }),
        },
        sender: { sender_id: { user_id: 'user_1' } },
      });

      const msg = await adapter.consumeOne();
      expect(msg).toMatchObject({
        text: '',
        messageId: 'msg_file',
      });
      expect(msg?.attachments).toHaveLength(1);
      expect(msg?.attachments?.[0]).toMatchObject({
        type: 'file',
        name: 'notes.txt',
        mimeType: 'text/plain',
        base64Data: Buffer.from('hello from file').toString('base64'),
      });

      await adapter.stop();
    });

    it('handles rich post messages containing image and text in one bubble', async () => {
      await adapter.start();
      mockMessageResourceGet.mockResolvedValue(Buffer.from('rich-image'));

      await mockEventHandler({
        message: {
          message_id: 'msg_post_image',
          chat_id: 'chat_1',
          message_type: 'post',
          content: JSON.stringify({
            content: [
              [{ tag: 'img', image_key: 'img_key' }],
              [{ tag: 'text', text: '你能访问这个图片内容吗，是什么？' }],
            ],
          }),
        },
        sender: { sender_id: { user_id: 'user_1' } },
      });

      const msg = await adapter.consumeOne();
      expect(msg).toMatchObject({
        text: '你能访问这个图片内容吗，是什么？',
        messageId: 'msg_post_image',
      });
      expect(msg?.attachments).toHaveLength(1);
      expect(msg?.attachments?.[0]).toMatchObject({
        type: 'image',
        name: 'image.png',
        mimeType: 'image/png',
        base64Data: Buffer.from('rich-image').toString('base64'),
      });

      await adapter.stop();
    });

    it('handles rich post messages containing file and text in one bubble', async () => {
      await adapter.start();
      mockV1MessageResourceGet.mockResolvedValue({ data: Buffer.from('rich file text') });

      await mockEventHandler({
        message: {
          message_id: 'msg_post_file',
          chat_id: 'chat_1',
          message_type: 'post',
          content: JSON.stringify({
            content: [
              [{ tag: 'file', file_key: 'file_key', file_name: 'rich.txt' }],
              [{ tag: 'text', text: '读取一下这个文件内容' }],
            ],
          }),
        },
        sender: { sender_id: { user_id: 'user_1' } },
      });

      const msg = await adapter.consumeOne();
      expect(msg).toMatchObject({
        text: '读取一下这个文件内容',
        messageId: 'msg_post_file',
      });
      expect(msg?.attachments).toHaveLength(1);
      expect(msg?.attachments?.[0]).toMatchObject({
        type: 'file',
        name: 'rich.txt',
        mimeType: 'text/plain',
        base64Data: Buffer.from('rich file text').toString('base64'),
      });

      await adapter.stop();
    });

    it('returns an empty object for card callbacks and enqueues callback data', async () => {
      await adapter.start();

      const handler = eventHandlers.get('card.action.trigger');
      expect(handler).toBeTypeOf('function');

      const result = await handler?.({
        operator: { user_id: 'user_1' },
        action: { value: { action: 'perm:allow:123' } },
        context: { chat_id: 'chat_1', open_message_id: 'om_123' },
      });

      expect(result).toEqual({
        toast: {
          type: 'success',
          content: '处理中...',
        },
      });

      const msg = await adapter.consumeOne();
      expect(msg).toMatchObject({
        channelType: 'feishu',
        chatId: 'chat_1',
        userId: 'user_1',
        callbackData: 'perm:allow:123',
        messageId: 'om_123',
      });

      await adapter.stop();
    });

    it('handles form submission with form_value', async () => {
      await adapter.start();

      const handler = eventHandlers.get('card.action.trigger');
      expect(handler).toBeTypeOf('function');

      const result = await handler?.({
        operator: { user_id: 'user_1' },
        action: { form_value: { _interaction_id: 'askq-123', _text_answer: 'my answer' } },
        context: { chat_id: 'chat_1', open_message_id: 'om_123' },
      });

      expect(result).toEqual({
        toast: {
          type: 'success',
          content: '已提交',
        },
      });

      const msg = await adapter.consumeOne();
      expect(msg).toMatchObject({
        channelType: 'feishu',
        chatId: 'chat_1',
        userId: 'user_1',
        messageId: 'om_123',
      });
      expect(msg!.callbackData).toBe(
        'form:askq-123:{"_interaction_id":"askq-123","_text_answer":"my answer"}',
      );

      await adapter.stop();
    });

    it('uses form submit action name when form_value has no interaction id', async () => {
      await adapter.start();

      const handler = eventHandlers.get('card.action.trigger');
      await handler?.({
        operator: { user_id: 'user_1' },
        action: {
          name: 'tlive_command',
          form_value: { _tlive_command: 'cd ..' },
        },
        context: { chat_id: 'chat_1', open_message_id: 'om_tlive' },
      });

      const msg = await adapter.consumeOne();
      expect(msg!.callbackData).toBe('form:tlive_command:{"_tlive_command":"cd .."}');

      await adapter.stop();
    });

    it('infers workbench command form from field names when action name is missing', async () => {
      await adapter.start();

      const handler = eventHandlers.get('card.action.trigger');
      await handler?.({
        operator: { user_id: 'user_1' },
        action: {
          form_value: { _tlive_command: 'cd ..' },
        },
        context: { chat_id: 'chat_1', open_message_id: 'om_tlive' },
      });

      const msg = await adapter.consumeOne();
      expect(msg!.callbackData).toBe('form:tlive_command:{"_tlive_command":"cd .."}');

      await adapter.stop();
    });

    it('prefers explicit form interaction id over action name', async () => {
      await adapter.start();

      const handler = eventHandlers.get('card.action.trigger');
      await handler?.({
        operator: { user_id: 'user_1' },
        action: {
          name: 'tlive_command',
          form_value: { _interaction_id: 'askq-789', _text_answer: 'ok' },
        },
        context: { chat_id: 'chat_1', open_message_id: 'om_789' },
      });

      const msg = await adapter.consumeOne();
      expect(msg!.callbackData).toBe(
        'form:askq-789:{"_interaction_id":"askq-789","_text_answer":"ok"}',
      );

      await adapter.stop();
    });

    it('handles form submission with select value', async () => {
      await adapter.start();

      const handler = eventHandlers.get('card.action.trigger');
      const result = await handler?.({
        operator: { user_id: 'user_1' },
        action: { form_value: { _interaction_id: 'askq-456', _select: 'Option A' } },
        context: { chat_id: 'chat_1', open_message_id: 'om_456' },
      });

      expect(result).toEqual({
        toast: {
          type: 'success',
          content: '已提交',
        },
      });

      const msg = await adapter.consumeOne();
      expect(msg!.callbackData).toBe(
        'form:askq-456:{"_interaction_id":"askq-456","_select":"Option A"}',
      );

      await adapter.stop();
    });

    it('maps application bot menu events to the workbench', async () => {
      await adapter.start();

      const handler = eventHandlers.get('application.bot.menu_v6');
      expect(handler).toBeTypeOf('function');

      for (const eventKey of ['tlive_home', 'tlive_status', 'tlive_help']) {
        const result = await handler?.({
          event_key: eventKey,
          operator: { operator_id: { user_id: 'user_1' } },
        });

        expect(result).toEqual({});

        const msg = await adapter.consumeOne();
        expect(msg).toMatchObject({
          channelType: 'feishu',
          chatId: '',
          userId: 'user_1',
          text: '/home',
        });
      }

      await adapter.stop();
    });

    it('ignores unknown application bot menu events', async () => {
      await adapter.start();

      const handler = eventHandlers.get('application.bot.menu_v6');
      expect(handler).toBeTypeOf('function');

      const result = await handler?.({
        event_key: 'tlive_unknown',
        operator: { operator_id: { user_id: 'user_1' } },
      });

      expect(result).toEqual({});
      expect(await adapter.consumeOne()).toBeNull();

      await adapter.stop();
    });
  });
});
