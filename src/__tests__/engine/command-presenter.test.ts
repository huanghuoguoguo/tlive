import { describe, expect, it } from 'vitest';
import {
  presentHome,
  presentDiagnose,
  presentUpgradeCommand,
} from '../../server/presentation/command-presenter.js';
import { FeishuFormatter } from '../../server/channels/feishu/formatter.js';
import { HELP_CATEGORIES } from '../../server/engine/commands/help-categories.js';

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

function findFirstTaggedElement(elements: any[], tag: string): any | undefined {
  for (const element of elements) {
    if (element?.tag === tag) return element;
    for (const value of Object.values(element ?? {})) {
      if (Array.isArray(value)) {
        const found = findFirstTaggedElement(value, tag);
        if (found) return found;
      }
    }
  }
  return undefined;
}

describe('command presenter', () => {
  describe('presentHome', () => {
    it('renders the workbench client controls without losing defaults', () => {
      const msg = presentHome('chat-1', {
        workspace: { cwd: '/home/user/project' },
        task: { active: false },
        permission: { mode: 'off' },
        bridge: { healthy: true },
        session: {
          topics: [
            {
              index: 1,
              sdkSessionId: 'sdk-local-1',
              scopeId: 'chat-1#thread:thread-1',
              threadId: 'thread-1',
              cwd: '/home/user/project',
              title: 'Local topic',
              preview: 'Topic preview',
              provider: 'claude',
              providerDisplayName: 'Claude',
              clientId: 'local',
              updatedAt: '刚刚',
              isCurrent: true,
              isActive: false,
            },
          ],
          recent: [
            {
              index: 1,
              date: '1月1日 12:00',
              preview: 'Recent task',
              isCurrent: true,
              cwd: '/home/user/project',
              clientId: 'local',
              provider: 'claude',
              providerDisplayName: 'Claude',
              sdkSessionId: 'recent-bound-topic',
              topic: {
                scopeId: 'chat-1#thread:thread-1',
                threadId: 'thread-1',
                updatedAt: '刚刚',
                isActive: false,
              },
            },
          ],
        },
        clients: {
          defaultClientId: 'local',
          entries: [
            {
              clientId: 'local',
              name: 'local',
              note: '开发机 · 本地 worker',
              online: true,
              isDefault: true,
              isLocal: true,
              activeTurns: 0,
              workspaces: [
                { path: '/home/user/project', isDefault: true },
                { path: '/home/user/other-project' },
              ],
              host: { hostname: 'devbox', ipAddresses: ['10.0.0.8'] },
              remoteAddress: '203.0.113.8',
              providers: [
                { kind: 'claude', displayName: 'Claude', available: true, isDefault: true },
              ],
            },
          ],
        },
      });
      const formatted = feishuFormatter.format(msg);
      expect(formatted.feishuHeader?.template).toBe('blue');
      expect(formatted.feishuElements?.[0]).toMatchObject({
        tag: 'markdown',
        content: expect.stringContaining('工作台'),
      });

      const rendered = JSON.stringify(formatted.feishuElements);
      expect(rendered).not.toContain('默认工作区');
      expect(rendered).not.toContain('状态:');
      expect(rendered).not.toContain('空闲');
      expect(rendered).toContain('local');
      expect(rendered).toContain('备注: 开发机 · 本地 worker');
      expect(rendered).toContain('默认目录: `/home/user/project`');
      expect(rendered).toContain('快捷目录: `/home/user/other-project`');
      expect(rendered).not.toContain('位置:');
      expect(rendered).not.toContain('203.0.113.8');
      expect(rendered).toContain('新建 Claude');
      expect(rendered).toContain('查看节点历史');
      expect(rendered).toContain('节点: `local`');
      expect(rendered).toContain('recent-');
      expect(rendered).toContain('回到话题');
      expect(rendered).not.toContain('设为默认');
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
            clientId: index % 2 === 0 ? 'local' : 'worker-1',
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

  describe('presentDiagnose', () => {
    it('renders persisted and memory-only diagnostic counters distinctly', () => {
      const msg = presentDiagnose('chat-1', {
        activeSessions: 2,
        idleSessions: 1,
        totalBubbleMappings: 4,
        persistedBindings: 3,
        persistedTopicSessions: 2,
        persistedTopicSessionsInChat: 1,
        queueStats: [{ sessionKey: 's1', depth: 3, maxDepth: 3 }],
        totalQueuedMessages: 3,
        processingChats: 1,
        memoryUsage: '128MB',
      });
      const formatted = feishuFormatter.format(msg);
      const rendered = JSON.stringify(formatted.feishuElements);
      expect(formatted.feishuHeader?.title).toBe('🩺 内部诊断');
      expect(rendered).toContain('会话');
      expect(rendered).toContain('排队消息');
      expect(rendered).toContain('卡片路由缓存');
      expect(rendered).toContain('持久化话题');
      expect(rendered).toContain('持久化绑定');
      expect(rendered).toContain('内存');
      expect(rendered).toContain('128MB');
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
