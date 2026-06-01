import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @larksuiteoapi/node-sdk before importing the adapter
const mockMessageCreate = vi.fn();
const mockMessageReply = vi.fn();
const mockMessagePatch = vi.fn().mockResolvedValue({});
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
import { RateLimitError } from '../../server/channels/errors.js';

describe('FeishuAdapter', () => {
  let adapter: FeishuAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessageCreate.mockResolvedValue({ data: { message_id: 'msg-feishu-1' } });
    mockMessageReply.mockResolvedValue({ data: { message_id: 'msg-feishu-reply-1' } });
    mockMessagePatch.mockResolvedValue({});
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
