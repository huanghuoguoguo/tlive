import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Input, RunStreamedResult, ThreadEvent, TurnOptions } from '@openai/codex-sdk';

const codexSdkMocks = vi.hoisted(() => ({
  codexConstructor: vi.fn(),
  resumeThread: vi.fn(),
  runStreamed: vi.fn(),
  startThread: vi.fn(),
}));

vi.mock('@openai/codex-sdk', () => ({
  Codex: class MockCodex {
    constructor(options?: unknown) {
      codexSdkMocks.codexConstructor(options);
    }

    startThread(options?: unknown): unknown {
      return codexSdkMocks.startThread(options);
    }

    resumeThread(id: string, options?: unknown): unknown {
      return codexSdkMocks.resumeThread(id, options);
    }
  },
}));

import { CodexLiveSession, resolveCodexSessionOptions } from '../../client/providers/codex-live-session.js';
import { loadCodexProviderConfig } from '../../client/providers/codex-config.js';
import { CodexSDKProvider, toCodexReasoningEffort } from '../../client/providers/codex-sdk.js';

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

  it('loads Codex env options in the Codex provider boundary', () => {
    const values = new Map([
      ['TL_CODEX_MODEL', 'gpt-5.4'],
      ['TL_CODEX_PATH', '/usr/local/bin/codex'],
      ['TL_CODEX_SANDBOX_MODE', 'danger-full-access'],
      ['TL_CODEX_APPROVAL_POLICY', 'never'],
      ['TL_CODEX_SKIP_GIT_REPO_CHECK', 'true'],
      ['TL_CODEX_REASONING_EFFORT', 'high'],
      ['TL_CODEX_NETWORK_ACCESS', 'true'],
      ['TL_CODEX_WEB_SEARCH', 'live'],
    ]);

    expect(loadCodexProviderConfig({ get: (key, fallback = '') => values.get(key) ?? fallback }))
      .toEqual({
        model: 'gpt-5.4',
        codexPath: '/usr/local/bin/codex',
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        skipGitRepoCheck: true,
        modelReasoningEffort: 'high',
        networkAccessEnabled: true,
        webSearchMode: 'live',
      });
  });

  it('keeps Codex defaults local to the Codex provider config', () => {
    expect(loadCodexProviderConfig({ defaultModel: 'gpt-5.5', get: (_key, fallback = '') => fallback }))
      .toEqual({
        model: 'gpt-5.5',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        skipGitRepoCheck: false,
      });
  });

  it('injects TLive MCP only into the SDK-created Codex process', () => {
    new CodexLiveSession({ workingDirectory: '/repo' });

    expect(codexSdkMocks.codexConstructor).toHaveBeenCalledWith({
      config: {
        mcp_servers: {
          tlive: expect.objectContaining({
            type: 'http',
            url: 'http://127.0.0.1:8081/mcp',
            tools: {
              tlive_send_file: { approval_mode: 'approve' },
              tlive_send_image: { approval_mode: 'approve' },
              tlive_status: { approval_mode: 'approve' },
            },
          }),
        },
      },
    });
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
