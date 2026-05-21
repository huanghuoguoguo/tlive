import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CommandRouter } from '../../engine/command-router.js';
import { SessionStateManager } from '../../engine/state/session-state.js';
import { WorkspaceStateManager } from '../../engine/state/workspace-state.js';
import { RecentProjectsManager } from '../../engine/state/recent-projects.js';
import { TopicSessionManager } from '../../engine/state/topic-sessions.js';
import { ChannelRouter } from '../../utils/router.js';
import { JsonFileStore } from '../../store/json-file.js';
import { ClaudeSDKProvider } from '../../providers/claude-sdk.js';
import { AgentProviderRegistry, singleProviderRegistry } from '../../providers/registry.js';
import { loadProjectsConfig, type AgentSettingSource } from '../../config.js';
import type { SDKEngine } from '../../engine/sdk/engine.js';
import type { PermissionCoordinator } from '../../engine/coordinators/permission.js';
import * as sessionScanner from '../../providers/session-scanner.js';
import { chatScopeId } from '../../core/key.js';

/** Create a minimal PermissionCoordinator mock for tests */
function createMockPermissions(): PermissionCoordinator {
  return {
    clearSessionWhitelist: vi.fn(),
    getPermissionStatus: vi.fn().mockReturnValue({
      rememberedTools: 0,
      rememberedBashPrefixes: 0,
    }),
  } as unknown as PermissionCoordinator;
}

function createMockClaudeProvider(): ClaudeSDKProvider {
  return Object.assign(Object.create(ClaudeSDKProvider.prototype), {
    kind: 'claude',
    displayName: 'Claude Code',
    capabilities: {
      nativeSteer: true,
      nativeQueue: true,
      interactivePermissions: true,
      askUserQuestion: true,
      deferredTools: true,
      settingSources: true,
      sessionResume: true,
      imageInputs: true,
    },
  }) as ClaudeSDKProvider;
}

function createMockCodexProvider() {
  return {
    kind: 'codex',
    displayName: 'Codex',
    capabilities: {
      nativeSteer: false,
      nativeQueue: false,
      interactivePermissions: false,
      askUserQuestion: false,
      deferredTools: false,
      settingSources: false,
      sessionResume: false,
      imageInputs: true,
    },
  } as any;
}

