import { describe, expect, it } from 'vitest';
import {
  presentHome,
  presentDiagnose,
  presentHelp,
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
              sdkSessionId: 'sdk-local-1',
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
              version: '0.14.1',
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
      expect(rendered).toContain('当前目录: `/home/user/project`');
      expect(rendered).toContain('刷新');
      expect(rendered).toContain('action:home-refresh:main');
      expect(rendered).toContain('local');
      expect(rendered).not.toContain('备注: 开发机 · 本地 worker');
      expect(rendered).not.toContain('默认目录: `/home/user/project`');
      expect(rendered).not.toContain('快捷目录:');
      expect(rendered).not.toContain('版本:');
      expect(rendered).not.toContain('位置:');
      expect(rendered).not.toContain('203.0.113.8');
      expect(rendered).toContain('新建 Claude');
      expect(rendered).toContain('action:new:claude:local');
      expect(rendered).toContain('节点');
      expect(rendered).toContain('action:home-view:nodes');
      expect(rendered).toContain('最近会话');
      expect(rendered).toContain('action:home-view:recent');
      expect(rendered).toContain('目录');
      expect(rendered).toContain('action:home-view:files');
      expect(rendered).not.toContain('最近会话话题');
      expect(rendered).not.toContain('查看最近会话');
      expect(rendered).not.toContain('Recent task');
      expect(rendered).not.toContain('回到话题');
      expect(rendered).toContain('帮助');
      expect(rendered).toContain('action:home-view:help');
      expect(rendered).toContain('诊断');
      expect(rendered).toContain('action:home-view:diagnostics');
      expect(rendered).not.toContain('设为默认');
    });

    it('renders node details as an in-place panel view', () => {
      const msg = presentHome('chat-1', {
        view: 'nodes',
        workspace: { cwd: '/home/user/project' },
        task: { active: false },
        permission: { mode: 'off' },
        bridge: { healthy: true },
        session: {},
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
              version: '0.14.1',
              workspaces: [
                { path: '/home/user/project', isDefault: true },
                { path: '/home/user/other-project' },
              ],
              providers: [
                { kind: 'claude', displayName: 'Claude', available: true, isDefault: true },
              ],
            },
          ],
        },
      });

      const formatted = feishuFormatter.format(msg);
      const rendered = JSON.stringify(formatted.feishuElements);
      expect(rendered).toContain('执行节点');
      expect(rendered).toContain('返回');
      expect(rendered).toContain('action:home-view:main');
      expect(rendered).toContain('action:home-refresh:nodes');
      expect(rendered).toContain('备注: 开发机 · 本地 worker');
      expect(rendered).not.toContain('默认目录: `/home/user/project`');
      expect(rendered).toContain('节点历史');
      expect(rendered).toContain('action:home-history:local');
      expect(rendered).not.toContain('快捷目录:');
      expect(rendered).not.toContain('版本:');
    });

    it('renders the directory panel with clickable folders', () => {
      const msg = presentHome('chat-1', {
        view: 'files',
        workspace: {
          cwd: '/home/user/project',
          directory: {
            path: '/home/user/project',
            displayPath: '/home/user/project',
            source: 'client',
            clientId: 'local',
            parent: '/home/user',
            entries: [
              { name: 'src', path: '/home/user/project/src', kind: 'directory' },
              { name: 'README.md', path: '/home/user/project/README.md', kind: 'file' },
            ],
          },
        },
        task: { active: false },
        permission: { mode: 'off' },
        bridge: { healthy: true },
        session: {},
        clients: { defaultClientId: 'local', entries: [] },
      });

      const formatted = feishuFormatter.format(msg);
      const rendered = JSON.stringify(formatted.feishuElements);
      expect(rendered).toContain('目录');
      expect(rendered).toContain('当前目录: `/home/user/project`');
      expect(rendered).toContain('节点: `local`');
      expect(rendered).toContain('上级目录');
      expect(rendered).toContain('action:home-dir:%2Fhome%2Fuser');
      expect(rendered).toContain('📁 src');
      expect(rendered).toContain('action:home-dir:%2Fhome%2Fuser%2Fproject%2Fsrc');
      expect(rendered).toContain('README.md');
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

  describe('presentHelp', () => {
    it('does not show a new-session shortcut button in help', () => {
      const msg = presentHelp('chat-1', {
        commands: [
          {
            cmd: 'home',
            desc: '打开工作台',
            category: HELP_CATEGORIES.status,
          },
        ],
      });

      const formatted = feishuFormatter.format(msg);
      const rendered = JSON.stringify(formatted);
      expect(rendered).not.toContain('新会话');
      expect(rendered).not.toContain('tlive:action:new');
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
