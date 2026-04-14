import { describe, expect, it } from 'vitest';
import {
  presentHelp,
  presentNewSession,
  presentPermissionStatus,
  presentSessions,
  presentStatus,
  presentHome,
  presentQueueStatus,
  presentDiagnose,
  presentUpgradeCommand,
} from '../../engine/messages/presenter.js';
import { TelegramFormatter } from '../../channels/telegram/formatter.js';
import { FeishuFormatter } from '../../channels/feishu/formatter.js';
import type { FormattableMessage } from '../../formatting/message-types.js';

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
        workspace: { cwd: '/home/user/project' },
        task: { active: true },
        session: {},
        permission: { mode: 'on' },
        bridge: {},
        help: { recentSummary: 'Working on feature X' },
      });
      expect(msg.type).toBe('home');
      if (msg.type === 'home') {
        expect(msg.data.workspace.cwd).toBe('/home/user/project');
        expect(msg.data.task.active).toBe(true);
      }
    });

    it('formats for Feishu with rich card', () => {
      const msg = presentHome('chat-1', {
        workspace: { cwd: '/home/user/project' },
        task: { active: false },
        permission: { mode: 'off' },
        bridge: { healthy: true },
        session: {
          recent: [
            { index: 1, date: '1月1日 12:00', preview: 'Recent task', isCurrent: true, cwd: '/home/user/project' },
          ],
        },
      });
      const formatted = feishuFormatter.format(msg);
      expect(formatted.feishuHeader?.template).toBe('blue');
      expect(formatted.feishuElements?.length).toBeGreaterThan(0);
    });
  });

  describe('presentPermissionStatus', () => {
    it('returns semantic message data', () => {
      const msg = presentPermissionStatus('chat-1', {
        mode: 'on',
        rememberedTools: 1,
        rememberedBashPrefixes: 2,
        pending: { toolName: 'Edit', input: 'src/main.ts' },
        lastDecision: { toolName: 'Bash', decision: 'allow_always' },
      });
      expect(msg.type).toBe('permissionStatus');
      if (msg.type === 'permissionStatus') {
        expect(msg.data.mode).toBe('on');
        expect(msg.data.rememberedBashPrefixes).toBe(2);
      }
    });

    it('formats for Feishu with action buttons', () => {
      const msg = presentPermissionStatus('chat-1', {
        mode: 'off',
        rememberedTools: 0,
        rememberedBashPrefixes: 0,
      });
      const formatted = feishuFormatter.format(msg);
      expect(formatted.feishuHeader?.title).toContain('权限状态');
      expect(formatted.feishuElements?.length).toBeGreaterThan(0);
    });
  });

  describe('presentQueueStatus', () => {
    it('returns semantic queue data without mutating payload', () => {
      const now = Date.now();
      const msg = presentQueueStatus('chat-1', {
        sessionKey: 'telegram:chat-1:/repo',
        depth: 2,
        maxDepth: 4,
        queuedMessages: [
          { preview: 'oldest', timestamp: now - 120_000 },
          { preview: 'newer', timestamp: now - 30_000 },
        ],
      });

      expect(msg.type).toBe('queueStatus');
      if (msg.type === 'queueStatus') {
        expect(msg.data.depth).toBe(2);
        expect(msg.data.saturationRatio).toBeUndefined();
        expect(msg.data.estimatedWaitSeconds).toBeUndefined();
        expect(msg.data.oldestQueuedAgeSeconds).toBeUndefined();
      }
    });
  });

  describe('presentDiagnose', () => {
    it('returns semantic diagnose data without mutating payload', () => {
      const msg = presentDiagnose('chat-1', {
        activeSessions: 2,
        idleSessions: 1,
        totalBubbleMappings: 4,
        queueStats: [
          { sessionKey: 's1', depth: 3, maxDepth: 3 },
          { sessionKey: 's2', depth: 1, maxDepth: 4 },
        ],
        totalQueuedMessages: 4,
        processingChats: 1,
      });

      expect(msg.type).toBe('diagnose');
      if (msg.type === 'diagnose') {
        expect(msg.data.queueStats).toHaveLength(2);
        expect(msg.data.saturatedSessions).toBeUndefined();
        expect(msg.data.queueUtilizationRatio).toBeUndefined();
        expect(msg.data.busiestSession).toBeUndefined();
      }
    });
  });

  describe('presentUpgradeCommand', () => {
    it('uses the Unix installer on linux-like platforms', () => {
      const msg = presentUpgradeCommand('chat-1', 'linux');
      expect(msg.text).toContain('install.sh');
      expect(msg.text).toContain('curl -fsSL');
    });

    it('uses the PowerShell installer on Windows', () => {
      const msg = presentUpgradeCommand('chat-1', 'win32');
      expect(msg.text).toContain('install.ps1');
      expect(msg.text).toContain('powershell -NoProfile');
    });
  });
});
