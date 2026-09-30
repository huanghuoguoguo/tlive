import { describe, expect, it, vi, beforeEach } from 'vitest';

const piSdkMocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  modelRuntimeCreate: vi.fn(),
  settingsManagerCreate: vi.fn(),
  applyOverrides: vi.fn(),
  sessionManagerCreate: vi.fn(),
  sessionManagerOpen: vi.fn(),
  sessionManagerInMemory: vi.fn(),
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  VERSION: '0.85.1',
  getAgentDir: () => '/home/testuser/.pi/agent',
  ModelRuntime: {
    create: piSdkMocks.modelRuntimeCreate,
  },
  SettingsManager: {
    create: piSdkMocks.settingsManagerCreate,
  },
  SessionManager: {
    create: piSdkMocks.sessionManagerCreate,
    open: piSdkMocks.sessionManagerOpen,
    inMemory: piSdkMocks.sessionManagerInMemory,
  },
  createAgentSession: piSdkMocks.createAgentSession,
}));

import { PiLiveSession } from '../../client/providers/pi-live-session.js';
import { CommandBlockedError, NoActiveTurnError } from '../../shared/providers/errors.js';

describe('PiLiveSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    piSdkMocks.modelRuntimeCreate.mockResolvedValue({
      getModels: () => [],
      getAvailableSnapshot: () => [],
      getModel: () => undefined,
    });
    piSdkMocks.applyOverrides.mockReset();
    mockCompactionSettings();
    const emptySessionContext = { messages: [], model: undefined };
    piSdkMocks.sessionManagerCreate.mockReturnValue({
      mode: 'create',
      buildSessionContext: () => emptySessionContext,
    });
    piSdkMocks.sessionManagerOpen.mockReturnValue({
      mode: 'open',
      buildSessionContext: () => emptySessionContext,
    });
    piSdkMocks.sessionManagerInMemory.mockReturnValue({
      mode: 'memory',
      buildSessionContext: () => emptySessionContext,
    });
  });

  it('creates a Pi SDK session and streams canonical events', async () => {
    const finalMessage = {
      role: 'assistant',
      usage: {
        input: 3,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: 0.001 },
      },
    };
    const messages: unknown[] = [];
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
      bindExtensions: vi.fn(),
      prompt: vi.fn(async () => {
        for (const listener of listeners) {
          listener({
            type: 'message_update',
            message: {},
            assistantMessageEvent: { type: 'text_delta', delta: 'done' },
          });
        }
        for (const listener of listeners) {
          listener({ type: 'agent_end', messages: [], willRetry: false });
        }
        messages.push(finalMessage);
      }),
      steer: vi.fn(),
      followUp: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn(),
      getContextUsage: vi.fn(() => ({
        tokens: 5,
        contextWindow: 128000,
        percent: (5 / 128000) * 100,
      })),
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
        kind: 'context_usage',
        tokens: 5,
        contextWindow: 128000,
        percent: (5 / 128000) * 100,
      },
      {
        kind: 'query_result',
        sessionId: '/tmp/pi-session.jsonl',
        isError: false,
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          contextTokens: 5,
          costUsd: 0.001,
        },
      },
    ]);
  });

  it('restores the model saved in an existing Pi session instead of applying the configured default', async () => {
    const savedModel = { provider: 'openai', id: 'gpt-5.2' };
    const sessionManager = {
      mode: 'open',
      buildSessionContext: () => ({ messages: [{ role: 'user', content: 'hello' }], model: {
        provider: savedModel.provider,
        modelId: savedModel.id,
      } }),
    };
    piSdkMocks.sessionManagerOpen.mockReturnValue(sessionManager);
    const session = {
      sessionFile: '/tmp/pi-session.jsonl',
      sessionId: 'pi-session-id',
      model: savedModel,
      thinkingLevel: 'high',
      messages: [{ role: 'user', content: 'hello' }],
      subscribe: vi.fn(() => () => {}),
      bindExtensions: vi.fn(),
      prompt: vi.fn(async () => {}),
      steer: vi.fn(),
      followUp: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn(),
      getContextUsage: vi.fn(() => undefined),
    };
    piSdkMocks.createAgentSession.mockResolvedValue({ session });

    const live = new PiLiveSession({
      workingDirectory: '/repo',
      sessionId: '/etc/hosts',
      model: 'anthropic/claude-sonnet-4-5',
    });
    await collect(live.startTurn('continue').stream);

    expect(piSdkMocks.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionManager }),
    );
    expect(piSdkMocks.createAgentSession.mock.calls[0][0]).not.toHaveProperty('model');
    expect(live.runtimeInfo.model).toBe('openai/gpt-5.2');
  });

  it('injects into a running Pi agent run through steer and follow-up', async () => {
    const harness = makeSteerableSession();
    piSdkMocks.createAgentSession.mockResolvedValue({ session: harness.session });

    const live = new PiLiveSession({ workingDirectory: '/repo' });
    const reader = live.startTurn('busy work').stream.getReader();
    // Wait for the SDK prompt, not just the status emitted before binding extensions.
    await reader.read();
    await vi.waitFor(() => expect(harness.session.prompt).toHaveBeenCalledTimes(1));
    harness.state.streaming = true;

    await live.sendWithPriority('side note', 'now');
    await live.sendWithPriority('after this', 'later');

    expect(harness.session.steer).toHaveBeenCalledWith('side note');
    expect(harness.session.followUp).toHaveBeenCalledWith('after this');

    harness.releasePrompt();
    await reader.cancel().catch(() => {});
  });

  it('refuses to inject when Pi has no agent run, without lazily opening a session', async () => {
    const harness = makeSteerableSession();
    harness.state.streaming = true;
    piSdkMocks.createAgentSession.mockResolvedValue({ session: harness.session });

    const live = new PiLiveSession({ workingDirectory: '/repo' });

    // Pi's steer()/followUp() resolve even with nothing draining them, so an
    // accepted injection here would silently lose the message.
    await expect(live.sendWithPriority('side note', 'now')).rejects.toBeInstanceOf(
      NoActiveTurnError,
    );
    await expect(live.sendWithPriority('side note', 'later')).rejects.toBeInstanceOf(
      NoActiveTurnError,
    );
    expect(piSdkMocks.createAgentSession).not.toHaveBeenCalled();
    expect(harness.session.steer).not.toHaveBeenCalled();
    expect(harness.session.followUp).not.toHaveBeenCalled();
  });

  it('refuses to inject into an idle Pi session whose queue nothing drains', async () => {
    const harness = makeSteerableSession();
    harness.state.streaming = true;
    piSdkMocks.createAgentSession.mockResolvedValue({ session: harness.session });

    const live = new PiLiveSession({ workingDirectory: '/repo' });
    const reader = live.startTurn('busy work').stream.getReader();
    await reader.read();
    await vi.waitFor(() => expect(harness.session.prompt).toHaveBeenCalledTimes(1));

    // The agent run is over but the bridge still holds the session: pi is idle,
    // its steer/followUp queues have nothing left to drain them.
    harness.state.streaming = false;

    await expect(live.sendWithPriority('too late', 'now')).rejects.toBeInstanceOf(
      NoActiveTurnError,
    );
    await expect(live.sendWithPriority('too late', 'later')).rejects.toBeInstanceOf(
      NoActiveTurnError,
    );
    expect(harness.session.steer).not.toHaveBeenCalled();
    expect(harness.session.followUp).not.toHaveBeenCalled();

    harness.releasePrompt();
    await reader.cancel().catch(() => {});
  });

  it('returns from interruptTurn once the abort signal is sent, not once Pi is idle', async () => {
    const harness = makeSteerableSession();
    piSdkMocks.createAgentSession.mockResolvedValue({ session: harness.session });

    let settleAbort: () => void = () => {};
    harness.session.abort.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settleAbort = resolve;
        }),
    );

    const live = new PiLiveSession({ workingDirectory: '/repo' });
    const reader = live.startTurn('busy work').stream.getReader();
    await reader.read();
    await vi.waitFor(() => expect(harness.session.prompt).toHaveBeenCalledTimes(1));
    harness.state.streaming = true;

    // pi's abort() waits for the agent run to unwind, which can lag the signal by
    // minutes while the upstream retries. The worker's control reply — and with it
    // the whole inbound loop — must not sit on that.
    await live.interruptTurn();
    expect(harness.session.abort).toHaveBeenCalledTimes(1);

    settleAbort();
    await reader.cancel().catch(() => {});
  });

  it('still emits the terminal result when an interrupted owning prompt settles', async () => {
    const harness = makeSteerableSession();
    const completion = deferred<void>();
    const messages: unknown[] = [];
    const session = {
      ...harness.session,
      messages,
      prompt: vi.fn(async () => {
        await completion.promise;
        messages.push({ role: 'assistant', stopReason: 'aborted' });
      }),
    };
    piSdkMocks.createAgentSession.mockResolvedValue({ session });
    const live = new PiLiveSession({ workingDirectory: '/repo' });
    const events = collect(live.startTurn('work').stream);
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1));
    await live.interruptTurn();
    completion.resolve();

    expect((await events).at(-1)).toMatchObject({
      kind: 'query_result',
      isError: true,
      error: 'Interrupted',
    });
    expect(live.isTurnActive).toBe(false);
  });

  it('keeps an abort that fails after interrupting out of the caller', async () => {
    const harness = makeSteerableSession();
    piSdkMocks.createAgentSession.mockResolvedValue({ session: harness.session });
    harness.session.abort.mockRejectedValue(new Error('agent run refused to settle'));

    const live = new PiLiveSession({ workingDirectory: '/repo' });
    const reader = live.startTurn('busy work').stream.getReader();
    await reader.read();
    await vi.waitFor(() => expect(harness.session.prompt).toHaveBeenCalledTimes(1));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await live.interruptTurn();
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('abort did not settle'));
    });
    warn.mockRestore();

    harness.releasePrompt();
    await reader.cancel().catch(() => {});
  });

  it('takes over a turn the bridge abandoned instead of refusing every later message', async () => {
    const harness = makeSteerableSession();
    piSdkMocks.createAgentSession.mockResolvedValue({ session: harness.session });
    const promptTexts: string[] = [];
    let releaseSecondPrompt: () => void = () => {};
    harness.session.prompt.mockImplementation((text: string) => {
      promptTexts.push(text);
      return text === 'wedged run'
        ? new Promise<void>(() => {})
        : new Promise<void>((resolve) => {
            releaseSecondPrompt = resolve;
          });
    });
    harness.session.abort.mockImplementation(async () => {
      harness.state.streaming = false;
    });

    const live = new PiLiveSession({ workingDirectory: '/repo' });
    const first = live.startTurn('wedged run').stream.getReader();
    await first.read();
    await vi.waitFor(() => expect(harness.session.prompt).toHaveBeenCalledTimes(1));
    harness.state.streaming = true;

    // The bridge stops holding a turn once its processing flag expires, so a wedged
    // local run must not keep rejecting everything that follows it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const second = live.startTurn('next message').stream.getReader();

    expect(await second.read()).toMatchObject({ value: { kind: 'status' } });
    await vi.waitFor(() => expect(promptTexts).toEqual(['wedged run', 'next message']));
    await expect(first.read()).resolves.toMatchObject({ done: true });
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('still streaming'));
    warn.mockRestore();

    releaseSecondPrompt();
    await second.cancel().catch(() => {});
  });

  it('only prompts the owning turn when another turn takes over during SDK creation', async () => {
    const harness = makeSteerableSession();
    const initialization = deferred<{ session: typeof harness.session }>();
    const completion = deferred<void>();
    piSdkMocks.createAgentSession.mockReturnValue(initialization.promise);
    let listener: (event: any) => void = () => {};
    harness.session.subscribe.mockImplementation((callback: (event: any) => void) => {
      listener = callback;
      return () => {};
    });
    harness.session.prompt.mockImplementation(async (text: string) => {
      if (harness.state.streaming) throw new Error('Agent already processing');
      harness.state.streaming = true;
      listener({
        type: 'message_update',
        message: {},
        assistantMessageEvent: { type: 'text_delta', delta: text },
      });
      await completion.promise;
      harness.state.streaming = false;
    });

    const live = new PiLiveSession({ workingDirectory: '/repo' });
    const onTurnComplete = vi.fn();
    live.setLifecycleCallbacks({ onTurnComplete });
    const first = live.startTurn('retired prompt');
    const firstEvents = collect(first.stream);
    await vi.waitFor(() => expect(piSdkMocks.createAgentSession).toHaveBeenCalledTimes(1));
    const ask = vi.fn(async () => ({ question: 'answer from owner' }));
    const secondEvents = collect(live.startTurn('owning prompt', { onAskUserQuestion: ask }).stream);
    initialization.resolve({ session: harness.session });

    expect(await firstEvents).toEqual([]);
    await vi.waitFor(() => expect(harness.session.prompt).toHaveBeenCalledTimes(1));
    expect(harness.session.prompt).toHaveBeenCalledWith('owning prompt', {
      expandPromptTemplates: true,
    });
    expect(piSdkMocks.createAgentSession).toHaveBeenCalledTimes(1);
    expect(harness.session.bindExtensions).toHaveBeenCalledTimes(1);
    expect(harness.session.subscribe).toHaveBeenCalledTimes(1);
    expect(live.isTurnActive).toBe(true);
    expect(onTurnComplete).not.toHaveBeenCalled();
    await first.controls!.interrupt();
    expect(harness.session.abort).not.toHaveBeenCalled();
    const bindings = harness.session.bindExtensions.mock.calls[0][0];
    await expect(bindings.uiContext.input('question')).resolves.toBe('answer from owner');
    expect(ask).toHaveBeenCalledTimes(1);

    completion.resolve();
    const events = await secondEvents;
    expect(events).toContainEqual({ kind: 'text_delta', text: 'owning prompt' });
    expect(events.at(-1)).toMatchObject({ kind: 'query_result', isError: false });
    expect(live.isTurnActive).toBe(false);
    expect(onTurnComplete).toHaveBeenCalledTimes(1);
  });

  it.each(['controls', 'session', 'cancel', 'close'] as const)(
    'does not start a turn %s stopped while SDK creation was pending',
    async (stop) => {
      const harness = makeSteerableSession();
      const initialization = deferred<{ session: typeof harness.session }>();
      piSdkMocks.createAgentSession.mockReturnValue(initialization.promise);
      const live = new PiLiveSession({ workingDirectory: '/repo' });
      const turn = live.startTurn('do not prompt');
      const reader = turn.stream.getReader();
      const pendingRead = reader.read();
      await vi.waitFor(() => expect(piSdkMocks.createAgentSession).toHaveBeenCalledTimes(1));

      if (stop === 'controls') await turn.controls!.interrupt();
      else if (stop === 'session') await live.interruptTurn();
      else if (stop === 'cancel') await reader.cancel();
      else live.close();
      initialization.resolve({ session: harness.session });

      await expect(pendingRead).resolves.toMatchObject({ done: true });
      await new Promise((resolve) => setImmediate(resolve));
      expect(harness.session.bindExtensions).not.toHaveBeenCalled();
      expect(harness.session.subscribe).not.toHaveBeenCalled();
      expect(harness.session.prompt).not.toHaveBeenCalled();
      expect(live.isTurnActive).toBe(false);
    },
  );

  it('does not prompt a retired turn when its extension binding finishes after takeover', async () => {
    const harness = makeSteerableSession();
    const binding = deferred<void>();
    piSdkMocks.createAgentSession.mockResolvedValue({ session: harness.session });
    harness.session.bindExtensions.mockImplementationOnce(() => binding.promise);
    const live = new PiLiveSession({ workingDirectory: '/repo' });
    const first = collect(live.startTurn('retired prompt').stream);
    await vi.waitFor(() => expect(harness.session.bindExtensions).toHaveBeenCalledTimes(1));

    const ask = vi.fn(async () => ({ question: 'new handler' }));
    const second = collect(live.startTurn('owning prompt', { onAskUserQuestion: ask }).stream);
    await vi.waitFor(() => expect(harness.session.prompt).toHaveBeenCalledTimes(1));
    binding.resolve();
    await first;
    await new Promise((resolve) => setImmediate(resolve));

    expect(harness.session.prompt).toHaveBeenCalledWith('owning prompt', {
      expandPromptTemplates: true,
    });
    expect(harness.session.prompt).toHaveBeenCalledTimes(1);
    expect(harness.session.subscribe).toHaveBeenCalledTimes(1);
    expect(live.isTurnActive).toBe(true);
    const bindings = harness.session.bindExtensions.mock.calls[1][0];
    await expect(bindings.uiContext.input('question')).resolves.toBe('new handler');
    harness.releasePrompt();
    expect((await second).at(-1)).toMatchObject({ kind: 'query_result', isError: false });
  });

  it('skips a retired handoff waiter and ignores the old prompt completing after takeover', async () => {
    const harness = makeSteerableSession();
    const idle = deferred<void>();
    const oldCompletion = deferred<void>();
    const newCompletion = deferred<void>();
    piSdkMocks.createAgentSession.mockResolvedValue({ session: harness.session });
    harness.session.abort.mockImplementation(() => idle.promise);
    harness.session.prompt.mockImplementation((text: string) =>
      text === 'old run' ? oldCompletion.promise : newCompletion.promise,
    );
    const live = new PiLiveSession({ workingDirectory: '/repo' });
    const onTurnComplete = vi.fn();
    live.setLifecycleCallbacks({ onTurnComplete });
    const first = collect(live.startTurn('old run').stream);
    await vi.waitFor(() => expect(harness.session.prompt).toHaveBeenCalledTimes(1));
    const second = collect(live.startTurn('retired waiter').stream);
    await new Promise((resolve) => setImmediate(resolve));
    const third = collect(live.startTurn('owning prompt').stream);
    idle.resolve();
    await vi.waitFor(() => expect(harness.session.prompt).toHaveBeenCalledTimes(2));
    expect(harness.session.prompt.mock.calls.map(([text]) => text)).toEqual([
      'old run',
      'owning prompt',
    ]);
    expect(await second).toEqual([]);

    oldCompletion.resolve();
    await first;
    await new Promise((resolve) => setImmediate(resolve));
    expect(harness.session.getContextUsage).not.toHaveBeenCalled();
    expect(live.isTurnActive).toBe(true);
    expect(onTurnComplete).not.toHaveBeenCalled();
    newCompletion.resolve();
    expect((await third).at(-1)).toMatchObject({ kind: 'query_result', isError: false });
    expect(harness.session.getContextUsage).toHaveBeenCalledTimes(1);
    expect(onTurnComplete).toHaveBeenCalledTimes(1);
  });

  it('waits for the abandoned run to go idle before handing Pi the next prompt', async () => {
    const harness = makeSteerableSession();
    piSdkMocks.createAgentSession.mockResolvedValue({ session: harness.session });
    harness.session.prompt.mockImplementation(() => new Promise<void>(() => {}));
    let settleAbort: () => void = () => {};
    harness.session.abort.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settleAbort = resolve;
        }),
    );

    const live = new PiLiveSession({ workingDirectory: '/repo' });
    const first = live.startTurn('wedged run').stream.getReader();
    await first.read();
    await vi.waitFor(() => expect(harness.session.prompt).toHaveBeenCalledTimes(1));
    harness.state.streaming = true;

    const second = live.startTurn('next message').stream.getReader();
    const nextStatus = second.read();
    await new Promise((resolve) => setImmediate(resolve));

    // Prompting pi while it still reports a live run is rejected by the SDK, so the
    // handoff has to ride on abort() settling first.
    expect(harness.session.prompt).toHaveBeenCalledTimes(1);
    settleAbort();
    harness.state.streaming = false;
    await expect(nextStatus).resolves.toMatchObject({ value: { kind: 'status' } });
    await vi.waitFor(() => expect(harness.session.prompt).toHaveBeenCalledTimes(2));

    await second.cancel().catch(() => {});
  });

  it('prompts anyway once the handoff window expires on a run that never releases', async () => {
    vi.useFakeTimers();
    try {
      const harness = makeSteerableSession();
      piSdkMocks.createAgentSession.mockResolvedValue({ session: harness.session });
      harness.session.prompt.mockImplementation(() => new Promise<void>(() => {}));
      harness.session.abort.mockImplementation(() => new Promise<void>(() => {}));

      const live = new PiLiveSession({ workingDirectory: '/repo' });
      const first = live.startTurn('wedged run').stream.getReader();
      await first.read();
      await vi.waitFor(() => expect(harness.session.prompt).toHaveBeenCalledTimes(1));
      harness.state.streaming = true;

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const second = live.startTurn('next message').stream.getReader();
      const nextStatus = second.read();
      await vi.advanceTimersByTimeAsync(15_000);

      await expect(nextStatus).resolves.toMatchObject({ value: { kind: 'status' } });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('still streaming'));
      warn.mockRestore();

      await second.cancel().catch(() => {});
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the session when the bridge cancels the stream', async () => {
    const harness = makeSteerableSession();
    piSdkMocks.createAgentSession.mockResolvedValue({ session: harness.session });
    harness.session.prompt.mockImplementation(() => new Promise<void>(() => {}));

    const live = new PiLiveSession({ workingDirectory: '/repo' });
    const reader = live.startTurn('busy work').stream.getReader();
    await reader.read();
    await vi.waitFor(() => expect(harness.session.prompt).toHaveBeenCalledTimes(1));
    harness.state.streaming = true;

    await reader.cancel();
    expect(live.isTurnActive).toBe(false);
    expect(harness.session.abort).toHaveBeenCalledTimes(1);

    const next = live.startTurn('next message').stream.getReader();
    expect(await next.read()).toMatchObject({ value: { kind: 'status' } });
    await vi.waitFor(() => expect(harness.session.prompt).toHaveBeenCalledTimes(2));
    // Only the cancelled turn's handoff aborted pi; taking over a released session must not.
    expect(harness.session.abort).toHaveBeenCalledTimes(1);

    await next.cancel().catch(() => {});
  });

  it('handles /model provider/model by switching the Pi session without prompting the LLM', async () => {
    const currentModel = { provider: 'jdy', id: 'Kimi-K2.5' };
    const targetModel = { provider: 'openai', id: 'gpt-5.2' };
    const modelRuntime = {
      getModels: vi.fn(() => [currentModel, targetModel]),
      getAvailableSnapshot: vi.fn(() => [currentModel, targetModel]),
      getModel: vi.fn((provider: string, modelId: string) =>
        provider === targetModel.provider && modelId === targetModel.id ? targetModel : undefined,
      ),
    };
    const session: any = {
      sessionFile: '/tmp/pi-session.jsonl',
      sessionId: 'pi-session-id',
      model: currentModel,
      modelRuntime,
      thinkingLevel: 'high',
      messages: [],
      subscribe: vi.fn(() => () => {}),
      bindExtensions: vi.fn(),
      prompt: vi.fn(),
      setModel: vi.fn(async (model: unknown) => {
        session.model = model;
      }),
      steer: vi.fn(),
      followUp: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn(),
      getContextUsage: vi.fn(() => ({
        tokens: 1234,
        contextWindow: 256000,
        percent: (1234 / 256000) * 100,
      })),
    };
    piSdkMocks.createAgentSession.mockResolvedValue({ session });

    const live = new PiLiveSession({ workingDirectory: '/repo' });
    const events = await collect(live.startTurn('/model openai/gpt-5.2').stream);

    expect(modelRuntime.getModel).toHaveBeenCalledWith('openai', 'gpt-5.2');
    expect(session.setModel).toHaveBeenCalledWith(targetModel);
    expect(session.prompt).not.toHaveBeenCalled();
    expect(live.runtimeInfo.model).toBe('openai/gpt-5.2');
    expect(events).toEqual([
      {
        kind: 'status',
        sessionId: '/tmp/pi-session.jsonl',
        model: 'jdy/Kimi-K2.5',
      },
      {
        kind: 'status',
        sessionId: '/tmp/pi-session.jsonl',
        model: 'openai/gpt-5.2',
      },
      { kind: 'text_delta', text: 'Model switched to openai/gpt-5.2' },
      {
        kind: 'context_usage',
        tokens: 1234,
        contextWindow: 256000,
        percent: (1234 / 256000) * 100,
      },
      {
        kind: 'query_result',
        sessionId: '/tmp/pi-session.jsonl',
        isError: false,
        usage: { inputTokens: 0, outputTokens: 0, contextTokens: 1234 },
      },
    ]);
  });

  it('rejects /model without a provider/model argument instead of prompting the LLM', async () => {
    const session = {
      sessionFile: '/tmp/pi-session.jsonl',
      sessionId: 'pi-session-id',
      model: { provider: 'jdy', id: 'Kimi-K2.5' },
      modelRuntime: {
        getModels: () => [],
        getAvailableSnapshot: () => [],
        getModel: vi.fn(),
      },
      thinkingLevel: 'high',
      messages: [],
      subscribe: vi.fn(() => () => {}),
      bindExtensions: vi.fn(),
      prompt: vi.fn(),
      setModel: vi.fn(),
      steer: vi.fn(),
      followUp: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn(),
      getContextUsage: vi.fn(),
    };
    piSdkMocks.createAgentSession.mockResolvedValue({ session });

    const live = new PiLiveSession({ workingDirectory: '/repo' });
    const events = await collect(live.startTurn('/model').stream);

    expect(session.setModel).not.toHaveBeenCalled();
    expect(session.prompt).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({
      kind: 'query_result',
      sessionId: '/tmp/pi-session.jsonl',
      isError: true,
      usage: { inputTokens: 0, outputTokens: 0 },
      error: 'Usage: /model <provider/model>',
    });
  });

  it('uses TL_PI_PROVIDER to select a provider model when no explicit model is set', async () => {
    const anthropicModel = { provider: 'anthropic', id: 'claude-sonnet-4-5' };
    piSdkMocks.modelRuntimeCreate.mockResolvedValue({
      getModels: () => [{ provider: 'openai', id: 'gpt-5.1-codex' }, anthropicModel],
      getAvailableSnapshot: () => [anthropicModel],
      getModel: () => undefined,
    });
    const session = {
      sessionFile: undefined,
      sessionId: 'pi-session-id',
      model: anthropicModel,
      thinkingLevel: 'off',
      messages: [],
      subscribe: vi.fn(() => () => {}),
      bindExtensions: vi.fn(),
      prompt: vi.fn(),
      steer: vi.fn(),
      followUp: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn(),
    };
    piSdkMocks.createAgentSession.mockResolvedValue({ session });

    const live = new PiLiveSession({ workingDirectory: '/repo', provider: 'anthropic' });
    await collect(live.startTurn('hello').stream);

    expect(piSdkMocks.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: anthropicModel }),
    );
  });

  it('runs /compact through the Pi SDK instead of sending it to the model', async () => {
    const session = makeCompactSession({ tokensBefore: 99072 });
    piSdkMocks.createAgentSession.mockResolvedValue({ session });

    const live = new PiLiveSession({ workingDirectory: '/repo' });
    const events = await collect(live.startTurn('/compact').stream);

    expect(session.compact).toHaveBeenCalledWith(undefined);
    expect(session.prompt).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      kind: 'text_delta',
      text: '📦 已压缩上下文（压缩前 99072 tokens）',
    });
    expect(events.at(-1)).toMatchObject({ kind: 'query_result', isError: false });
  });

  it('passes /compact instructions to the Pi SDK', async () => {
    const session = makeCompactSession({ tokensBefore: 5000 });
    piSdkMocks.createAgentSession.mockResolvedValue({ session });

    const live = new PiLiveSession({ workingDirectory: '/repo' });
    await collect(live.startTurn('/compact 重点保留接口约定').stream);

    expect(session.compact).toHaveBeenCalledWith('重点保留接口约定');
  });

  it('surfaces a rejected /compact as a failed turn', async () => {
    const session = makeCompactSession();
    session.compact.mockRejectedValue(new Error('Already compacted'));
    piSdkMocks.createAgentSession.mockResolvedValue({ session });

    const live = new PiLiveSession({ workingDirectory: '/repo' });
    const events = await collect(live.startTurn('/compact').stream);

    expect(events.at(-1)).toMatchObject({
      kind: 'query_result',
      isError: true,
      error: 'Already compacted',
    });
  });

  it('refuses to steer Pi built-in commands into a running turn', async () => {
    const harness = makeSteerableSession();
    piSdkMocks.createAgentSession.mockResolvedValue({ session: harness.session });

    const live = new PiLiveSession({ workingDirectory: '/repo' });
    const reader = live.startTurn('busy work').stream.getReader();
    await reader.read();
    await vi.waitFor(() => expect(harness.session.prompt).toHaveBeenCalledTimes(1));
    harness.state.streaming = true;

    await expect(live.sendWithPriority('/compact', 'now')).rejects.toBeInstanceOf(
      CommandBlockedError,
    );
    expect(harness.session.steer).not.toHaveBeenCalled();

    await live.sendWithPriority('继续，别忘了补测试', 'now');
    expect(harness.session.steer).toHaveBeenCalledWith('继续，别忘了补测试');

    harness.releasePrompt();
    await reader.cancel().catch(() => {});
  });

  it('reports a missing turn, not a blocked command, when Pi is idle', async () => {
    // Idle is the signal for the bridge to open a fresh turn, which is how
    // /model and /compact actually run.
    const live = new PiLiveSession({ workingDirectory: '/repo' });

    await expect(live.sendWithPriority('/model anthropic/claude', 'now')).rejects.toBeInstanceOf(
      NoActiveTurnError,
    );
  });

  it('ignores steerTurn when no Pi run exists to drain it', async () => {
    const harness = makeSteerableSession();
    harness.state.streaming = true;
    piSdkMocks.createAgentSession.mockResolvedValue({ session: harness.session });

    const live = new PiLiveSession({ workingDirectory: '/repo' });
    live.steerTurn('note');

    expect(piSdkMocks.createAgentSession).not.toHaveBeenCalled();
    expect(harness.session.steer).not.toHaveBeenCalled();
  });

  it('reserves a share of the window so compaction triggers before the wall', async () => {
    const session = makeCompactSession({ tokensBefore: 1 }, 118888);
    piSdkMocks.createAgentSession.mockResolvedValue({ session });

    const live = new PiLiveSession({ workingDirectory: '/repo', compactReservePercent: 20 });
    await collect(live.startTurn('/compact').stream);

    expect(piSdkMocks.applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: 23777 },
    });
  });

  it('leaves a more conservative settings.json reserve alone', async () => {
    const session = makeCompactSession({ tokensBefore: 1 }, 118888);
    piSdkMocks.createAgentSession.mockResolvedValue({ session });
    mockCompactionSettings(40000);

    const live = new PiLiveSession({ workingDirectory: '/repo', compactReservePercent: 20 });
    await collect(live.startTurn('/compact').stream);

    expect(piSdkMocks.applyOverrides).not.toHaveBeenCalled();
  });

  it('skips the reserve override when the percentage is turned off', async () => {
    const session = makeCompactSession({ tokensBefore: 1 }, 258400);
    piSdkMocks.createAgentSession.mockResolvedValue({ session });

    const live = new PiLiveSession({ workingDirectory: '/repo', compactReservePercent: 0 });
    await collect(live.startTurn('/compact').stream);

    expect(piSdkMocks.applyOverrides).not.toHaveBeenCalled();
  });

  it.each([16384, 40000, 250000])(
    'lowers its own reserve override on smaller models but keeps the %i user floor',
    async (floor) => {
      const settings = mockCompactionSettings(floor);
      const wide = { provider: 'local', id: 'wide', contextWindow: 1000000 };
      const small = { provider: 'local', id: 'small', contextWindow: 118888 };
      const tiny = { provider: 'local', id: 'tiny', contextWindow: 32000 };
      const models = [wide, small, tiny];
      const session = {
        ...makeCompactSession(),
        model: wide,
        modelRuntime: {
          getModels: () => models,
          getAvailableSnapshot: () => models,
          getModel: (provider: string, id: string) =>
            models.find((model) => model.provider === provider && model.id === id),
        },
        setModel: vi.fn(async (model: typeof wide) => {
          session.model = model;
        }),
      };
      piSdkMocks.createAgentSession.mockResolvedValue({ session });
      const live = new PiLiveSession({ workingDirectory: '/repo', compactReservePercent: 20 });

      await collect(live.startTurn('/compact').stream);
      expect(settings.getCompactionSettings().reserveTokens).toBe(Math.max(floor, 200000));
      for (const model of [small, tiny, wide]) {
        const events = await collect(live.startTurn(`/model local/${model.id}`).stream);
        expect(events.at(-1)).toMatchObject({ kind: 'query_result', isError: false });
        expect(settings.getCompactionSettings().reserveTokens).toBe(
          Math.max(floor, Math.floor(model.contextWindow * 0.2)),
        );
      }
      expect(settings.getCompactionSettings()).toMatchObject({
        enabled: true,
        keepRecentTokens: 12000,
      });
      if (floor === 250000) expect(piSdkMocks.applyOverrides).not.toHaveBeenCalled();
      else expect(piSdkMocks.applyOverrides).toHaveBeenCalledTimes(floor === 16384 ? 4 : 3);
    },
  );

  it('re-derives the reserve when /model switches to a wider window', async () => {
    const small = { provider: 'local', id: 'local', contextWindow: 118888 };
    const wide = { provider: 'mantoub', id: 'gpt-6-sol', contextWindow: 272000 };
    const session: any = {
      sessionFile: '/tmp/pi-session.jsonl',
      sessionId: 'pi-session-id',
      model: small,
      modelRuntime: {
        getModels: () => [small, wide],
        getAvailableSnapshot: () => [small, wide],
        getModel: (provider: string, id: string) =>
          provider === wide.provider && id === wide.id ? wide : undefined,
      },
      thinkingLevel: 'off',
      messages: [],
      subscribe: vi.fn(() => () => {}),
      bindExtensions: vi.fn(),
      prompt: vi.fn(),
      setModel: vi.fn(async (model: unknown) => {
        session.model = model;
      }),
      steer: vi.fn(),
      followUp: vi.fn(),
      compact: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn(),
      getContextUsage: vi.fn(),
    };
    piSdkMocks.createAgentSession.mockResolvedValue({ session });

    const live = new PiLiveSession({ workingDirectory: '/repo', compactReservePercent: 20 });
    await collect(live.startTurn('/model mantoub/gpt-6-sol').stream);

    expect(piSdkMocks.applyOverrides).toHaveBeenLastCalledWith({
      compaction: { reserveTokens: 54400 },
    });
  });
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function mockCompactionSettings(initialReserveTokens = 16384) {
  let reserveTokens = initialReserveTokens;
  piSdkMocks.applyOverrides.mockImplementation(
    (overrides: { compaction: { reserveTokens: number } }) => {
      reserveTokens = overrides.compaction.reserveTokens;
    },
  );
  const settings = {
    getCompactionSettings: () => ({ enabled: true, reserveTokens, keepRecentTokens: 12000 }),
    applyOverrides: piSdkMocks.applyOverrides,
  };
  piSdkMocks.settingsManagerCreate.mockReturnValue(settings);
  return settings;
}

