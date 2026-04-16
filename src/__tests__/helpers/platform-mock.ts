/**
 * Platform mock helpers for testing IM adapters (Telegram, Feishu, QQ Bot).
 * Provides reusable mock context factories and API response simulators.
 */

import { vi } from 'vitest';

// ── Telegram Mocks ──

export interface MockTelegramApi {
  sendMessage: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  sendChatAction: ReturnType<typeof vi.fn>;
  sendPhoto: ReturnType<typeof vi.fn>;
  sendDocument: ReturnType<typeof vi.fn>;
  getMe: ReturnType<typeof vi.fn>;
  setMyCommands: ReturnType<typeof vi.fn>;
  setMessageReaction: ReturnType<typeof vi.fn>;
  deleteWebhook: ReturnType<typeof vi.fn>;
  setWebhook: ReturnType<typeof vi.fn>;
  getFile: ReturnType<typeof vi.fn>;
}

export interface MockTelegramContext {
  from: { id: number; username?: string };
  chat: { id: number; type: 'private' | 'group' | 'supergroup' };
  message?: { message_id: number; text?: string; photo?: unknown };
  reply: ReturnType<typeof vi.fn>;
  api: MockTelegramApi;
}

export function createTelegramApiMocks(): MockTelegramApi {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
    editMessageText: vi.fn().mockResolvedValue({}),
    sendChatAction: vi.fn().mockResolvedValue(true),
    sendPhoto: vi.fn().mockResolvedValue({ message_id: 43 }),
    sendDocument: vi.fn().mockResolvedValue({ message_id: 44 }),
    getMe: vi.fn().mockResolvedValue({ id: 1, username: 'testbot', can_read_all_group_messages: true }),
    setMyCommands: vi.fn().mockResolvedValue(true),
    setMessageReaction: vi.fn().mockResolvedValue(true),
    deleteWebhook: vi.fn().mockResolvedValue(true),
    setWebhook: vi.fn().mockResolvedValue(true),
    getFile: vi.fn().mockResolvedValue({ file_path: 'photos/file.jpg' }),
  };
}

export function createTelegramContext(options?: {
  userId?: number;
  username?: string;
  chatId?: number;
  chatType?: 'private' | 'group' | 'supergroup';
  messageId?: number;
  text?: string;
}): MockTelegramContext {
  const api = createTelegramApiMocks();
  return {
    from: { id: options?.userId ?? 123, username: options?.username ?? 'testuser' },
    chat: { id: options?.chatId ?? 456, type: options?.chatType ?? 'private' },
    message: options?.text ? { message_id: options?.messageId ?? 1, text: options.text } : undefined,
    reply: vi.fn().mockResolvedValue({ message_id: 99 }),
    api,
  };
}

export function mockGrammy(api: MockTelegramApi, onHandler?: ReturnType<typeof vi.fn>): void {
  vi.mock('grammy', () => {
    class MockBot {
      api = api;
      on = onHandler ?? vi.fn();
      handleUpdate = vi.fn();
    }
    class InputFile {
      constructor(public data: unknown, public filename?: string) {}
    }
    return { Bot: MockBot, InputFile };
  });
}

// ── Feishu Mocks ──

export interface MockFeishuApi {
  messageCreate: ReturnType<typeof vi.fn>;
  messagePatch: ReturnType<typeof vi.fn>;
  imageGet: ReturnType<typeof vi.fn>;
  messageResourceGet: ReturnType<typeof vi.fn>;
}

export interface MockFeishuEvent {
  message: {
    message_id: string;
    chat_id: string;
    message_type: string;
    content: string;
    root_id?: string;
  };
  sender: { sender_id: { user_id: string; open_id: string } };
}

export function createFeishuApiMocks(): MockFeishuApi {
  return {
    messageCreate: vi.fn().mockResolvedValue({ data: { message_id: 'msg-feishu-1' } }),
    messagePatch: vi.fn().mockResolvedValue({}),
    imageGet: vi.fn().mockResolvedValue(null),
    messageResourceGet: vi.fn().mockResolvedValue(null),
  };
}

