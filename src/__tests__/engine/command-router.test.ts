import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CommandRouter } from '../../engine/command-router.js';
import { SessionStateManager } from '../../engine/state/session-state.js';
import { WorkspaceStateManager } from '../../engine/state/workspace-state.js';
import { ChannelRouter } from '../../engine/utils/router.js';
import { JsonFileStore } from '../../store/json-file.js';
import { ClaudeSDKProvider } from '../../providers/claude-sdk.js';
import { loadProjectsConfig, type ClaudeSettingSource } from '../../config.js';
import type { SDKEngine } from '../../engine/sdk/engine.js';
import type { PermissionCoordinator } from '../../engine/coordinators/permission.js';
import * as sessionScanner from '../../session-scanner.js';

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
      channelType: 'telegram',
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
      () => new Map(),
      new ChannelRouter(store),
      store,
      '/tmp/project',
      Object.create(ClaudeSDKProvider.prototype) as ClaudeSDKProvider,
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
      channelType: 'telegram',
      chatId: 'c1',
      sessionId: 'binding-1',
      sdkSessionId: 'sdk-1',
      createdAt: '',
    });

    await router.handle(adapter, {
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u1',
      text: '/settings isolated',
      messageId: 'm1',
    } as any);

    const binding = await store.getBinding('telegram', 'c1');
    expect(binding?.claudeSettingSources).toEqual([]);
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
      channelType: 'telegram',
      chatId: 'c1',
      sessionId: 'binding-1',
      claudeSettingSources: [],
      createdAt: '',
    });

    await router.handle(adapter, {
      channelType: 'telegram',
      chatId: 'c2',
      userId: 'u2',
      text: '/settings',
      messageId: 'm2',
    } as any);

    expect(adapter.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Settings (default): **full** (user, project, local)'),
      }),
    );
  });

  it('preserves chat settings overrides across /new', async () => {
    await store.saveBinding({
      channelType: 'telegram',
      chatId: 'c1',
      sessionId: 'binding-1',
      sdkSessionId: 'sdk-1',
      projectName: 'repo',
      claudeSettingSources: ['user'] as ClaudeSettingSource[],
      cwd: '/tmp/project',
      createdAt: '',
    });

    await router.handle(adapter, {
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u1',
      text: '/new',
      messageId: 'm3',
    } as any);

    const binding = await store.getBinding('telegram', 'c1');
    expect(binding?.claudeSettingSources).toEqual(['user']);
    expect(binding?.projectName).toBe('repo');
  });

  it('tracks the current directory so /cd - returns to the immediate previous path', async () => {
    const dirA = join(tmpDir, 'a');
    const dirB = join(tmpDir, 'b');
    const dirC = join(tmpDir, 'c');
    mkdirSync(dirA);
    mkdirSync(dirB);
    mkdirSync(dirC);

    await store.saveBinding({
      channelType: 'telegram',
      chatId: 'c1',
      sessionId: 'binding-1',
      cwd: dirA,
      createdAt: '',
    });
    workspace.pushHistory('telegram', 'c1', dirA);

    await router.handle(adapter, {
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u1',
      text: `/cd ${dirB}`,
      messageId: 'm4',
    } as any);

    await router.handle(adapter, {
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u1',
      text: `/cd ${dirC}`,
      messageId: 'm5',
    } as any);

    await router.handle(adapter, {
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u1',
      text: '/cd -',
      messageId: 'm6',
    } as any);

    const binding = await store.getBinding('telegram', 'c1');
    expect(binding?.cwd).toBe(dirB);
    expect(workspace.getHistory('telegram', 'c1')).toEqual([dirB, dirC, dirA]);
  });

  it('applies project claudeSettingSources on /project use', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'tlive-home-'));
    const projectDir = join(homeDir, 'repo');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(homeDir, '.tlive'), { recursive: true });
    writeFileSync(join(homeDir, '.tlive', 'projects.json'), JSON.stringify({
      defaultProject: 'repo',
      projects: [
        {
          name: 'repo',
          workdir: projectDir,
          claudeSettingSources: ['user'],
        },
      ],
    }));
    process.env.HOME = homeDir;

    // Create new router with loaded projects config
    const projectsConfig = loadProjectsConfig();
    const projectPermissions = createMockPermissions();
    const testRouter = new CommandRouter(
      new SessionStateManager(),
      workspace,
      () => new Map(),
      new ChannelRouter(store),
      store,
      tmpDir,
      Object.create(ClaudeSDKProvider.prototype) as ClaudeSDKProvider,
      new Map(),
      projectPermissions,
      ['user', 'project', 'local'],
      sdkEngine as SDKEngine,
      projectsConfig,
    );

    await store.saveBinding({
      channelType: 'telegram',
      chatId: 'c1',
      sessionId: 'binding-1',
      cwd: tmpDir,
      claudeSettingSources: ['user', 'project', 'local'] as ClaudeSettingSource[],
      createdAt: '',
    });

    await testRouter.handle(adapter, {
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u1',
      text: '/project use repo',
      messageId: 'm7',
    } as any);

    const binding = await store.getBinding('telegram', 'c1');
    expect(binding?.projectName).toBe('repo');
    expect(binding?.cwd).toBe(projectDir);
    expect(binding?.claudeSettingSources).toEqual(['user']);

    rmSync(homeDir, { recursive: true, force: true });
  });

  it('does not cleanup session when /cd stays in the same git repo', async () => {
    const repoDir = join(tmpDir, 'repo');
    const subDir = join(repoDir, 'src');
    mkdirSync(join(repoDir, '.git'), { recursive: true });
    mkdirSync(subDir, { recursive: true });

    await store.saveBinding({
      channelType: 'telegram',
      chatId: 'c1',
      sessionId: 'binding-1',
      sdkSessionId: 'sdk-1',
      cwd: repoDir,
      projectName: 'repo',
      createdAt: '',
    });

    await router.handle(adapter, {
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u1',
      text: `/cd ${subDir}`,
      messageId: 'm8',
    } as any);

    expect(sdkEngine.cleanupSession).not.toHaveBeenCalled();
    expect(permissions.clearSessionWhitelist).not.toHaveBeenCalled();
    const binding = await store.getBinding('telegram', 'c1');
    expect(binding?.cwd).toBe(subDir);
    expect(binding?.sdkSessionId).toBe('sdk-1');
    expect(binding?.projectName).toBe('repo');
    expect(workspace.getBinding('telegram', 'c1')).toBe(repoDir);
  });

  it('cleans session and clears project binding when /cd crosses repos', async () => {
    const repoA = join(tmpDir, 'repo-a');
    const repoB = join(tmpDir, 'repo-b');
    mkdirSync(join(repoA, '.git'), { recursive: true });
    mkdirSync(join(repoB, '.git'), { recursive: true });

    await store.saveBinding({
      channelType: 'telegram',
      chatId: 'c1',
      sessionId: 'binding-1',
      sdkSessionId: 'sdk-1',
      cwd: repoA,
      projectName: 'repo-a',
      createdAt: '',
    });

    await router.handle(adapter, {
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u1',
      text: `/cd ${repoB}`,
      messageId: 'm9',
    } as any);

    expect(sdkEngine.cleanupSession).not.toHaveBeenCalled();
    expect(permissions.clearSessionWhitelist).not.toHaveBeenCalled();
    const binding = await store.getBinding('telegram', 'c1');
    expect(binding?.cwd).toBe(repoB);
    expect(binding?.sdkSessionId).toBeUndefined();
    expect(binding?.sessionId).not.toBe('binding-1');
    expect(binding?.projectName).toBeUndefined();
    expect(workspace.getBinding('telegram', 'c1')).toBe(repoB);
  });

  it('keeps session when switching project within same repo and same settings', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'tlive-home-'));
    const repoDir = join(homeDir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(join(repoDir, '.git'), { recursive: true });
    mkdirSync(join(homeDir, '.tlive'), { recursive: true });
    writeFileSync(join(homeDir, '.tlive', 'projects.json'), JSON.stringify({
      defaultProject: 'a',
      projects: [
        { name: 'a', workdir: repoDir, claudeSettingSources: ['user'] },
        { name: 'b', workdir: repoDir, claudeSettingSources: ['user'] },
      ],
    }));
    process.env.HOME = homeDir;

    // Create new router with loaded projects config
    const projectsConfig = loadProjectsConfig();
    const projectPermissions = createMockPermissions();
    const testRouter = new CommandRouter(
      new SessionStateManager(),
      workspace,
      () => new Map(),
      new ChannelRouter(store),
      store,
      repoDir,
      Object.create(ClaudeSDKProvider.prototype) as ClaudeSDKProvider,
      new Map(),
      projectPermissions,
      ['user', 'project', 'local'],
      sdkEngine as SDKEngine,
      projectsConfig,
    );

    await store.saveBinding({
      channelType: 'telegram',
      chatId: 'c1',
      sessionId: 'binding-1',
      sdkSessionId: 'sdk-1',
      cwd: repoDir,
      projectName: 'a',
      claudeSettingSources: ['user'] as ClaudeSettingSource[],
      createdAt: '',
    });

    await testRouter.handle(adapter, {
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u1',
      text: '/project use b',
      messageId: 'm10',
    } as any);

    expect(sdkEngine.cleanupSession).not.toHaveBeenCalled();
    expect(projectPermissions.clearSessionWhitelist).not.toHaveBeenCalled();
    const binding = await store.getBinding('telegram', 'c1');
    expect(binding?.projectName).toBe('b');
    expect(binding?.sdkSessionId).toBe('sdk-1');

    rmSync(homeDir, { recursive: true, force: true });
  });

  it('resets session when switching project changes settings in same repo', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'tlive-home-'));
    const repoDir = join(homeDir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(join(repoDir, '.git'), { recursive: true });
    mkdirSync(join(homeDir, '.tlive'), { recursive: true });
    writeFileSync(join(homeDir, '.tlive', 'projects.json'), JSON.stringify({
      defaultProject: 'a',
      projects: [
        { name: 'a', workdir: repoDir, claudeSettingSources: ['user'] },
        { name: 'b', workdir: repoDir, claudeSettingSources: ['user', 'project', 'local'] },
      ],
    }));
    process.env.HOME = homeDir;

    // Create new router with loaded projects config
    const projectsConfig = loadProjectsConfig();
    const projectPermissions = createMockPermissions();
    const testRouter = new CommandRouter(
      new SessionStateManager(),
      workspace,
      () => new Map(),
      new ChannelRouter(store),
      store,
      repoDir,
      Object.create(ClaudeSDKProvider.prototype) as ClaudeSDKProvider,
      new Map(),
      projectPermissions,
      ['user', 'project', 'local'],
      sdkEngine as SDKEngine,
      projectsConfig,
    );

    await store.saveBinding({
      channelType: 'telegram',
      chatId: 'c1',
      sessionId: 'binding-1',
      sdkSessionId: 'sdk-1',
      cwd: repoDir,
      projectName: 'a',
      claudeSettingSources: ['user'] as ClaudeSettingSource[],
      createdAt: '',
    });

    await testRouter.handle(adapter, {
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u1',
      text: '/project use b',
      messageId: 'm11',
    } as any);

    expect(sdkEngine.cleanupSession).not.toHaveBeenCalled();
    expect(projectPermissions.clearSessionWhitelist).not.toHaveBeenCalled();
    const binding = await store.getBinding('telegram', 'c1');
    expect(binding?.projectName).toBe('b');
    expect(binding?.sdkSessionId).toBeUndefined();
    expect(binding?.sessionId).not.toBe('binding-1');
    expect(binding?.claudeSettingSources).toEqual(['user', 'project', 'local']);

    rmSync(homeDir, { recursive: true, force: true });
  });

  it('clears project binding when /session --all switches to another repo', async () => {
    const repoA = join(tmpDir, 'repo-a');
    const repoB = join(tmpDir, 'repo-b');
    mkdirSync(join(repoA, '.git'), { recursive: true });
    mkdirSync(join(repoB, '.git'), { recursive: true });

    const scanSpy = vi.spyOn(sessionScanner, 'scanClaudeSessions').mockReturnValue([
      {
        sdkSessionId: 'sdk-target',
        cwd: repoB,
        preview: 'target session',
        mtime: Date.now(),
        size: 1024,
      },
    ] as any);

    await store.saveBinding({
      channelType: 'telegram',
      chatId: 'c1',
      sessionId: 'binding-1',
      sdkSessionId: 'sdk-1',
      cwd: repoA,
      projectName: 'repo-a',
      createdAt: '',
    });
    workspace.setBinding('telegram', 'c1', repoA);

    await router.handle(adapter, {
      channelType: 'telegram',
      chatId: 'c1',
      userId: 'u1',
      text: '/session --all 1',
      messageId: 'm12',
    } as any);

    expect(sdkEngine.cleanupSession).not.toHaveBeenCalled();
    expect(permissions.clearSessionWhitelist).not.toHaveBeenCalled();
    const binding = await store.getBinding('telegram', 'c1');
    expect(binding?.cwd).toBe(repoB);
    expect(binding?.sdkSessionId).toBe('sdk-target');
    expect(binding?.sessionId).not.toBe('binding-1');
    expect(binding?.projectName).toBeUndefined();
    expect(workspace.getBinding('telegram', 'c1')).toBe(repoB);

    scanSpy.mockRestore();
  });
});
