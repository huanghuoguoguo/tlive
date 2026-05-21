import { describe, expect, it, vi } from 'vitest';
import {
  AutomationPromptInjector,
} from '../../engine/automation/prompt-injector.js';

function createDeps(bindingOverrides: Record<string, unknown> = {}) {
  const binding = {
    channelType: 'feishu',
    chatId: 'chat-1',
    sessionId: 'session-1',
    sdkSessionId: 'sdk-1',
    cwd: '/repo/old',
    projectName: 'old',
    agentSettingSources: ['user'],
    createdAt: '',
    ...bindingOverrides,
  };
  const adapter = { channelType: 'feishu' };
  const store = {
    getBinding: vi.fn().mockImplementation(async () => binding),
    saveBinding: vi.fn().mockImplementation(async (nextBinding) => {
      Object.assign(binding, nextBinding);
    }),
  };
  const deps = {
    getAdapter: vi.fn().mockReturnValue(adapter),
    router: {
      resolve: vi.fn().mockResolvedValue(binding),
    },
    store,
    ingress: {
      recordChat: vi.fn(),
    },
    query: {
      run: vi.fn().mockResolvedValue(true),
    },
  } as any;

  return { deps, binding, adapter };
}

describe('AutomationPromptInjector', () => {
  it('rotates binding context before injecting a prompt when route settings change', async () => {
    const { deps, binding, adapter } = createDeps();
    const injector = new AutomationPromptInjector(deps);

    const result = await injector.inject({
      channelType: 'feishu',
      chatId: 'chat-1',
      text: 'analyze',
      requestId: 'req-1',
      workdir: '/repo/new',
      projectName: 'new',
      settingSources: ['user', 'project'],
    });

    expect(binding.cwd).toBe('/repo/new');
    expect(binding.projectName).toBe('new');
    expect(binding.agentSettingSources).toEqual(['user', 'project']);
    expect(binding.sessionId).not.toBe('session-1');
    expect(binding.sdkSessionId).toBeUndefined();
    expect(deps.store.saveBinding).toHaveBeenCalledWith(binding);
    expect(deps.ingress.recordChat).toHaveBeenCalledWith('feishu', 'chat-1');
    expect(deps.query.run).toHaveBeenCalledWith(
      adapter,
      expect.objectContaining({
        channelType: 'feishu',
        chatId: 'chat-1',
        userId: 'automation',
        text: 'analyze',
        messageId: 'automation-req-1',
        attachments: [],
      }),
      'req-1',
    );
    expect(result.sessionId).toBe(binding.sessionId);
  });

  it('does not save or rotate the binding when automation context is unchanged', async () => {
    const { deps, binding } = createDeps();
    const injector = new AutomationPromptInjector(deps);

    await injector.inject({
      channelType: 'feishu',
      chatId: 'chat-1',
      text: 'ping',
      workdir: '/repo/old',
      projectName: 'old',
      settingSources: ['user'],
    });

    expect(binding.sessionId).toBe('session-1');
    expect(binding.sdkSessionId).toBe('sdk-1');
    expect(deps.store.saveBinding).not.toHaveBeenCalled();
    expect(deps.query.run).toHaveBeenCalled();
  });

  it('rejects unavailable channels before mutating state', async () => {
    const { deps } = createDeps();
    deps.getAdapter.mockReturnValue(undefined);
    const injector = new AutomationPromptInjector(deps);

    await expect(
      injector.inject({
        channelType: 'feishu',
        chatId: 'chat-1',
        text: 'ping',
      }),
    ).rejects.toThrow("Channel 'feishu' not available");
    expect(deps.router.resolve).not.toHaveBeenCalled();
    expect(deps.query.run).not.toHaveBeenCalled();
  });
});