export function createFeishuEvent(options?: {
  messageId?: string;
  chatId?: string;
  content?: string;
  userId?: string;
  openId?: string;
  rootId?: string;
}): MockFeishuEvent {
  return {
    message: {
      message_id: options?.messageId ?? 'msg_1',
      chat_id: options?.chatId ?? 'chat_1',
      message_type: 'text',
      content: JSON.stringify({ text: options?.content ?? 'hello' }),
      root_id: options?.rootId,
    },
    sender: {
      sender_id: {
        user_id: options?.userId ?? 'user_1',
        open_id: options?.openId ?? 'ou_123',
      },
    },
  };
}

export function mockLarkSuite(api: MockFeishuApi): {
  eventHandlers: Map<string, (...args: unknown[]) => unknown>;
  mockEventHandler: ReturnType<typeof vi.fn>;
} {
  const eventHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const mockEventHandler = vi.fn(async (event: unknown) => {
    const handler = eventHandlers.get('im.message.receive_v1');
    if (handler) await handler(event);
  });

  vi.mock('@larksuiteoapi/node-sdk', () => {
    const MockClient = vi.fn(function (this: MockFeishuApi) {
      Object.assign(this, {
        im: {
          message: {
            create: api.messageCreate,
            patch: api.messagePatch,
          },
          v1: { messageResource: { get: vi.fn().mockResolvedValue({ data: null }) } },
          image: { get: api.imageGet },
          messageResource: { get: api.messageResourceGet },
        },
      });
    });

    const MockEventDispatcher = vi.fn(function (this: { register: ReturnType<typeof vi.fn>; invoke: ReturnType<typeof vi.fn> }) {
      this.register = vi.fn((handlers: Record<string, (...args: unknown[]) => unknown>) => {
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

    const MockWSClient = vi.fn(function (this: { close: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> }) {
      this.close = vi.fn();
      this.start = vi.fn().mockResolvedValue(undefined);
    });

    return {
      Client: MockClient,
      EventDispatcher: MockEventDispatcher,
      WSClient: MockWSClient,
    };
  });

  return { eventHandlers, mockEventHandler };
}

// ── QQ Bot Mocks ──

export interface MockQQBotWsPayload {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}

export interface MockQQBotMessageEvent {
  id: string;
  content: string;
  timestamp: string;
  author: { id: string; member_openid?: string; user_openid?: string };
  group_openid?: string;
  channel_id?: string;
  attachments?: Array<{ content_type: string; url: string; filename?: string }>;
}

export function createQQBotMessageEvent(options?: {
  id?: string;
  content?: string;
  authorId?: string;
  memberOpenid?: string;
  userOpenid?: string;
  groupOpenid?: string;
  channelId?: string;
}): MockQQBotMessageEvent {
  return {
    id: options?.id ?? 'msg-1',
    content: options?.content ?? 'hello',
    timestamp: '2026-04-01T00:00:00Z',
    author: {
      id: options?.authorId ?? 'author-1',
      member_openid: options?.memberOpenid,
      user_openid: options?.userOpenid ?? 'user-1',
    },
    group_openid: options?.groupOpenid,
    channel_id: options?.channelId,
  };
}

// ── Error Simulation Helpers ──

export function simulateRateLimit(api: MockTelegramApi | MockFeishuApi): void {
  if ('sendMessage' in api) {
    api.sendMessage.mockRejectedValueOnce({
      error_code: 429,
      description: 'Too Many Requests',
      parameters: { retry_after: 5 },
    });
  } else {
    api.messageCreate.mockRejectedValueOnce(new Error('Rate limited'));
  }
}

export function simulateAuthError(api: MockTelegramApi | MockFeishuApi): void {
  if ('sendMessage' in api) {
    api.sendMessage.mockRejectedValueOnce({
      error_code: 401,
      description: 'Unauthorized',
    });
  } else {
    api.messageCreate.mockRejectedValueOnce(new Error('Unauthorized'));
  }
}

export function simulateNetworkError(api: MockTelegramApi | MockFeishuApi): void {
  if ('sendMessage' in api) {
    api.sendMessage.mockRejectedValueOnce(new Error('ECONNREFUSED'));
  } else {
    api.messageCreate.mockRejectedValueOnce(new Error('ECONNREFUSED'));
  }
}