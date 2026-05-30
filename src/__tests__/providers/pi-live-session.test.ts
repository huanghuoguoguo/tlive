import { describe, expect, it, vi, beforeEach } from 'vitest';

const piSdkMocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  authStorageCreate: vi.fn(),
  modelRegistryCreate: vi.fn(),
  sessionManagerCreate: vi.fn(),
  sessionManagerOpen: vi.fn(),
  sessionManagerInMemory: vi.fn(),
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  VERSION: '0.78.0',
  getAgentDir: () => '/home/testuser/.pi/agent',
  AuthStorage: {
    create: piSdkMocks.authStorageCreate,
  },
  ModelRegistry: {
    create: piSdkMocks.modelRegistryCreate,
  },
  SessionManager: {
    create: piSdkMocks.sessionManagerCreate,
    open: piSdkMocks.sessionManagerOpen,
    inMemory: piSdkMocks.sessionManagerInMemory,
  },
  createAgentSession: piSdkMocks.createAgentSession,
}));

import { PiLiveSession } from '../../client/providers/pi-live-session.js';

describe('PiLiveSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    piSdkMocks.authStorageCreate.mockReturnValue({ auth: true });
    piSdkMocks.modelRegistryCreate.mockReturnValue({
      getAll: () => [],
      getAvailable: () => [],
      find: () => undefined,
    });
    piSdkMocks.sessionManagerCreate.mockReturnValue({ mode: 'create' });
    piSdkMocks.sessionManagerOpen.mockReturnValue({ mode: 'open' });
    piSdkMocks.sessionManagerInMemory.mockReturnValue({ mode: 'memory' });
  });

  it('creates a Pi SDK session and streams canonical events', async () => {
    const messages = [
      {
        role: 'assistant',
        usage: {
          input: 3,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { total: 0.001 },
        },
      },
    ];
    const listeners: Array<(event: any) => void> = [];
    const session = {
      sessionFile: '/tmp/pi-session.jsonl',
      sessionId: 'pi-session-id',
      model: { provider: 'anthropic', id: 'claude-sonnet-4-5' },
      thinkingLevel: 'high',
      messages,
      subscribe: vi.fn((listener: (event: any) => void) => {
        listeners.push(listener);
        return () => {};
      }),
      prompt: vi.fn(async () => {
        for (const listener of listeners) {
          listener({
            type: 'message_update',
            message: {},
            assistantMessageEvent: { type: 'text_delta', delta: 'done' },
          });
        }
        for (const listener of listeners) {
          listener({ type: 'agent_end', messages, willRetry: false });
        }
      }),
      steer: vi.fn(),
      followUp: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn(),
    };
    piSdkMocks.createAgentSession.mockResolvedValue({ session });

    const live = new PiLiveSession({ workingDirectory: '/repo', effort: 'high' });
    const result = live.startTurn('hello');
    const events = await collect(result.stream);

    expect(piSdkMocks.sessionManagerCreate).toHaveBeenCalledWith('/repo', undefined);
    expect(piSdkMocks.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/repo',
        thinkingLevel: 'high',
      }),
    );
    expect(session.prompt).toHaveBeenCalledWith('hello', {
      expandPromptTemplates: true,
    });
    expect(events).toEqual([
      {
        kind: 'status',
        sessionId: '/tmp/pi-session.jsonl',
        model: 'anthropic/claude-sonnet-4-5',
      },
      { kind: 'text_delta', text: 'done' },
      {
        kind: 'query_result',
        sessionId: '/tmp/pi-session.jsonl',
        isError: false,
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          costUsd: 0.001,
        },
      },
    ]);
  });

  it('uses Pi steer and follow-up APIs for native priority messages', async () => {
    const session = {
      sessionFile: undefined,
      sessionId: 'pi-session-id',
      model: undefined,
      thinkingLevel: 'off',
      messages: [],
      subscribe: vi.fn(() => () => {}),
      prompt: vi.fn(),
      steer: vi.fn(),
      followUp: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn(),
    };
    piSdkMocks.createAgentSession.mockResolvedValue({ session });

    const live = new PiLiveSession({ workingDirectory: '/repo' });
    await live.sendWithPriority('now', 'now');
    await live.sendWithPriority('later', 'later');

    expect(session.steer).toHaveBeenCalledWith('now');
    expect(session.followUp).toHaveBeenCalledWith('later');
  });

  it('uses TL_PI_PROVIDER to select a provider model when no explicit model is set', async () => {
    const anthropicModel = { provider: 'anthropic', id: 'claude-sonnet-4-5' };
    piSdkMocks.modelRegistryCreate.mockReturnValue({
      getAll: () => [{ provider: 'openai', id: 'gpt-5.1-codex' }, anthropicModel],
      getAvailable: () => [anthropicModel],
      find: () => undefined,
    });
    const session = {
      sessionFile: undefined,
      sessionId: 'pi-session-id',
      model: anthropicModel,
      thinkingLevel: 'off',
      messages: [],
      subscribe: vi.fn(() => () => {}),
      prompt: vi.fn(),
      steer: vi.fn(),
      followUp: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn(),
    };
    piSdkMocks.createAgentSession.mockResolvedValue({ session });

    const live = new PiLiveSession({ workingDirectory: '/repo', provider: 'anthropic' });
    await live.sendWithPriority('now', 'now');

    expect(piSdkMocks.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: anthropicModel }),
    );
  });
});

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const events: T[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) return events;
    events.push(value);
  }
}
