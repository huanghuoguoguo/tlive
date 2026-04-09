import { describe, expect, it } from 'vitest';
import { presentHelp, presentNewSession, presentSessions, presentStatus, presentHome } from '../engine/command-presenter.js';
import { TelegramFormatter } from '../formatting/telegram-formatter.js';
import { FeishuFormatter } from '../formatting/feishu-formatter.js';
import type { FormattableMessage } from '../formatting/message-types.js';

describe('command presenter', () => {
  const telegramFormatter = new TelegramFormatter('en');
  const feishuFormatter = new FeishuFormatter('zh');

  describe('presentStatus', () => {
    it('returns semantic message data', () => {
      const msg = presentStatus('chat-1', {
        healthy: true,
        channels: ['telegram', 'feishu'],
      });
      expect(msg.type).toBe('status');
      expect(msg.chatId).toBe('chat-1');
      if (msg.type === 'status') {
        expect(msg.data.healthy).toBe(true);
        expect(msg.data.channels).toEqual(['telegram', 'feishu']);
      }
    });

    it('formats correctly for Telegram', () => {
      const msg = presentStatus('chat-1', { healthy: true, channels: ['telegram'] });
      const formatted = telegramFormatter.format(msg);
      expect(formatted.html).toContain('TLive Status');
      expect(formatted.html).toContain('telegram');
    });

    it('formats correctly for Feishu', () => {
      const msg = presentStatus('chat-1', { healthy: true, channels: ['feishu'] });
      const formatted = feishuFormatter.format(msg);
      expect(formatted.feishuHeader?.title).toContain('TLive');
    });
  });

  describe('presentNewSession', () => {
    it('returns semantic message data', () => {
      const msg = presentNewSession('chat-1', { cwd: '/home/user/project' });
      expect(msg.type).toBe('newSession');
      expect(msg.chatId).toBe('chat-1');
      if (msg.type === 'newSession') {
        expect(msg.data.cwd).toBe('/home/user/project');
      }
    });

    it('formats for Telegram', () => {
      const msg = presentNewSession('chat-1', { cwd: '/home/user/project' });
      const formatted = telegramFormatter.format(msg);
      expect(formatted.html).toContain('New Session');
    });

    it('formats for Feishu', () => {
      const msg = presentNewSession('chat-1', { cwd: '/home/user/project' });
      const formatted = feishuFormatter.format(msg);
      expect(formatted.feishuHeader?.template).toBe('green');
    });
  });

  describe('presentSessions', () => {
    it('returns semantic message data', () => {
      const msg = presentSessions('chat-1', {
        sessions: [
          { index: 1, date: 'Jan 1', cwd: '/project', size: '1KB', preview: 'test', isCurrent: true },
        ],
        filterHint: ' (project)',
      });
      expect(msg.type).toBe('sessions');
      if (msg.type === 'sessions') {
        expect(msg.data.sessions).toHaveLength(1);
        expect(msg.data.sessions[0].isCurrent).toBe(true);
      }
    });

    it('formats for Feishu with buttons', () => {
      const msg = presentSessions('chat-1', {
        sessions: [
          { index: 1, date: 'Jan 1', cwd: '/project', size: '1KB', preview: 'test', isCurrent: false },
          { index: 2, date: 'Jan 2', cwd: '/other', size: '2KB', preview: 'other', isCurrent: true },
        ],
        filterHint: ' (all)',
      });
      const formatted = feishuFormatter.format(msg);
      expect(formatted.feishuHeader?.template).toBe('blue');
      // Feishu puts buttons in feishuElements
      expect(formatted.feishuElements?.length).toBeGreaterThan(0);
    });
  });

  describe('presentHelp', () => {
    it('returns semantic message data', () => {
      const msg = presentHelp('chat-1', {
        commands: [
          { cmd: 'new', desc: 'New conversation' },
          { cmd: 'status', desc: 'Show status' },
        ],
      });
      expect(msg.type).toBe('help');
      if (msg.type === 'help') {
        expect(msg.data.commands).toHaveLength(2);
      }
    });

    it('formats for Telegram', () => {
      const msg = presentHelp('chat-1', {
        commands: [{ cmd: 'new', desc: 'New conversation' }],
      });
      const formatted = telegramFormatter.format(msg);
      expect(formatted.html).toContain('/new');
    });

    it('formats for Feishu with buttons', () => {
      const msg = presentHelp('chat-1', {
        commands: [{ cmd: 'new', desc: 'New conversation' }],
      });
      const formatted = feishuFormatter.format(msg);
      expect(formatted.feishuHeader?.template).toBe('blue');
      // Feishu puts buttons in feishuElements
      expect(formatted.feishuElements?.length).toBeGreaterThan(0);
    });
  });

  describe('presentHome', () => {
    it('returns semantic message data', () => {
      const msg = presentHome('chat-1', {
        cwd: '/home/user/project',
        hasActiveTask: true,
        recentSummary: 'Working on feature X',
      });
      expect(msg.type).toBe('home');
      if (msg.type === 'home') {
        expect(msg.data.cwd).toBe('/home/user/project');
        expect(msg.data.hasActiveTask).toBe(true);
      }
    });

    it('formats for Feishu with rich card', () => {
      const msg = presentHome('chat-1', {
        cwd: '/home/user/project',
        hasActiveTask: false,
      });
      const formatted = feishuFormatter.format(msg);
      expect(formatted.feishuHeader?.template).toBe('indigo');
      expect(formatted.feishuElements?.length).toBeGreaterThan(0);
    });
  });
});