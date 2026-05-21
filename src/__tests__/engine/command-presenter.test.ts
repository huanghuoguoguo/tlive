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
import { FeishuFormatter } from '../../channels/feishu/formatter.js';
import { HELP_CATEGORIES } from '../../engine/commands/help-categories.js';

const feishuFormatter = new FeishuFormatter('zh');

function countFeishuTaggedElements(elements: any[]): number {
  let total = 0;
  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.tag === 'string') total += 1;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
      }
    }
  };
  for (const element of elements) visit(element);
  return total;
}

describe('command presenter', () => {
  describe('presentStatus', () => {
    it('returns semantic message data', () => {
      const msg = presentStatus('chat-1', {
        healthy: true,
        channels: ['feishu'],
      });
      expect(msg.type).toBe('status');
      expect(msg.chatId).toBe('chat-1');
      if (msg.type === 'status') {
        expect(msg.data.healthy).toBe(true);
        expect(msg.data.channels).toEqual(['feishu']);
      }
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
          { cmd: 'new', desc: 'New conversation', category: HELP_CATEGORIES.session },
          { cmd: 'status', desc: 'Show status', category: HELP_CATEGORIES.status },
        ],
      });
      expect(msg.type).toBe('help');
      if (msg.type === 'help') {
        expect(msg.data.commands).toHaveLength(2);
      }
    });

    it('formats for Feishu with buttons', () => {
      const msg = presentHelp('chat-1', {
        commands: [{ cmd: 'new', desc: 'New conversation', category: HELP_CATEGORIES.session }],
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

    it('keeps Feishu home card under the platform element limit', () => {
      const msg = presentHome('chat-1', {
        providers: {
          defaultKind: 'claude',
          available: [
            { kind: 'claude', displayName: 'Claude', available: true, isDefault: true },
            { kind: 'codex', displayName: 'Codex', available: true, isDefault: false },
          ],
          all: [],
        },
        workspace: { cwd: '/home/user/project' },
        task: { active: true },
        permission: { mode: 'on' },
        bridge: { healthy: true, channels: ['feishu'] },
        help: {
          entries: Array.from({ length: 12 }, (_, index) => ({
            cmd: `/cmd${index}`,
            desc: `Command ${index}`,
            category: HELP_CATEGORIES.session,
          })),
        },
        recentProjects: Array.from({ length: 5 }, (_, index) => ({
          name: `project-${index}`,
          workdir: `~/project-${index}`,
          fullWorkdir: `/home/user/project-${index}`,
          isCurrent: index === 0,
        })),
        session: {
          topics: Array.from({ length: 8 }, (_, index) => ({
            index: index + 1,
            sdkSessionId: `sdk-${index}`,
            scopeId: `chat-1#thread:thread-${index}`,
            threadId: `thread-${index}`,
            cwd: `/repo/topic-${index}`,
            title: `Topic ${index}`,
            preview: `Preview ${index}`,
            provider: index % 2 === 0 ? 'claude' : 'codex',
            providerDisplayName: index % 2 === 0 ? 'Claude' : 'Codex',
            updatedAt: '刚刚',
            isCurrent: index === 0,
            isActive: index === 1,
          })),
          recent: Array.from({ length: 10 }, (_, index) => ({
            index: index + 1,
            sdkSessionId: `recent-${index}`,
            date: '1月1日 12:00',
            cwd: `/repo/${index}`,
            preview: `Recent task ${index}`,
            isCurrent: false,
          })),
        },
      });

      const formatted = feishuFormatter.format(msg);
      expect(countFeishuTaggedElements(formatted.feishuElements ?? [])).toBeLessThanOrEqual(45);
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
        sessionKey: 'feishu:chat-1:/repo',
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

    it('formats queue status explicitly for Feishu', () => {
      const msg = presentQueueStatus('chat-1', {
        sessionKey: 'feishu:chat-1:session-1',
        depth: 1,
        maxDepth: 4,
        queuedMessages: [{ preview: 'queued prompt', timestamp: Date.now() - 60_000 }],
      });
      const formatted = feishuFormatter.format(msg);
      expect(formatted.feishuHeader?.title).toBe('📥 Queue Status');
      expect(JSON.stringify(formatted.feishuElements)).toContain('queued prompt');
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

    it('formats diagnose explicitly for Feishu', () => {
      const msg = presentDiagnose('chat-1', {
        activeSessions: 2,
        idleSessions: 1,
        totalBubbleMappings: 4,
        queueStats: [{ sessionKey: 's1', depth: 3, maxDepth: 3 }],
        totalQueuedMessages: 3,
        processingChats: 1,
        memoryUsage: '128MB',
      });
      const formatted = feishuFormatter.format(msg);
      expect(formatted.feishuHeader?.title).toBe('🩺 Diagnose');
      expect(JSON.stringify(formatted.feishuElements)).toContain('128MB');
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
