import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../../formatting/escape.js';
import { TelegramFormatter } from '../../channels/telegram/formatter.js';
import type { NotificationData, HomeData, ErrorData } from '../../formatting/message-types.js';

describe('escapeHtml', () => {
  it('escapes ampersand', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes less-than', () => {
    expect(escapeHtml('a < b')).toBe('a &lt; b');
  });

  it('escapes greater-than', () => {
    expect(escapeHtml('a > b')).toBe('a &gt; b');
  });

  it('escapes all special chars together', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert("xss")&lt;/script&gt;');
  });

  it('returns empty string unchanged', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('returns plain text unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

describe('TelegramFormatter', () => {
  const formatter = new TelegramFormatter('en');

  describe('formatNotification', () => {
    it('formats generic notification with title and summary', () => {
      const data: NotificationData = {
        type: 'generic',
        title: 'Test Title',
        summary: 'Test summary content',
      };
      const result = formatter.formatNotification('chat123', data);

      expect(result.chatId).toBe('chat123');
      expect(result.html).toContain('Test Title');
      expect(result.html).toContain('Test summary content');
    });

    it('formats stop notification with emoji', () => {
      const data: NotificationData = {
        type: 'stop',
        title: 'Task Complete',
      };
      const result = formatter.formatNotification('chat123', data);

      expect(result.html).toContain('✅');
      expect(result.html).toContain('Task Complete');
    });

    it('truncates long summary', () => {
      const longSummary = 'x'.repeat(5000);
      const data: NotificationData = {
        type: 'generic',
        title: 'Test',
        summary: longSummary,
      };
      const result = formatter.formatNotification('chat123', data);

      expect(result.html!.length).toBeLessThan(5000);
    });
  });

  describe('formatHome', () => {
    it('formats home with workspace info', () => {
      const data: HomeData = {
        workspace: { cwd: '/home/user/project' },
        task: { active: false },
        session: {},
        permission: { mode: 'on' },
        bridge: {},
      };
      const result = formatter.formatHome('chat123', data);

      expect(result.chatId).toBe('chat123');
      expect(result.html!).toContain('/home/user/project');
    });
  });

  describe('formatError', () => {
    it('formats error with title and message', () => {
      const data: ErrorData = {
        title: 'Connection Failed',
        message: 'Unable to reach server',
      };
      const result = formatter.formatError('chat123', data);

      expect(result.chatId).toBe('chat123');
      expect(result.html).toContain('Connection Failed');
      expect(result.html).toContain('Unable to reach server');
    });
  });

  describe('getLocale', () => {
    it('returns configured locale', () => {
      expect(formatter.getLocale()).toBe('en');
    });

    it('returns zh locale for zh formatter', () => {
      const zhFormatter = new TelegramFormatter('zh');
      expect(zhFormatter.getLocale()).toBe('zh');
    });
  });
});