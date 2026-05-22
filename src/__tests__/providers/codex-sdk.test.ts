import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Input, RunStreamedResult, ThreadEvent, TurnOptions } from '@openai/codex-sdk';

const codexSdkMocks = vi.hoisted(() => ({
  resumeThread: vi.fn(),
  runStreamed: vi.fn(),
  startThread: vi.fn(),
}));

vi.mock('@openai/codex-sdk', () => ({
  Codex: class MockCodex {
    startThread(options?: unknown): unknown {
      return codexSdkMocks.startThread(options);
    }

    resumeThread(id: string, options?: unknown): unknown {
      return codexSdkMocks.resumeThread(id, options);
    }
  },
}));

import { CodexLiveSession, resolveCodexSessionOptions } from '../../providers/codex-live-session.js';
import { CodexSDKProvider, toCodexReasoningEffort } from '../../providers/codex-sdk.js';

describe('CodexSDKProvider', () => {
  const originalCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    vi.clearAllMocks();
    const thread = {
      id: 'thread-1',
      runStreamed: codexSdkMocks.runStreamed,
    };
    codexSdkMocks.startThread.mockReturnValue(thread);
    codexSdkMocks.resumeThread.mockReturnValue(thread);
  });

  afterEach(() => {
    process.env.CODEX_HOME = originalCodexHome;
  });

  it('maps canonical max effort to Codex xhigh', () => {
    expect(toCodexReasoningEffort('max')).toBe('xhigh');
    expect(toCodexReasoningEffort('high')).toBe('high');
    expect(toCodexReasoningEffort(undefined)).toBeUndefined();
  });

  it('marks Codex as a turn-based runtime', () => {
    const provider = new CodexSDKProvider();

    expect(provider.capabilities.runtimeMode).toBe('turn-based');
    expect(provider.capabilities.nativeSteer).toBe(false);
    expect(provider.capabilities.nativeQueue).toBe(false);
  });

  it('resolves Codex model and effort from current session defaults when not explicit', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'tlive-codex-home-'));
    process.env.CODEX_HOME = codexHome;
    writeFileSync(
      join(codexHome, 'config.toml'),
      'model = "gpt-5.5"\nmodel_reasoning_effort = "xhigh"\n[projects]\n',
    );

    const resolved = resolveCodexSessionOptions({ workingDirectory: '/repo' });

    expect(resolved.model).toBe('gpt-5.5');
    expect(resolved.modelReasoningEffort).toBe('xhigh');
    rmSync(codexHome, { recursive: true, force: true });
  });

  it('keeps explicit per-session Codex options above user defaults', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'tlive-codex-home-'));
    process.env.CODEX_HOME = codexHome;
    writeFileSync(
      join(codexHome, 'config.toml'),
      'model = "gpt-5.5"\nmodel_reasoning_effort = "xhigh"\n',
    );

    const resolved = resolveCodexSessionOptions({
      workingDirectory: '/repo',
      model: 'gpt-5.4',
      modelReasoningEffort: 'medium',
    });

    expect(resolved.model).toBe('gpt-5.4');
    expect(resolved.modelReasoningEffort).toBe('medium');
    rmSync(codexHome, { recursive: true, force: true });
  });

  it('keeps an aborted turn from closing a newer turn stream', async () => {
    const firstAbortObserved = deferred<void>();
    const releaseFirstRun = deferred<void>();
    const firstRunSettled = deferred<void>();
    const releaseSecondEvent = deferred<void>();

    codexSdkMocks.runStreamed
      .mockImplementationOnce(async (_input: Input, options?: TurnOptions) => {
        options?.signal?.addEventListener('abort', () => firstAbortObserved.resolve(), {
          once: true,
        });
        await releaseFirstRun.promise;
        firstRunSettled.resolve();
        throw new Error('first turn aborted late');
      })
      .mockImplementationOnce(async (): Promise<RunStreamedResult> => ({
        events: secondTurnEvents(releaseSecondEvent.promise),
      }));

    const session = new CodexLiveSession({ workingDirectory: '/repo' });
    session.startTurn('first');

    const secondTurn = session.startTurn('second');
    const secondReader = secondTurn.stream.getReader();

    await firstAbortObserved.promise;
    releaseFirstRun.resolve();
    await firstRunSettled.promise;
    await Promise.resolve();

    expect(session.isTurnActive).toBe(true);

    releaseSecondEvent.resolve();
    await expect(secondReader.read()).resolves.toEqual({
      done: false,
      value: { kind: 'text_delta', text: 'second still open' },
    });
  });
});

async function* secondTurnEvents(ready: Promise<void>): AsyncGenerator<ThreadEvent> {
  await ready;
  yield {
    type: 'item.updated',
    item: { id: 'msg-2', type: 'agent_message', text: 'second still open' },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
