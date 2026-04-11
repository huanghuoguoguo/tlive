import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CommandRouter } from '../engine/command-router.js';
import { SessionStateManager } from '../engine/session-state.js';
import { WorkspaceStateManager } from '../engine/workspace-state.js';
import { ChannelRouter } from '../engine/router.js';
import { JsonFileStore } from '../store/json-file.js';
import { ClaudeSDKProvider } from '../providers/claude-sdk.js';
import type { ClaudeSettingSource } from '../config.js';
import type { SDKEngine } from '../engine/sdk-engine.js';

describe('CommandRouter /settings', () => {
  let tmpDir: string;
  let store: JsonFileStore;
  let router: CommandRouter;
  let sdkEngine: Partial<SDKEngine>;
  let workspace: WorkspaceStateManager;
  let clearSessionWhitelist: (sessionId?: string) => void;
  let adapter: any;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tlive-command-router-'));
    store = new JsonFileStore(tmpDir);
    clearSessionWhitelist = vi.fn<(sessionId?: string) => void>();
    adapter = {
      channelType: 'telegram',
      send: vi.fn().mockResolvedValue(undefined),
      sendFormatted: vi.fn().mockResolvedValue(undefined),
    };

    // Mock SDKEngine with cleanupSession method
    sdkEngine = {
      cleanupSession: vi.fn<(channelType: string, chatId: string, reason: 'new' | 'switch' | 'cd' | 'settings' | 'expire', workdir?: string) => boolean>()
        .mockReturnValue(false),
      getActiveControls: vi.fn().mockReturnValue(new Map()),
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
      {
        clearSessionWhitelist,
        getPermissionStatus: vi.fn().mockReturnValue({
          rememberedTools: 0,
          rememberedBashPrefixes: 0,
        }),
      },
      ['user', 'project', 'local'],
      sdkEngine as SDKEngine,
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores settings overrides per chat and closes live sessions on change', async () => {
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
    expect(sdkEngine.cleanupSession).toHaveBeenCalledWith('telegram', 'c1', 'settings', undefined);
    expect(clearSessionWhitelist).toHaveBeenCalledWith('binding-1');
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
  });
});