describe('CommandRouter /settings', () => {
  let tmpDir: string;
  let store: JsonFileStore;
  let router: CommandRouter;
  let sdkEngine: Partial<SDKEngine>;
  let workspace: WorkspaceStateManager;
  let permissions: PermissionCoordinator;
  let adapter: any;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tlive-command-router-'));
    originalHome = process.env.HOME;
    store = new JsonFileStore(tmpDir);
    permissions = createMockPermissions();
    adapter = {
      channelType: 'feishu',
      send: vi.fn().mockResolvedValue(undefined),
      sendFormatted: vi.fn().mockResolvedValue(undefined),
    };

    // Minimal SDKEngine mock for command routing tests
    sdkEngine = {
      cleanupSession: vi.fn<(channelType: string, chatId: string, reason: 'new' | 'switch' | 'cd' | 'settings' | 'expire', workdir?: string) => boolean>()
        .mockReturnValue(false),
      hasSessionContext: vi.fn().mockReturnValue(true),
      getActiveControls: vi.fn().mockReturnValue(new Map()),
      getActiveSessionKey: vi.fn().mockReturnValue(undefined),
      getQueueInfo: vi.fn().mockReturnValue(undefined),
      isChatSessionStale: vi.fn().mockReturnValue(false),
      getSessionKeyForBinding: vi.fn().mockImplementation((channelType: string, chatId: string, sessionId: string) => `${channelType}:${chatId}:${sessionId}`),
      isSessionStale: vi.fn().mockReturnValue(false),
      getSessionsForChat: vi.fn().mockReturnValue([]),
    };

    // Create WorkspaceStateManager (no persistence for tests)
    workspace = new WorkspaceStateManager();

    router = new CommandRouter(
      new SessionStateManager(),
      workspace,
      new RecentProjectsManager(),
      () => new Map(),
      new ChannelRouter(store),
      store,
      '/tmp/project',
      createMockClaudeProvider(),
      singleProviderRegistry(createMockClaudeProvider()),
      new Map(),
      permissions,
      ['user', 'project', 'local'],
      sdkEngine as SDKEngine,
    );
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores settings overrides per chat and rotates the default session on change', async () => {
    await store.saveBinding({
      channelType: 'feishu',
      chatId: 'c1',
      sessionId: 'binding-1',
      sdkSessionId: 'sdk-1',
      createdAt: '',
    });

    await router.handle(adapter, {
      channelType: 'feishu',
      chatId: 'c1',
      userId: 'u1',
      text: '/settings isolated',
      internalCommand: true,
      messageId: 'm1',
    } as any);

    const binding = await store.getBinding('feishu', 'c1');
    expect(binding?.agentSettingSources).toEqual([]);
    expect(binding?.sdkSessionId).toBeUndefined();
    expect(binding?.sessionId).not.toBe('binding-1');
    expect(sdkEngine.cleanupSession).not.toHaveBeenCalled();
    expect(permissions.clearSessionWhitelist).not.toHaveBeenCalled();
    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('isolated') }),
    );
  });

  it('reports defaults for other chats without inheriting another chat override', async () => {
    await store.saveBinding({
      channelType: 'feishu',
      chatId: 'c1',
      sessionId: 'binding-1',
      agentSettingSources: [],
      createdAt: '',
    });

    await router.handle(adapter, {
      channelType: 'feishu',
      chatId: 'c2',
      userId: 'u2',
      text: '/settings',
      internalCommand: true,
      messageId: 'm2',
    } as any);

    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Settings (default): **full** (user, project, local)'),
      }),
    );
  });

  it('passes non-public slash commands through to the agent path', async () => {
    const handled = await router.handle(adapter, {
      channelType: 'feishu',
      chatId: 'c1',
      userId: 'u1',
      text: '/settings isolated',
      messageId: 'm-pass-through',
    } as any);

    expect(handled).toBe(false);
    expect(adapter.send).not.toHaveBeenCalled();
    expect(adapter.sendFormatted).not.toHaveBeenCalled();
  });

  it('keeps /tlive as the public workbench entrypoint', async () => {
    const handled = await router.handle(adapter, {
      channelType: 'feishu',
      chatId: 'c1',
      userId: 'u1',
      text: '/tlive',
      messageId: 'm-tlive',
    } as any);

    expect(handled).toBe(true);
    expect(adapter.sendFormatted).toHaveBeenCalledWith(expect.objectContaining({
      type: 'home',
      chatId: 'c1',
    }));
  });

  it('preserves chat settings overrides across /new', async () => {
    await store.saveBinding({
      channelType: 'feishu',
      chatId: 'c1',
      sessionId: 'binding-1',
      sdkSessionId: 'sdk-1',
      projectName: 'repo',
      agentSettingSources: ['user'] as AgentSettingSource[],
      cwd: '/tmp/project',
      createdAt: '',
    });

    await router.handle(adapter, {
      channelType: 'feishu',
      chatId: 'c1',
      userId: 'u1',
      text: '/new',
      internalCommand: true,
      messageId: 'm3',
    } as any);

    const binding = await store.getBinding('feishu', 'c1');
    expect(binding?.agentSettingSources).toEqual(['user']);
    expect(binding?.projectName).toBe('repo');
  });

  it('stops an explicit session key without relying on the current chat scope', async () => {
    sdkEngine.interruptSession = vi.fn().mockResolvedValue(true);

    await router.handle(adapter, {
      channelType: 'feishu',
      chatId: 'chat-1',
      scopeId: 'chat-1',
      userId: 'u1',
      text: '/stop feishu:chat-1#thread:thread-1:session-1',
      messageId: 'm-stop',
    } as any);

    expect(sdkEngine.interruptSession).toHaveBeenCalledWith(
      'feishu:chat-1#thread:thread-1:session-1',
    );
    expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'chat-1',
      text: '⏹ Interrupted current execution',
    }));
  });

  it('rejects workbench home inside a Feishu topic instead of rendering a workbench card', async () => {
    await router.handle(adapter, {
      channelType: 'feishu',
      chatId: 'c1',
      scopeId: chatScopeId('c1', 'thread-1'),
      threadId: 'thread-1',
      replyInThread: true,
      replyTargetMessageId: 'topic-card',
      userId: 'u1',
      text: '/home',
      messageId: 'topic-card',
    } as any);

    expect(adapter.sendFormatted).not.toHaveBeenCalled();
    expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('/home 是工作台命令'),
      replyToMessageId: 'topic-card',
      replyInThread: true,
    }));
  });

  it('rejects internal session switching inside a Feishu topic', async () => {
    await router.handle(adapter, {
      channelType: 'feishu',
      chatId: 'c1',
      scopeId: chatScopeId('c1', 'thread-1'),
      threadId: 'thread-1',
      replyInThread: true,
      replyTargetMessageId: 'topic-card',
      userId: 'u1',
      text: '/session --all',
      internalCommand: true,
      messageId: 'topic-card',
    } as any);

    expect(adapter.sendFormatted).not.toHaveBeenCalled();
    expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('/session 是工作台命令'),
      replyToMessageId: 'topic-card',
      replyInThread: true,
    }));
  });

  it('rejects hidden continue callbacks inside a Feishu topic', async () => {
    await router.handle(adapter, {
      channelType: 'feishu',
      chatId: 'c1',
      scopeId: chatScopeId('c1', 'thread-1'),
      threadId: 'thread-1',
      replyInThread: true,
      replyTargetMessageId: 'topic-card',
      userId: 'u1',
      text: '/continue sdk-1',
      internalCommand: true,
      messageId: 'topic-card',
    } as any);

    expect(adapter.sendFormatted).not.toHaveBeenCalled();
    expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('不支持切换到其他会话'),
      replyToMessageId: 'topic-card',
      replyInThread: true,
    }));
  });

  it('filters workbench commands and removes action buttons from topic help', async () => {
    await router.handle(adapter, {
      channelType: 'feishu',
      chatId: 'c1',
      scopeId: chatScopeId('c1', 'thread-1'),
      threadId: 'thread-1',
      replyInThread: true,
      replyTargetMessageId: 'topic-card',
      userId: 'u1',
      text: '/help',
      internalCommand: true,
      messageId: 'topic-card',
    } as any);

    expect(adapter.sendFormatted).toHaveBeenCalledWith(expect.objectContaining({
      type: 'help',
      chatId: 'c1',
      data: expect.objectContaining({
        actionButtons: [],
        commands: expect.not.arrayContaining([
          expect.objectContaining({ cmd: 'home' }),
          expect.objectContaining({ cmd: 'session' }),
        ]),
      }),
    }));
  });

  it('resets a topic with /new without rendering a home/workbench card', async () => {
    const scopeId = chatScopeId('c1', 'thread-1');
    await store.saveBinding({
      channelType: 'feishu',
      chatId: scopeId,
      sessionId: 'old-session',
      sdkSessionId: 'sdk-old',
      cwd: '/tmp/project',
      createdAt: '',
    });

    await router.handle(adapter, {
      channelType: 'feishu',
      chatId: 'c1',
      scopeId,
      threadId: 'thread-1',
      replyInThread: true,
      replyTargetMessageId: 'topic-card',
      userId: 'u1',
      text: '/new',
      internalCommand: true,
      messageId: 'topic-card',
    } as any);

    expect(adapter.sendFormatted).toHaveBeenCalledTimes(1);
    expect(adapter.sendFormatted).toHaveBeenCalledWith(expect.objectContaining({
      type: 'newSession',
      chatId: 'c1',
    }));
    expect(adapter.sendFormatted).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'home',
    }));

    const binding = await store.getBinding('feishu', scopeId);
    expect(binding?.sessionId).not.toBe('old-session');
    expect(binding?.sdkSessionId).toBeUndefined();
  });

  it('opens workbench /new as a fresh Feishu topic when topics are supported', async () => {
    const topicSessions = new TopicSessionManager();
    const topicRouter = new CommandRouter(
      new SessionStateManager(),
      workspace,
      new RecentProjectsManager(),
      () => new Map(),
      new ChannelRouter(store),
      store,
      '/tmp/project',
      createMockClaudeProvider(),
      singleProviderRegistry(createMockClaudeProvider()),
      new Map(),
      permissions,
      ['user', 'project', 'local'],
      sdkEngine as SDKEngine,
      undefined,
      topicSessions,
    );
    await store.saveBinding({
      channelType: 'feishu',
      chatId: 'c1',
      sessionId: 'binding-1',
      sdkSessionId: 'sdk-1',
      projectName: 'repo',
      agentSettingSources: ['user'] as AgentSettingSource[],
      cwd: '/tmp/project',
      createdAt: '',
    });
    const adapterWithTopic = {
      ...adapter,
      startThreadWithTitle: vi.fn().mockResolvedValue({
        threadId: 'thread-new',
        rootMessageId: 'msg-title',
        messageId: 'msg-topic-start',
      }),
    };

    await topicRouter.handle(adapterWithTopic, {
      channelType: 'feishu',
      chatId: 'c1',
      userId: 'u1',
      text: '/new',
      internalCommand: true,
      messageId: 'workbench-card',
    } as any);

    expect(adapterWithTopic.startThreadWithTitle).toHaveBeenCalledWith(
      'c1',
      '新 Claude Code 会话',
      expect.stringContaining('已开启新话题'),
    );
    const scopeId = chatScopeId('c1', 'thread-new');
    const topicBinding = await store.getBinding('feishu', scopeId);
    expect(topicBinding).toMatchObject({
      chatId: scopeId,
      provider: 'claude',
      cwd: '/tmp/project',
      agentSettingSources: ['user'],
      projectName: 'repo',
      sdkSessionId: undefined,
    });
    expect(topicBinding?.sessionId).not.toBe('binding-1');
    expect(topicSessions.findByScope(scopeId)).toMatchObject({
      scopeId,
      provider: 'claude',
      rootMessageId: 'msg-title',
      lastMessageId: 'msg-topic-start',
      title: '新 Claude Code 会话',
    });
  });

  it('opens workbench /new codex as a Codex topic binding', async () => {
    const topicSessions = new TopicSessionManager();
    const providers = new AgentProviderRegistry(
      'claude',
      new Map([
        ['claude', createMockClaudeProvider()],
        ['codex', createMockCodexProvider()],
      ]),
      new Map([
        [
          'claude',
          { kind: 'claude', displayName: 'Claude', available: true, isDefault: true },
        ],
        [
          'codex',
          { kind: 'codex', displayName: 'Codex', available: true, isDefault: false },
        ],
      ]),
    );
    const topicRouter = new CommandRouter(
      new SessionStateManager(),
      workspace,
      new RecentProjectsManager(),
      () => new Map(),
      new ChannelRouter(store),
      store,
      '/tmp/project',
      createMockClaudeProvider(),
      providers,
      new Map(),
      permissions,
      ['user', 'project', 'local'],
      sdkEngine as SDKEngine,
      undefined,
      topicSessions,
    );
    await store.saveBinding({
      channelType: 'feishu',
      chatId: 'c1',
      sessionId: 'binding-1',
      agentSettingSources: ['user'] as AgentSettingSource[],
      cwd: '/tmp/project',
      createdAt: '',
    });
    const adapterWithTopic = {
      ...adapter,
      startThreadWithTitle: vi.fn().mockResolvedValue({
        threadId: 'thread-codex',
        rootMessageId: 'msg-codex-root',
        messageId: 'msg-codex-start',
      }),
    };

    await topicRouter.handle(adapterWithTopic, {
      channelType: 'feishu',
      chatId: 'c1',
      userId: 'u1',
      text: '/new codex',
      internalCommand: true,
      messageId: 'workbench-card',
    } as any);

    expect(adapterWithTopic.startThreadWithTitle).toHaveBeenCalledWith(
      'c1',
      '新 Codex 会话',
      expect.stringContaining('已开启新话题'),
    );
    const scopeId = chatScopeId('c1', 'thread-codex');
    expect(await store.getBinding('feishu', scopeId)).toMatchObject({
      chatId: scopeId,
      provider: 'codex',
      cwd: '/tmp/project',
      agentSettingSources: ['user'],
    });
    expect(topicSessions.findByScope(scopeId)).toMatchObject({
      scopeId,
      provider: 'codex',
      title: '新 Codex 会话',
    });
  });

  it('tracks the current directory so /cd - returns to the immediate previous path', async () => {
    const dirA = join(tmpDir, 'a');
    const dirB = join(tmpDir, 'b');
    const dirC = join(tmpDir, 'c');
    mkdirSync(dirA);
    mkdirSync(dirB);
    mkdirSync(dirC);

    await store.saveBinding({
      channelType: 'feishu',
      chatId: 'c1',
      sessionId: 'binding-1',
      cwd: dirA,
      createdAt: '',
    });
    workspace.pushHistory('feishu', 'c1', dirA);

    await router.handle(adapter, {
      channelType: 'feishu',
      chatId: 'c1',
      userId: 'u1',
      text: `/cd ${dirB}`,
      internalCommand: true,
      messageId: 'm4',
    } as any);

    await router.handle(adapter, {
      channelType: 'feishu',
      chatId: 'c1',
      userId: 'u1',
      text: `/cd ${dirC}`,
      internalCommand: true,
      messageId: 'm5',
    } as any);

    await router.handle(adapter, {
      channelType: 'feishu',
      chatId: 'c1',
      userId: 'u1',
      text: '/cd -',
      internalCommand: true,
      messageId: 'm6',
    } as any);

    const binding = await store.getBinding('feishu', 'c1');
    expect(binding?.cwd).toBe(dirB);
    expect(workspace.getHistory('feishu', 'c1')).toEqual([dirB, dirC, dirA]);
  });

  it('does not cleanup session when /cd stays in the same git repo', async () => {
    const repoDir = join(tmpDir, 'repo');
    const subDir = join(repoDir, 'src');
    mkdirSync(join(repoDir, '.git'), { recursive: true });
    mkdirSync(subDir, { recursive: true });

    await store.saveBinding({
      channelType: 'feishu',
      chatId: 'c1',
      sessionId: 'binding-1',
      sdkSessionId: 'sdk-1',
      cwd: repoDir,
      projectName: 'repo',
      createdAt: '',
    });

    await router.handle(adapter, {
      channelType: 'feishu',
      chatId: 'c1',
      userId: 'u1',
      text: `/cd ${subDir}`,
      internalCommand: true,
      messageId: 'm8',
    } as any);

    expect(sdkEngine.cleanupSession).not.toHaveBeenCalled();
    expect(permissions.clearSessionWhitelist).not.toHaveBeenCalled();
    const binding = await store.getBinding('feishu', 'c1');
    expect(binding?.cwd).toBe(subDir);
    expect(binding?.sdkSessionId).toBe('sdk-1');
    expect(binding?.projectName).toBe('repo');
    expect(workspace.getBinding('feishu', 'c1')).toBe(repoDir);
  });

  it('cleans session and clears project binding when /cd crosses repos', async () => {
    const repoA = join(tmpDir, 'repo-a');
    const repoB = join(tmpDir, 'repo-b');
    mkdirSync(join(repoA, '.git'), { recursive: true });
    mkdirSync(join(repoB, '.git'), { recursive: true });

    await store.saveBinding({
      channelType: 'feishu',
      chatId: 'c1',
      sessionId: 'binding-1',
      sdkSessionId: 'sdk-1',
      cwd: repoA,
      projectName: 'repo-a',
      createdAt: '',
    });

    await router.handle(adapter, {
      channelType: 'feishu',
      chatId: 'c1',
      userId: 'u1',
      text: `/cd ${repoB}`,
      internalCommand: true,
      messageId: 'm9',
    } as any);

    expect(sdkEngine.cleanupSession).not.toHaveBeenCalled();
    expect(permissions.clearSessionWhitelist).not.toHaveBeenCalled();
    const binding = await store.getBinding('feishu', 'c1');
    expect(binding?.cwd).toBe(repoB);
    expect(binding?.sdkSessionId).toBeUndefined();
    expect(binding?.sessionId).not.toBe('binding-1');
    expect(binding?.projectName).toBeUndefined();
    expect(workspace.getBinding('feishu', 'c1')).toBe(repoB);
  });

  it('clears project binding when /session --all switches to another repo', async () => {
    const repoA = join(tmpDir, 'repo-a');
    const repoB = join(tmpDir, 'repo-b');
    mkdirSync(join(repoA, '.git'), { recursive: true });
    mkdirSync(join(repoB, '.git'), { recursive: true });

    const scanSpy = vi.spyOn(sessionScanner, 'scanAgentSessions').mockReturnValue([
      {
        provider: 'claude',
        providerDisplayName: 'Claude',
        sdkSessionId: 'sdk-target',
        projectDir: 'repo-b',
        filePath: join(repoB, 'sdk-target.jsonl'),
        cwd: repoB,
        preview: 'target session',
        mtime: Date.now(),
        size: 1024,
      },
    ] as any);

    await store.saveBinding({
      channelType: 'feishu',
      chatId: 'c1',
      sessionId: 'binding-1',
      sdkSessionId: 'sdk-1',
      cwd: repoA,
      projectName: 'repo-a',
      createdAt: '',
    });
    workspace.setBinding('feishu', 'c1', repoA);

    await router.handle(adapter, {
      channelType: 'feishu',
      chatId: 'c1',
      userId: 'u1',
      text: '/session --all 1',
      internalCommand: true,
      messageId: 'm12',
    } as any);

    expect(sdkEngine.cleanupSession).not.toHaveBeenCalled();
    expect(permissions.clearSessionWhitelist).not.toHaveBeenCalled();
    const binding = await store.getBinding('feishu', 'c1');
    expect(binding?.cwd).toBe(repoB);
    expect(binding?.sdkSessionId).toBe('sdk-target');
    expect(binding?.sessionId).not.toBe('binding-1');
    expect(binding?.projectName).toBeUndefined();
    expect(workspace.getBinding('feishu', 'c1')).toBe(repoB);

    scanSpy.mockRestore();
  });

  it('opens a fresh Feishu topic from a Claude history title when continuing by sdk id', async () => {
    const repoDir = join(tmpDir, 'repo-topic');
    mkdirSync(repoDir, { recursive: true });
    const topicSessions = new TopicSessionManager();
    const topicRouter = new CommandRouter(
      new SessionStateManager(),
      workspace,
      new RecentProjectsManager(),
      () => new Map(),
      new ChannelRouter(store),
      store,
      '/tmp/project',
      createMockClaudeProvider(),
      singleProviderRegistry(createMockClaudeProvider()),
      new Map(),
      permissions,
      ['user', 'project', 'local'],
      sdkEngine as SDKEngine,
      undefined,
      topicSessions,
    );
    const scanSpy = vi.spyOn(sessionScanner, 'scanAgentSessions').mockReturnValue([
      {
        provider: 'claude',
        providerDisplayName: 'Claude',
        sdkSessionId: '5049209e-session',
        projectDir: 'repo-topic',
        filePath: join(repoDir, '5049209e-session.jsonl'),
        cwd: repoDir,
        preview: '提一个issue，在本项目内整理相关信息',
        mtime: Date.now(),
        size: 1024,
      },
    ]);
    const adapterWithTopic = {
      ...adapter,
      startThreadWithTitle: vi.fn().mockResolvedValue({
        threadId: 'thread-history',
        rootMessageId: 'msg-title',
        messageId: 'msg-topic-start',
      }),
    };

    await topicRouter.handle(adapterWithTopic, {
      channelType: 'feishu',
      chatId: 'c1',
      userId: 'u1',
      text: '/continue 5049209e-session',
      internalCommand: true,
      messageId: 'workbench-card',
    } as any);

    expect(adapterWithTopic.startThreadWithTitle).toHaveBeenCalledWith(
      'c1',
      '提一个issue，在本项目内整理相关信息',
      expect.stringContaining('5049209e'),
    );
    const scopeId = chatScopeId('c1', 'thread-history');
    const binding = await store.getBinding('feishu', scopeId);
    expect(binding).toMatchObject({
      sdkSessionId: '5049209e-session',
      cwd: repoDir,
    });
    expect(topicSessions.findBySdkSessionId('5049209e-session')).toMatchObject({
      scopeId,
      rootMessageId: 'msg-title',
      lastMessageId: 'msg-topic-start',
      title: '提一个issue，在本项目内整理相关信息',
    });
    scanSpy.mockRestore();
  });
});
