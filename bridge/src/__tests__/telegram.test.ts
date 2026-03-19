import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the telegram bot before importing
vi.mock('node-telegram-bot-api', () => {
  const MockBot = vi.fn(function (this: any) {
    this.on = vi.fn();
    this.sendMessage = vi.fn().mockResolvedValue({ message_id: 42 });
    this.editMessageText = vi.fn().mockResolvedValue({});
    this.stopPolling = vi.fn().mockResolvedValue(undefined);
    this.sendChatAction = vi.fn().mockResolvedValue(true);
  });
  return { default: MockBot };
});

import { TelegramAdapter } from '../channels/telegram.js';

describe('TelegramAdapter', () => {
  let adapter: TelegramAdapter;

  beforeEach(() => {
    adapter = new TelegramAdapter({
      botToken: 'test-token',
      chatId: '12345',
      allowedUsers: ['user1', 'user2'],
    });
  });

  it('has correct channel type', () => {
    expect(adapter.channelType).toBe('telegram');
  });

  it('validates config — requires botToken', () => {
    const bad = new TelegramAdapter({ botToken: '', chatId: '', allowedUsers: [] });
    expect(bad.validateConfig()).toContain('TL_TG_BOT_TOKEN');
  });

  it('validates config — passes with token', () => {
    expect(adapter.validateConfig()).toBeNull();
  });

  it('authorizes allowed users', () => {
    expect(adapter.isAuthorized('user1', '12345')).toBe(true);
    expect(adapter.isAuthorized('unknown', '12345')).toBe(false);
  });

  it('authorizes all users when allowedUsers is empty', () => {
    const openAdapter = new TelegramAdapter({ botToken: 'tok', chatId: '', allowedUsers: [] });
    expect(openAdapter.isAuthorized('anyone', 'anychat')).toBe(true);
  });

  it('sends message with HTML parse mode', async () => {
    await adapter.start();
    const result = await adapter.send({ chatId: '12345', html: '<b>hello</b>' });
    expect(result.success).toBe(true);
    expect(result.messageId).toBe('42');
  });

  it('sends message with buttons as inline keyboard', async () => {
    await adapter.start();
    const result = await adapter.send({
      chatId: '12345',
      text: 'Choose:',
      buttons: [
        { label: 'Allow', callbackData: 'perm:allow:123' },
        { label: 'Deny', callbackData: 'perm:deny:123', style: 'danger' },
      ],
    });
    expect(result.success).toBe(true);
  });

  describe('sendTyping', () => {
    it('calls sendChatAction with typing', async () => {
      await adapter.start();
      await adapter.sendTyping('12345');
      const bot = (adapter as any).bot;
      expect(bot.sendChatAction).toHaveBeenCalledWith('12345', 'typing');
    });

    it('swallows errors from sendChatAction', async () => {
      await adapter.start();
      const bot = (adapter as any).bot;
      bot.sendChatAction.mockRejectedValueOnce(new Error('network error'));
      await expect(adapter.sendTyping('12345')).resolves.toBeUndefined();
    });
  });

  describe('editMessage error guard', () => {
    it('ignores "message is not modified" error', async () => {
      await adapter.start();
      const bot = (adapter as any).bot;
      bot.editMessageText.mockRejectedValueOnce(new Error('message is not modified'));
      await expect(
        adapter.editMessage('12345', '42', { chatId: '12345', text: 'same' })
      ).resolves.toBeUndefined();
    });

    it('rethrows other errors', async () => {
      await adapter.start();
      const bot = (adapter as any).bot;
      bot.editMessageText.mockRejectedValueOnce(new Error('rate limited'));
      await expect(
        adapter.editMessage('12345', '42', { chatId: '12345', text: 'new' })
      ).rejects.toThrow('rate limited');
    });
  });
});
