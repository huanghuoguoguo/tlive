import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CommandRouter } from '../../server/engine/command-router.js';
import { SessionStateManager } from '../../server/engine/state/session-state.js';
import { WorkspaceStateManager } from '../../server/engine/state/workspace-state.js';
import { RecentProjectsManager } from '../../server/engine/state/recent-projects.js';
import { TopicSessionManager } from '../../server/engine/state/topic-sessions.js';
import { ChannelRouter } from '../../server/engine/channel-router.js';
import { JsonFileStore } from '../../server/store/json-file.js';
import { ClaudeSDKProvider } from '../../client/providers/claude-sdk.js';
import { AgentProviderRegistry, singleProviderRegistry } from '../../shared/providers/registry.js';
import { loadProjectsConfig, type AgentSettingSource } from '../../shared/config.js';
import type { SDKEngine } from '../../server/engine/sdk/engine.js';
import type { PermissionCoordinator } from '../../server/engine/coordinators/permission.js';
import { chatScopeId } from '../../shared/core/key.js';
import { homeInstanceActionArg } from '../../shared/core/callbacks.js';
import type { HomeClientEntry } from '../../shared/formatting/message-types.js';
import { extractTliveTopicMetadata } from '../../shared/topic-metadata.js';

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
      runtimeMode: 'interactive',
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
      runtimeMode: 'turn-based',
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
      format: vi.fn((msg: any) => msg),
      send: vi.fn().mockResolvedValue(undefined),
      editMessage: vi.fn().mockResolvedValue(undefined),
      sendFormatted: vi.fn().mockResolvedValue(undefined),
      publishTopicMetadata: vi.fn().mockResolvedValue('msg-topic-metadata'),
      getLocale: () => 'zh',
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

  function createTopicRouter(options: {
    state?: SessionStateManager;
    providers?: AgentProviderRegistry;
    topicSessions?: TopicSessionManager;
    getExecutionClients?: () => HomeClientEntry[];
    remoteClientRegistry?: any;
  } = {}) {
    const state = options.state ?? new SessionStateManager();
    const topicSessions = options.topicSessions ?? new TopicSessionManager();
    return {
      state,
      topicSessions,
      router: new CommandRouter(
        state,
        workspace,
        new RecentProjectsManager(),
        () => new Map(),
        new ChannelRouter(store),
        store,
        '/tmp/project',
        createMockClaudeProvider(),
        options.providers ?? singleProviderRegistry(createMockClaudeProvider()),
        new Map(),
        permissions,
        ['user', 'project', 'local'],
        sdkEngine as SDKEngine,
        undefined,
        topicSessions,
        options.getExecutionClients,
        options.remoteClientRegistry,
      ),
    };
  }

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
    adapter.send.mockClear();

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

  it('allows restored workbench slash commands from direct chat input', async () => {
    const handled = await router.handle(adapter, {
      channelType: 'feishu',
      chatId: 'c1',
      userId: 'u1',
      text: '/settings isolated',
      messageId: 'm-pass-through',
    } as any);

    expect(handled).toBe(true);
    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Settings') }),
    );
    expect(adapter.format).not.toHaveBeenCalled();
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
    expect(adapter.format).toHaveBeenCalledWith(expect.objectContaining({
      type: 'home',
      chatId: 'c1',
    }));
    expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'home',
      chatId: 'c1',
    }));
  });

  it('refreshes a workbench card in place from a callback action', async () => {
    const handled = await router.handleAction(
      adapter,
      {
        channelType: 'feishu',
        chatId: 'c1',
        scopeId: 'c1',
        userId: 'u1',
        text: '',
        messageId: 'home-card-1',
      } as any,
      { name: 'home-refresh', args: [] },
    );

    expect(handled).toBe(true);
    expect(adapter.format).toHaveBeenCalledWith(expect.objectContaining({
      type: 'home',
      chatId: 'c1',
    }));
    expect(adapter.editMessage).toHaveBeenCalledWith(
      'c1',
      'home-card-1',
      expect.objectContaining({
        type: 'home',
        chatId: 'c1',
      }),
    );
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('allows actions from the latest workbench card and strips the instance token', async () => {
    const { router: scopedRouter, state } = createTopicRouter();
    state.setActiveHomeInstance('feishu', 'c1', 'home-current');

    const handled = await scopedRouter.handleAction(
      adapter,
      {
        channelType: 'feishu',
        chatId: 'c1',
        scopeId: 'c1',
        userId: 'u1',
        text: '',
        messageId: 'home-card-current',
      } as any,
      { name: 'home-view', args: ['nodes', homeInstanceActionArg('home-current')!] },
    );

    expect(handled).toBe(true);
    expect(adapter.editMessage).toHaveBeenCalledWith(
      'c1',
      'home-card-current',
      expect.objectContaining({
        type: 'home',
        data: expect.objectContaining({ view: 'nodes' }),
      }),
    );
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('marks stale workbench cards expired instead of executing their actions', async () => {
    const { router: scopedRouter, state } = createTopicRouter();
    state.setActiveHomeInstance('feishu', 'c1', 'home-current');

    const handled = await scopedRouter.handleAction(
      adapter,
      {
        channelType: 'feishu',
        chatId: 'c1',
        scopeId: 'c1',
        userId: 'u1',
        text: '',
        messageId: 'home-card-old',
      } as any,
      { name: 'home-dir', args: ['/tmp/should-not-run', homeInstanceActionArg('home-old')!] },
    );

    expect(handled).toBe(true);
    expect(adapter.editMessage).toHaveBeenCalledWith(
      'c1',
      'home-card-old',
      expect.objectContaining({
        type: 'home',
        data: expect.objectContaining({ home: { stale: true } }),
      }),
    );
    expect(await store.getBinding('feishu', 'c1')).toBeNull();
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('switches a workbench card to a secondary panel view in place', async () => {
    const handled = await router.handleAction(
      adapter,
      {
        channelType: 'feishu',
        chatId: 'c1',
        scopeId: 'c1',
        userId: 'u1',
        text: '',
        messageId: 'home-card-1',
      } as any,
      { name: 'home-view', args: ['nodes'] },
    );

    expect(handled).toBe(true);
    expect(adapter.editMessage).toHaveBeenCalledWith(
      'c1',
      'home-card-1',
      expect.objectContaining({
        type: 'home',
        data: expect.objectContaining({ view: 'nodes' }),
      }),
    );
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('sends a remote client upgrade request from a workbench action', async () => {
    const upgradeClient = vi.fn().mockResolvedValue({
      type: 'client.command.result',
      commandId: 'cmd-upgrade',
      ok: true,
    });
    const { router: upgradeRouter } = createTopicRouter({
      getExecutionClients: () => [
        {
          clientId: 'worker-1',
          name: 'worker-1',
          online: true,
          isDefault: true,
          activeTurns: 0,
          version: '0.14.3',
          upgrade: { supported: true, installRoot: '/opt/tlive' },
          workspaces: [{ path: '/tmp/project', isDefault: true }],
          providers: [
            { kind: 'codex', displayName: 'Codex', available: true, isDefault: true },
          ],
        },
      ],
      remoteClientRegistry: { upgradeClient },
    });

    const handled = await upgradeRouter.handleAction(
      adapter,
      {
        channelType: 'feishu',
        chatId: 'c1',
        scopeId: 'c1',
        userId: 'u1',
        text: '',
        messageId: 'home-card-1',
      } as any,
      { name: 'client-upgrade', args: ['worker-1', '0.14.4'] },
    );

    expect(handled).toBe(true);
    expect(upgradeClient).toHaveBeenCalledWith('worker-1', '0.14.4');
    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('已向节点 worker-1 发送升级请求') }),
    );
  });

  it('changes the current directory from the workbench directory panel in place', async () => {
    const root = join(tmpDir, 'project');
    const child = join(root, 'src');
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, 'index.ts'), 'export {};\n');
    await store.saveBinding({
      channelType: 'feishu',
      chatId: 'c1',
      sessionId: 'binding-1',
      cwd: root,
      createdAt: '',
    });

    const handled = await router.handleAction(
      adapter,
      {
        channelType: 'feishu',
        chatId: 'c1',
        scopeId: 'c1',
        userId: 'u1',
        text: '',
        messageId: 'home-card-1',
      } as any,
      { name: 'home-dir', args: [child] },
    );

    expect(handled).toBe(true);
    expect((await store.getBinding('feishu', 'c1'))?.cwd).toBe(child);
    expect(adapter.editMessage).toHaveBeenCalledWith(
      'c1',
      'home-card-1',
      expect.objectContaining({
        type: 'home',
        data: expect.objectContaining({
          view: 'files',
          workspace: expect.objectContaining({
            directory: expect.objectContaining({
              path: child,
              entries: expect.arrayContaining([
                expect.objectContaining({ name: 'index.ts', kind: 'file' }),
              ]),
            }),
          }),
        }),
      }),
    );
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('falls back to sending a workbench card when refresh has no message id', async () => {
    const handled = await router.handleAction(
      adapter,
      {
        channelType: 'feishu',
        chatId: 'c1',
        scopeId: 'c1',
        userId: 'u1',
        text: '',
      } as any,
      { name: 'home-refresh', args: [] },
    );

    expect(handled).toBe(true);
    expect(adapter.editMessage).not.toHaveBeenCalled();
    expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({
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
      text: '⏹ 已中断当前执行',
    }));
  });

  it('rejects /stop in the workbench without an explicit session key', async () => {
    sdkEngine.interruptChat = vi.fn().mockResolvedValue(true);

    await router.handle(adapter, {
      channelType: 'feishu',
      chatId: 'chat-1',
      scopeId: 'chat-1',
      userId: 'u1',
      text: '/stop',
      messageId: 'm-stop-workbench',
    } as any);

    expect(sdkEngine.interruptChat).not.toHaveBeenCalled();
    expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'chat-1',
      text: expect.stringContaining('/stop 只中断具体话题'),
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

    expect(adapter.format).not.toHaveBeenCalled();
    expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('/home 是工作台命令'),
      replyToMessageId: 'topic-card',
      replyInThread: true,
    }));
  });

  it('includes topic-bound remote sessions in node history', async () => {
    const topicSessions = new TopicSessionManager();
    topicSessions.upsert({
      channelType: 'feishu',
      chatId: 'chat-1',
      scopeId: chatScopeId('chat-1', 'thread-remote'),
      threadId: 'thread-remote',
      provider: 'claude',
      sdkSessionId: 'remote-topic-session',
      cwd: '/tmp/tlive-remote-smoke',
      title: 'Remote topic',
      preview: 'Remote topic preview',
    });
    const { router: topicRouter } = createTopicRouter({
      topicSessions,
      getExecutionClients: () => [
        {
          clientId: 'vm-0-16-ubuntu',
          name: 'vm-0-16-ubuntu',
          online: true,
          isDefault: true,
          activeTurns: 0,
          workspaces: [{ path: '/tmp/tlive-remote-smoke', isDefault: true }],
          providers: [
            { kind: 'claude', displayName: 'Claude', available: true, isDefault: true },
          ],
          sessions: [
            {
              provider: 'claude',
              providerDisplayName: 'Claude',
              sdkSessionId: 'remote-topic-session',
              cwd: '/tmp/tlive-remote-smoke',
              mtime: Date.UTC(2026, 4, 22),
              preview: 'Remote history preview',
            },
          ],
        },
      ],
    });

    await topicRouter.handle(adapter, {
      channelType: 'feishu',
      chatId: 'chat-1',
      scopeId: 'chat-1',
      userId: 'u1',
      text: '/home-history vm-0-16-ubuntu',
      internalCommand: true,
      messageId: 'm-history',
    } as any);

    const formatted = adapter.format.mock.calls.at(-1)?.[0];
    expect(formatted).toMatchObject({
      type: 'sessionList',
      data: {
        title: 'vm-0-16-ubuntu 最近会话',
        entries: [
          expect.objectContaining({
            clientId: 'vm-0-16-ubuntu',
            sdkSessionId: 'remote-topic-session',
            actionLabel: '回到话题',
          }),
        ],
      },
    });
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

    expect(adapter.format).not.toHaveBeenCalled();
    expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('不支持切换到其他会话'),
      replyToMessageId: 'topic-card',
      replyInThread: true,
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

    expect(adapter.format).toHaveBeenCalledTimes(1);
    expect(adapter.format).toHaveBeenCalledWith(expect.objectContaining({
      type: 'newSession',
      chatId: 'c1',
    }));
    expect(adapter.format).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'home',
    }));

    const binding = await store.getBinding('feishu', scopeId);
    expect(binding?.sessionId).not.toBe('old-session');
    expect(binding?.sdkSessionId).toBeUndefined();
  });

  it('opens workbench /new as a fresh provider-specific Feishu topic', async () => {
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
    const cases = [
      {
        chatId: 'c-claude',
        text: '/new',
        threadId: 'thread-new',
        rootMessageId: 'msg-title',
        messageId: 'msg-topic-start',
        provider: 'claude',
        titleMatcher: /^TLive · Claude · project · \d{2}-\d{2} \d{2}:\d{2}$/,
        seed: {
          sdkSessionId: 'sdk-1',
          projectName: 'repo',
        },
        assertPermissionMode: true,
      },
      {
        chatId: 'c-codex',
        text: '/new codex',
        threadId: 'thread-codex',
        rootMessageId: 'msg-codex-root',
        messageId: 'msg-codex-start',
        provider: 'codex',
        titleMatcher: /^TLive · Codex · project · \d{2}-\d{2} \d{2}:\d{2}$/,
        seed: {},
        assertPermissionMode: false,
      },
    ] as const;

    for (const testCase of cases) {
      const state = new SessionStateManager();
      if (testCase.assertPermissionMode) {
        state.setPermMode('feishu', testCase.chatId, undefined, 'off');
      }
      const topic = createTopicRouter({ state, providers });
      await store.saveBinding({
        channelType: 'feishu',
        chatId: testCase.chatId,
        sessionId: `binding-${testCase.provider}`,
        agentSettingSources: ['user'] as AgentSettingSource[],
        cwd: '/tmp/project',
        createdAt: '',
        ...testCase.seed,
      });
      const adapterWithTopic = {
        ...adapter,
        startThreadWithTitle: vi.fn().mockResolvedValue({
          threadId: testCase.threadId,
          rootMessageId: testCase.rootMessageId,
          messageId: testCase.messageId,
        }),
      };

      await topic.router.handle(adapterWithTopic, {
        channelType: 'feishu',
        chatId: testCase.chatId,
        userId: 'u1',
        text: testCase.text,
        internalCommand: true,
        messageId: 'workbench-card',
      } as any);

      expect(adapterWithTopic.startThreadWithTitle).toHaveBeenCalledWith(
        testCase.chatId,
        expect.stringMatching(testCase.titleMatcher),
        expect.stringContaining('继续在本话题内发送消息'),
      );
      const topicTitle = (adapterWithTopic.startThreadWithTitle as any).mock.calls.at(-1)[1];
      const metadataText = (adapterWithTopic.publishTopicMetadata as any).mock.calls.at(-1)[2];
      expect(extractTliveTopicMetadata(metadataText)).toMatchObject({
        provider: testCase.provider,
        cwd: '/tmp/project',
        threadId: testCase.threadId,
        rootMessageId: testCase.rootMessageId,
        entryMessageId: testCase.messageId,
      });
      const scopeId = chatScopeId(testCase.chatId, testCase.threadId);
      const topicBinding = await store.getBinding('feishu', scopeId);
      expect(topicBinding).toMatchObject({
        chatId: scopeId,
        provider: testCase.provider,
        cwd: '/tmp/project',
        agentSettingSources: ['user'],
      });
      expect(topicBinding?.sessionId).not.toBe(`binding-${testCase.provider}`);
      expect(topic.topicSessions.findByScope(scopeId)).toMatchObject({
        scopeId,
        provider: testCase.provider,
        rootMessageId: testCase.rootMessageId,
        entryMessageId: testCase.messageId,
        lastMessageId: testCase.messageId,
        title: topicTitle,
      });
      if (testCase.assertPermissionMode) {
        expect(state.getPermMode('feishu', scopeId, topicBinding?.sessionId)).toBe('off');
        expect(topicBinding).toMatchObject({
          projectName: 'repo',
          sdkSessionId: undefined,
        });
      }
    }
  });

  it('uses the current workbench cwd when creating a topic on the same client', async () => {
    const defaultDir = join(tmpDir, 'tlive-remote-client');
    const currentDir = join(tmpDir, 'workspace');
    mkdirSync(defaultDir);
    mkdirSync(currentDir);

    const providers = new AgentProviderRegistry(
      'codex',
      new Map([
        ['claude', createMockClaudeProvider()],
        ['codex', createMockCodexProvider()],
      ]),
      new Map([
        [
          'claude',
          { kind: 'claude', displayName: 'Claude', available: true, isDefault: false },
        ],
        [
          'codex',
          { kind: 'codex', displayName: 'Codex', available: true, isDefault: true },
        ],
      ]),
    );
    const topic = createTopicRouter({
      providers,
      getExecutionClients: () => [
        {
          clientId: 'vm-0-16',
          name: 'VM-0-16',
          online: true,
          isDefault: true,
          activeTurns: 0,
          workspaces: [
            { path: defaultDir, isDefault: true },
            { path: currentDir },
          ],
          providers: [
            { kind: 'codex', displayName: 'Codex', available: true, isDefault: true },
          ],
        },
      ],
    });
    await store.saveBinding({
      channelType: 'feishu',
      chatId: 'c-current-cwd',
      sessionId: 'binding-current',
      provider: 'codex',
      clientId: 'vm-0-16',
      cwd: currentDir,
      createdAt: '',
    });
    const adapterWithTopic = {
      ...adapter,
      startThreadWithTitle: vi.fn().mockResolvedValue({
        threadId: 'thread-current-cwd',
        rootMessageId: 'msg-current-root',
        messageId: 'msg-current-start',
      }),
    };

    await topic.router.handle(adapterWithTopic, {
      channelType: 'feishu',
      chatId: 'c-current-cwd',
      userId: 'u1',
      text: '/new codex vm-0-16',
      internalCommand: true,
      messageId: 'workbench-card',
    } as any);

    const metadataText = (adapterWithTopic.publishTopicMetadata as any).mock.calls.at(-1)[2];
    expect(extractTliveTopicMetadata(metadataText)).toMatchObject({
      provider: 'codex',
      clientId: 'vm-0-16',
      cwd: currentDir,
    });
    const scopeId = chatScopeId('c-current-cwd', 'thread-current-cwd');
    expect(await store.getBinding('feishu', scopeId)).toMatchObject({
      clientId: 'vm-0-16',
      cwd: currentDir,
    });
    expect((adapterWithTopic.startThreadWithTitle as any).mock.calls.at(-1)[1]).toContain(
      'workspace',
    );
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

  it('updates /cd state based on repository boundaries', async () => {
    const repoDir = join(tmpDir, 'repo');
    const subDir = join(repoDir, 'src');
    const repoA = join(tmpDir, 'repo-a');
    const repoB = join(tmpDir, 'repo-b');
    mkdirSync(join(repoDir, '.git'), { recursive: true });
    mkdirSync(subDir, { recursive: true });
    mkdirSync(join(repoA, '.git'), { recursive: true });
    mkdirSync(join(repoB, '.git'), { recursive: true });

    await store.saveBinding({
      channelType: 'feishu',
      chatId: 'c-same-repo',
      sessionId: 'binding-1',
      sdkSessionId: 'sdk-1',
      cwd: repoDir,
      projectName: 'repo',
      createdAt: '',
    });

    await router.handle(adapter, {
      channelType: 'feishu',
      chatId: 'c-same-repo',
      userId: 'u1',
      text: `/cd ${subDir}`,
      internalCommand: true,
      messageId: 'm8',
    } as any);

    const sameRepoBinding = await store.getBinding('feishu', 'c-same-repo');
    expect(sameRepoBinding?.cwd).toBe(subDir);
    expect(sameRepoBinding?.sdkSessionId).toBe('sdk-1');
    expect(sameRepoBinding?.projectName).toBe('repo');
    expect(workspace.getBinding('feishu', 'c-same-repo')).toBe(repoDir);

    await store.saveBinding({
      channelType: 'feishu',
      chatId: 'c-cross-repo',
      sessionId: 'binding-1',
      sdkSessionId: 'sdk-1',
      cwd: repoA,
      projectName: 'repo-a',
      createdAt: '',
    });

    await router.handle(adapter, {
      channelType: 'feishu',
      chatId: 'c-cross-repo',
      userId: 'u1',
      text: `/cd ${repoB}`,
      internalCommand: true,
      messageId: 'm9',
    } as any);

    const crossRepoBinding = await store.getBinding('feishu', 'c-cross-repo');
    expect(crossRepoBinding?.cwd).toBe(repoB);
    expect(crossRepoBinding?.sdkSessionId).toBeUndefined();
    expect(crossRepoBinding?.sessionId).not.toBe('binding-1');
    expect(crossRepoBinding?.projectName).toBeUndefined();
    expect(workspace.getBinding('feishu', 'c-cross-repo')).toBe(repoB);
  });

  it('does not mutate the workbench binding when hidden continue cannot create a topic', async () => {
    const repoA = join(tmpDir, 'repo-a');
    const repoB = join(tmpDir, 'repo-b');
    mkdirSync(join(repoA, '.git'), { recursive: true });
    mkdirSync(join(repoB, '.git'), { recursive: true });

    const topic = createTopicRouter({
      getExecutionClients: () => [
        {
          clientId: 'worker-1',
          name: 'worker-1',
          online: true,
          isDefault: false,
          activeTurns: 0,
          workspaces: [{ path: repoB }],
          providers: [{ kind: 'claude', displayName: 'Claude', available: true, isDefault: true }],
          sessions: [
            {
              provider: 'claude',
              providerDisplayName: 'Claude',
              sdkSessionId: 'sdk-target',
              cwd: repoB,
              preview: 'target session',
              mtime: Date.now(),
              size: 1024,
            },
          ],
        },
      ],
    });

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

    await topic.router.handle(adapter, {
      channelType: 'feishu',
      chatId: 'c1',
      userId: 'u1',
      text: '/continue claude:sdk-target',
      internalCommand: true,
      messageId: 'm12',
    } as any);

    expect(sdkEngine.cleanupSession).not.toHaveBeenCalled();
    expect(permissions.clearSessionWhitelist).not.toHaveBeenCalled();
    const binding = await store.getBinding('feishu', 'c1');
    expect(binding?.cwd).toBe(repoA);
    expect(binding?.sdkSessionId).toBe('sdk-1');
    expect(binding?.sessionId).toBe('binding-1');
    expect(binding?.projectName).toBe('repo-a');
    expect(workspace.getBinding('feishu', 'c1')).toBe(repoA);
    expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('无法创建话题'),
    }));
  });

  it('opens a fresh Feishu topic from a Claude history title when continuing by sdk id', async () => {
    const repoDir = join(tmpDir, 'repo-topic');
    mkdirSync(repoDir, { recursive: true });
    const topic = createTopicRouter({
      getExecutionClients: () => [
        {
          clientId: 'worker-1',
          name: 'worker-1',
          online: true,
          isDefault: false,
          activeTurns: 0,
          workspaces: [{ path: repoDir }],
          providers: [{ kind: 'claude', displayName: 'Claude', available: true, isDefault: true }],
          sessions: [
            {
              provider: 'claude',
              providerDisplayName: 'Claude',
              sdkSessionId: '5049209e-session',
              cwd: repoDir,
              preview: '提一个issue，在本项目内整理相关信息',
              mtime: Date.now(),
              size: 1024,
            },
          ],
        },
      ],
    });
    const adapterWithTopic = {
      ...adapter,
      startThreadWithTitle: vi.fn().mockResolvedValue({
        threadId: 'thread-history',
        rootMessageId: 'msg-title',
        messageId: 'msg-topic-start',
      }),
    };

    await topic.router.handle(adapterWithTopic, {
      channelType: 'feishu',
      chatId: 'c1',
      userId: 'u1',
      text: '/continue 5049209e-session',
      internalCommand: true,
      messageId: 'workbench-card',
    } as any);

    const [chatId, topicTitle, topicIntro] = (adapterWithTopic.startThreadWithTitle as any).mock
      .calls[0];
    expect(chatId).toBe('c1');
    expect(topicTitle).toBe('提一个issue，在本项目内整理相关信息');
    expect(topicIntro).toContain('5049209e');
    const metadataText = (adapterWithTopic.publishTopicMetadata as any).mock.calls[0][2];
    expect(extractTliveTopicMetadata(metadataText)).toMatchObject({
      provider: 'claude',
      cwd: repoDir,
      sdkSessionId: '5049209e-session',
      threadId: 'thread-history',
      rootMessageId: 'msg-title',
      entryMessageId: 'msg-topic-start',
    });
    const scopeId = chatScopeId('c1', 'thread-history');
    const binding = await store.getBinding('feishu', scopeId);
    expect(binding).toMatchObject({
      sdkSessionId: '5049209e-session',
      cwd: repoDir,
      clientId: 'worker-1',
    });
    expect(topic.topicSessions.findBySdkSessionId('5049209e-session')).toMatchObject({
      scopeId,
      rootMessageId: 'msg-title',
      entryMessageId: 'msg-topic-start',
      lastMessageId: 'msg-topic-start',
      title: '提一个issue，在本项目内整理相关信息',
    });
  });
});
