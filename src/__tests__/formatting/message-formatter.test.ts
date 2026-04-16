import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../../formatting/escape.js';
import { TelegramFormatter } from '../../channels/telegram/formatter.js';
import type {
  NotificationData, HomeData, ErrorData, StatusData,
  PermissionData, QuestionData, TaskStartData, SessionsData,
  SessionDetailData, HelpData, ProgressData, TaskSummaryData,
  QueueStatusData, DiagnoseData, ProjectListData, ProjectInfoData,
} from '../../formatting/message-types.js';

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
  const zhFormatter = new TelegramFormatter('zh');

  describe('formatNotification', () => {
    it('formats generic notification with title and summary', () => {
      const data = {
        type: 'generic' as const,
        title: 'Test Title',
        summary: 'Test summary content',
      };
      const result = formatter.formatNotification('chat123', data);

      expect(result.chatId).toBe('chat123');
      expect(result.html).toContain('Test Title');
      expect(result.html).toContain('Test summary content');
    });

    it('formats stop notification with emoji', () => {
      const data = {
        type: 'stop' as const,
        title: 'Task Complete',
      };
      const result = formatter.formatNotification('chat123', data);

      expect(result.html).toContain('✅');
      expect(result.html).toContain('Task Complete');
    });

    it('formats idle_prompt notification', () => {
      const data = {
        type: 'idle_prompt' as const,
        title: 'Waiting for input',
      };
      const result = formatter.formatNotification('chat123', data);

      expect(result.html).toContain('⏳');
    });

    it('truncates long summary', () => {
      const longSummary = 'x'.repeat(5000);
      const data = {
        type: 'generic' as const,
        title: 'Test',
        summary: longSummary,
      };
      const result = formatter.formatNotification('chat123', data);

      expect(result.html!.length).toBeLessThan(5000);
    });

    it('uses URL button for public terminal URL', () => {
      const data = {
        type: 'generic' as const,
        title: 'Test',
        terminalUrl: 'https://example.com/terminal',
      };
      const result = formatter.formatNotification('chat123', data);

      expect(result.buttons).toBeDefined();
      expect(result.buttons!.some(b => b.url)).toBe(true);
    });

    it('uses inline link for localhost terminal URL', () => {
      const data = {
        type: 'generic' as const,
        title: 'Test',
        terminalUrl: 'http://localhost:8080/terminal',
      };
      const result = formatter.formatNotification('chat123', data);

      expect(result.html).toContain('localhost');
    });
  });

  describe('formatHome', () => {
    it('formats home with workspace info', () => {
      const data = {
        workspace: { cwd: '/home/user/project' },
        task: { active: false },
        session: {},
        permission: { mode: 'on' as const },
        bridge: {},
      };
      const result = formatter.formatHome('chat123', data);

      expect(result.chatId).toBe('chat123');
      expect(result.html).toContain('/home/user/project');
    });

    it('shows task status label', () => {
      const data = {
        workspace: { cwd: '/tmp' },
        task: { active: true },
        session: {},
        permission: { mode: 'off' as const },
        bridge: {},
      };
      const result = formatter.formatHome('chat123', data);

      expect(result.html).toContain('Status');
    });

    it('shows recent summary when provided', () => {
      const data = {
        workspace: { cwd: '/tmp' },
        task: { active: false },
        session: {},
        permission: { mode: 'on' as const },
        bridge: {},
        help: { recentSummary: 'Previous task completed' },
      };
      const result = formatter.formatHome('chat123', data);

      expect(result.html).toContain('Previous task');
    });
  });

  describe('formatError', () => {
    it('formats error with title and message', () => {
      const data = {
        title: 'Connection Failed',
        message: 'Unable to reach server',
      };
      const result = formatter.formatError('chat123', data);

      expect(result.chatId).toBe('chat123');
      expect(result.html).toContain('Connection Failed');
      expect(result.html).toContain('Unable to reach server');
    });
  });

  describe('formatStatus', () => {
    it('formats healthy status', () => {
      const data = {
        healthy: true,
        channels: ['telegram'],
      };
      const result = formatter.formatStatus('chat123', data);

      expect(result.html).toContain('running');
      expect(result.html).toContain('telegram');
    });

    it('formats disconnected status', () => {
      const data = {
        healthy: false,
        channels: [],
      };
      const result = formatter.formatStatus('chat123', data);

      expect(result.html).toContain('disconnected');
    });

    it('shows channel info with bot name', () => {
      const data = {
        healthy: true,
        channels: [],
        channelInfo: [{ type: 'telegram', name: 'testbot' }],
      };
      const result = formatter.formatStatus('chat123', data);

      expect(result.html).toContain('@testbot');
    });

    it('shows memory and uptime', () => {
      const data = {
        healthy: true,
        channels: [],
        memoryUsage: '50MB',
        uptimeSeconds: 3600,
      };
      const result = formatter.formatStatus('chat123', data);

      expect(result.html).toContain('50MB');
      expect(result.html).toContain('1h');
    });

    it('shows version and cwd', () => {
      const data = {
        healthy: true,
        channels: [],
        version: '1.0.0',
        cwd: '/home/user',
      };
      const result = formatter.formatStatus('chat123', data);

      expect(result.html).toContain('v1.0.0');
      expect(result.html).toContain('/home/user');
    });
  });

  describe('formatPermission', () => {
    it('formats permission request with tool name', () => {
      const data = {
        toolName: 'Bash',
        toolInput: 'ls -la',
        permissionId: 'perm-123',
      };
      const result = formatter.formatPermission('chat123', data);

      expect(result.html).toContain('Bash');
      expect(result.html).toContain('ls -la');
      expect(result.buttons).toBeDefined();
    });

    it('includes terminal URL when provided', () => {
      const data = {
        toolName: 'Read',
        toolInput: 'file.txt',
        permissionId: 'perm-456',
        terminalUrl: 'https://terminal.example.com',
      };
      const result = formatter.formatPermission('chat123', data);

      expect(result.html).toContain('terminal.example.com');
    });
  });

  describe('formatQuestion', () => {
    it('formats single select question', () => {
      const data = {
        question: 'Choose an option',
        header: 'Options',
        options: [
          { label: 'Option A', description: 'First choice' },
          { label: 'Option B' },
        ],
        multiSelect: false,
        permId: 'q-123',
        sessionId: 'sess-1',
      };
      const result = formatter.formatQuestion('chat123', data);

      expect(result.html).toContain('Choose an option');
      expect(result.html).toContain('Option A');
      expect(result.buttons).toBeDefined();
    });

    it('formats multi select question', () => {
      const data = {
        question: 'Select multiple',
        options: [{ label: 'A' }, { label: 'B' }],
        multiSelect: true,
        permId: 'q-456',
        sessionId: 'sess-1',
      };
      const result = formatter.formatQuestion('chat123', data);

      expect(result.html).toContain('Select');
      expect(result.buttons!.length).toBeGreaterThan(2);
    });
  });

  describe('formatTaskStart', () => {
    it('formats new session task start', () => {
      const data = {
        cwd: '/home/user/project',
        permissionMode: 'on' as const,
        isNewSession: true,
      };
      const result = formatter.formatTaskStart('chat123', data);

      expect(result.html).toContain('/home/user/project');
    });

    it('shows previous session preview', () => {
      const data = {
        cwd: '/tmp',
        permissionMode: 'off' as const,
        isNewSession: false,
        previousSessionPreview: 'Previous task summary',
      };
      const result = formatter.formatTaskStart('chat123', data);

      expect(result.html).toContain('Previous');
    });
  });

  describe('formatSessions', () => {
    it('formats session list', () => {
      const data = {
        sessions: [
          { index: 1, date: '2026-04-01', cwd: '/tmp', size: '5KB', preview: 'test', isCurrent: false },
        ],
        filterHint: '',
      };
      const result = formatter.formatSessions('chat123', data);

      expect(result.html).toContain('Sessions');
      expect(result.html).toContain('/tmp');
    });

    it('marks current session', () => {
      const data = {
        sessions: [
          { index: 1, date: '2026-04-01', cwd: '/tmp', size: '5KB', preview: 'test', isCurrent: true },
        ],
        filterHint: '',
      };
      const result = formatter.formatSessions('chat123', data);

      expect(result.html).toContain('◀');
    });
  });

  describe('formatSessionDetail', () => {
    it('formats session detail with transcript', () => {
      const data = {
        index: 1,
        cwd: '/tmp',
        date: '2026-04-01',
        size: '10KB',
        preview: 'test session',
        transcript: [
          { role: 'user', text: 'Hello' },
          { role: 'assistant', text: 'Hi there' },
        ],
      };
      const result = formatter.formatSessionDetail('chat123', data);

      expect(result.html).toContain('Session #1');
      expect(result.html).toContain('Hello');
    });
  });

  describe('formatHelp', () => {
    it('formats help commands list', () => {
      const data = {
        commands: [
          { cmd: 'home', desc: 'Show home screen' },
          { cmd: 'new', desc: 'Start new session' },
        ],
      };
      const result = formatter.formatHelp('chat123', data);

      expect(result.html).toContain('/home');
      expect(result.html).toContain('Show home screen');
    });
  });

  describe('formatProgress', () => {
    it('formats starting phase', () => {
      const data = {
        phase: 'starting' as const,
        taskSummary: 'Running task',
        elapsedSeconds: 0,
        renderedText: '',
        todoItems: [],
        totalTools: 0,
      };
      const result = formatter.formatProgress('chat123', data);

      expect(result.html).toContain('Starting');
      expect(result.html).toContain('Running task');
    });

    it('formats executing phase', () => {
      const data = {
        phase: 'executing' as const,
        taskSummary: 'Processing',
        elapsedSeconds: 10,
        renderedText: '',
        todoItems: [],
        totalTools: 0,
      };
      const result = formatter.formatProgress('chat123', data);

      expect(result.html).toContain('Running');
      expect(result.html).toContain('10s');
    });

    it('formats completed phase', () => {
      const data = {
        phase: 'completed' as const,
        taskSummary: 'Done',
        elapsedSeconds: 30,
        renderedText: '',
        todoItems: [],
        totalTools: 0,
      };
      const result = formatter.formatProgress('chat123', data);

      expect(result.html).toContain('Completed');
    });

    it('formats failed phase', () => {
      const data = {
        phase: 'failed' as const,
        taskSummary: 'Error occurred',
        elapsedSeconds: 5,
        renderedText: '',
        todoItems: [],
        totalTools: 0,
      };
      const result = formatter.formatProgress('chat123', data);

      expect(result.html).toContain('Failed');
    });

    it('formats waiting_permission phase', () => {
      const data = {
        phase: 'waiting_permission' as const,
        taskSummary: 'Waiting',
        elapsedSeconds: 2,
        renderedText: '',
        todoItems: [],
        totalTools: 0,
      };
      const result = formatter.formatProgress('chat123', data);

      expect(result.html).toContain('Waiting for permission');
    });

    it('uses renderedText when provided', () => {
      const data = {
        phase: 'executing' as const,
        taskSummary: 'Processing',
        elapsedSeconds: 10,
        renderedText: 'Custom rendered content here',
        todoItems: [],
        totalTools: 0,
      };
      const result = formatter.formatProgress('chat123', data);

      expect(result.html).toContain('Custom rendered');
    });

    it('shows API retry indicator', () => {
      const data = {
        phase: 'executing' as const,
        taskSummary: 'Processing',
        elapsedSeconds: 10,
        renderedText: 'Content',
        todoItems: [],
        totalTools: 0,
        apiRetry: { attempt: 2, maxRetries: 3, retryDelayMs: 1000, error: 'timeout' },
      };
      const result = formatter.formatProgress('chat123', data);

      expect(result.html).toContain('API retry');
    });

    it('shows compacting indicator', () => {
      const data = {
        phase: 'executing' as const,
        taskSummary: 'Processing',
        elapsedSeconds: 10,
        renderedText: 'Content',
        todoItems: [],
        totalTools: 0,
        compacting: true,
      };
      const result = formatter.formatProgress('chat123', data);

      expect(result.html).toContain('Compacting');
    });
  });

  describe('formatTaskSummary', () => {
    it('formats task summary with success', () => {
      const data = {
        summary: 'Task completed successfully',
        changedFiles: 3,
        permissionRequests: 2,
        hasError: false,
      };
      const result = formatter.formatTaskSummary('chat123', data);

      expect(result.html).toContain('completed');
      expect(result.html).toContain('3');
    });

    it('formats task summary with error status', () => {
      const data = {
        summary: 'Task failed',
        changedFiles: 0,
        permissionRequests: 1,
        hasError: true,
      };
      const result = formatter.formatTaskSummary('chat123', data);

      expect(result.html).toContain('Task failed');
    });

    it('includes footer line when provided', () => {
      const data = {
        summary: 'Done',
        changedFiles: 1,
        permissionRequests: 0,
        hasError: false,
        footerLine: 'Model: claude-sonnet-4',
      };
      const result = formatter.formatTaskSummary('chat123', data);

      expect(result.html).toContain('claude-sonnet-4');
    });
  });

  describe('formatQueueStatus', () => {
    it('formats idle queue', () => {
      const data = {
        sessionKey: 'session-1',
        depth: 0,
        maxDepth: 5,
      };
      const result = formatter.formatQueueStatus('chat123', data);

      expect(result.html).toContain('idle');
    });

    it('formats saturated queue', () => {
      const data = {
        sessionKey: 'session-2',
        depth: 5,
        maxDepth: 5,
      };
      const result = formatter.formatQueueStatus('chat123', data);

      expect(result.html).toContain('saturated');
    });

    it('shows queued messages', () => {
      const data = {
        sessionKey: 'session-3',
        depth: 2,
        maxDepth: 10,
        queuedMessages: [
          { preview: 'message 1', timestamp: Date.now() },
        ],
      };
      const result = formatter.formatQueueStatus('chat123', data);

      expect(result.html).toContain('message 1');
    });
  });

  describe('formatDiagnose', () => {
    it('formats diagnose output', () => {
      const data = {
        activeSessions: 2,
        idleSessions: 1,
        totalQueuedMessages: 5,
        processingChats: 3,
        totalBubbleMappings: 10,
        queueStats: [
          { sessionKey: 's1', depth: 2, maxDepth: 5 },
        ],
      };
      const result = formatter.formatDiagnose('chat123', data);

      expect(result.html).toContain('Diagnose');
      expect(result.html).toContain('s1');
    });

    it('shows memory usage', () => {
      const data = {
        activeSessions: 1,
        idleSessions: 0,
        totalQueuedMessages: 0,
        processingChats: 1,
        totalBubbleMappings: 0,
        queueStats: [],
        memoryUsage: '100MB',
      };
      const result = formatter.formatDiagnose('chat123', data);

      expect(result.html).toContain('100MB');
    });
  });

  describe('formatProjectList', () => {
    it('formats project list', () => {
      const data = {
        projects: [
          { name: 'project-a', workdir: '/home/a', isDefault: false, isCurrent: false },
          { name: 'project-b', workdir: '/home/b', isDefault: false, isCurrent: true },
        ],
      };
      const result = formatter.formatProjectList('chat123', data);

      expect(result.html).toContain('project-a');
      expect(result.html).toContain('/home/b');
    });

    it('shows default flag', () => {
      const data = {
        projects: [
          { name: 'main', workdir: '/home/main', isDefault: true, isCurrent: false },
        ],
      };
      const result = formatter.formatProjectList('chat123', data);

      expect(result.html).toContain('default');
    });
  });

  describe('formatProjectInfo', () => {
    it('formats project info', () => {
      const data = {
        projectName: 'test-project',
        workdir: '/home/test',
      };
      const result = formatter.formatProjectInfo('chat123', data);

      expect(result.html).toContain('test-project');
      expect(result.html).toContain('/home/test');
    });

    it('shows channels and settings', () => {
      const data = {
        projectName: 'test',
        workdir: '/tmp',
        channels: ['telegram', 'feishu'],
        claudeSettingSources: ['user', 'project'],
      };
      const result = formatter.formatProjectInfo('chat123', data);

      expect(result.html).toContain('telegram');
      expect(result.html).toContain('user');
    });
  });

  describe('getLocale', () => {
    it('returns configured locale', () => {
      expect(formatter.getLocale()).toBe('en');
    });

    it('returns zh locale for zh formatter', () => {
      expect(zhFormatter.getLocale()).toBe('zh');
    });
  });

  describe('formatUptime', () => {
    it('formats seconds less than minute', () => {
      const result = formatter.formatStatus('chat123', {
        healthy: true,
        channels: [],
        uptimeSeconds: 30,
      });
      expect(result.html).toContain('30s');
    });

    it('formats minutes', () => {
      const result = formatter.formatStatus('chat123', {
        healthy: true,
        channels: [],
        uptimeSeconds: 120,
      });
      expect(result.html).toContain('2m');
    });

    it('formats hours with minutes', () => {
      const result = formatter.formatStatus('chat123', {
        healthy: true,
        channels: [],
        uptimeSeconds: 3661,
      });
      expect(result.html).toContain('1h');
    });

    it('formats days with hours', () => {
      const result = formatter.formatStatus('chat123', {
        healthy: true,
        channels: [],
        uptimeSeconds: 90061,
      });
      expect(result.html).toContain('1d');
    });
  });
});