/**
 * Pi session mock with a test-controlled run state. `isStreaming` is the only
 * signal PiLiveSession trusts before enqueuing, so a mock that omits it reads as
 * idle and the injection is refused.
 */
function makeSteerableSession() {
  const state = { streaming: false };
  let releasePrompt: () => void = () => {};
  const session = {
    sessionFile: '/tmp/pi-session.jsonl',
    sessionId: 'pi-session-id',
    model: { provider: 'local', id: 'local', contextWindow: 118888 },
    thinkingLevel: 'off',
    messages: [],
    subscribe: vi.fn((_listener: (event: any) => void) => () => {}),
    bindExtensions: vi.fn(),
    prompt: vi.fn(
      (..._args: [text: string, options?: unknown]) =>
        new Promise<void>((resolve) => {
          releasePrompt = resolve;
        }),
    ),
    steer: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    getContextUsage: vi.fn(() => ({ tokens: 1200, contextWindow: 118888, percent: 1 })),
    get isStreaming() {
      return state.streaming;
    },
  };
  return { session, state, releasePrompt: () => releasePrompt() };
}

function makeCompactSession(compactionResult = { tokensBefore: 1000 }, contextWindow = 118888) {
  return {
    sessionFile: '/tmp/pi-session.jsonl',
    sessionId: 'pi-session-id',
    model: { provider: 'local', id: 'local', contextWindow },
    thinkingLevel: 'off',
    isStreaming: false,
    messages: [],
    subscribe: vi.fn(() => () => {}),
    bindExtensions: vi.fn(),
    prompt: vi.fn(),
    steer: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    compact: vi.fn(async () => ({
      summary: '## Summary',
      firstKeptEntryId: 'entry-4',
      tokensBefore: compactionResult.tokensBefore,
    })),
    abort: vi.fn(),
    dispose: vi.fn(),
    getContextUsage: vi.fn(() => ({
      tokens: 1200,
      contextWindow: 118888,
      percent: (1200 / 118888) * 100,
    })),
  };
}

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const events: T[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) return events;
    events.push(value);
  }
}
