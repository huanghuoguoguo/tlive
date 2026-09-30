import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CanonicalEvent } from '../../shared/canonical/schema.js';

const appServerMocks = vi.hoisted(() => ({
  close: vi.fn(),
  constructor: vi.fn(),
  onExit: undefined as ((error: Error) => void) | undefined,
  onNotification: undefined as ((notification: { method: string; params?: Record<string, unknown> }) => void) | undefined,
  request: vi.fn(),
}));

const childProcessMocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawnSync: childProcessMocks.spawnSync,
}));

vi.mock('../../client/providers/codex-app-server.js', () => ({
  CodexAppServerClient: class MockCodexAppServerClient {
    constructor(options: {
      onExit: (error: Error) => void;
      onNotification: (notification: { method: string; params?: Record<string, unknown> }) => void;
    }) {
      appServerMocks.constructor(options);
      appServerMocks.onExit = options.onExit;
      appServerMocks.onNotification = options.onNotification;
    }

    request(method: string, params: Record<string, unknown>) {
      return appServerMocks.request(method, params);
    }

    close() {
      appServerMocks.close();
    }
  },
}));

import { CodexLiveSession, resolveCodexSessionOptions } from '../../client/providers/codex-live-session.js';
import {
  loadCodexProviderConfig,
  probeCodexWorkspaceSandbox,
} from '../../client/providers/codex-config.js';
import { CodexSDKProvider, toCodexReasoningEffort } from '../../client/providers/codex-sdk.js';

describe('CodexSDKProvider', () => {
  const originalCodexHome = process.env.CODEX_HOME;
  const originalTliveMcpToken = process.env.TL_MCP_TOKEN;
  const originalTliveRemoteToken = process.env.TL_REMOTE_TOKEN;
  const originalTliveToken = process.env.TL_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    appServerMocks.onExit = undefined;
    appServerMocks.onNotification = undefined;
    appServerMocks.request.mockImplementation(async (method: string) => {
      if (method === 'thread/start' || method === 'thread/resume') {
        return { thread: { id: 'thread-1' } };
      }
      if (method === 'turn/start') return { turn: { id: 'turn-1' } };
      if (method === 'turn/steer') return { turnId: 'turn-1' };
      return {};
    });
    childProcessMocks.spawnSync.mockReturnValue({ status: 0, stderr: '', stdout: '' });
    delete process.env.TL_MCP_TOKEN;
    delete process.env.TL_REMOTE_TOKEN;
    delete process.env.TL_TOKEN;
  });

  afterEach(() => {
    process.env.CODEX_HOME = originalCodexHome;
    restoreEnv('TL_MCP_TOKEN', originalTliveMcpToken);
    restoreEnv('TL_REMOTE_TOKEN', originalTliveRemoteToken);
    restoreEnv('TL_TOKEN', originalTliveToken);
  });

  it('maps canonical max effort to Codex xhigh', () => {
    expect(toCodexReasoningEffort('max')).toBe('xhigh');
    expect(toCodexReasoningEffort('high')).toBe('high');
    expect(toCodexReasoningEffort(undefined)).toBeUndefined();
  });

  it('marks Codex as an interactive runtime with active-turn steering', () => {
    const provider = new CodexSDKProvider();

    expect(provider.capabilities.runtimeMode).toBe('interactive');
    expect(provider.capabilities.nativeSteer).toBe(true);
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
    expect(
      loadCodexProviderConfig({
        defaultModel: 'gpt-5.5',
        get: (_key, fallback = '') => fallback,
        sandboxProbe: () => ({ supported: true }),
      }),
    ).toEqual({
        model: 'gpt-5.5',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        skipGitRepoCheck: false,
      });
  });

  it('falls back when the default Codex workspace sandbox is blocked by bwrap', () => {
    const warn = vi.fn();

    expect(
      loadCodexProviderConfig({
        get: (_key, fallback = '') => fallback,
        sandboxProbe: () => ({
          supported: false,
          reason: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted',
        }),
        warn,
      }),
    ).toEqual({
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'on-request',
      skipGitRepoCheck: false,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('falling back to danger-full-access'));
  });

  it('passes the sandbox fallback through to app-server thread creation', async () => {
    const config = loadCodexProviderConfig({
      get: (_key, fallback = '') => fallback,
      sandboxProbe: () => ({ supported: false }),
      warn: vi.fn(),
    });

    const session = new CodexSDKProvider(config).createSession({ workingDirectory: '/repo' });
    session.startTurn('hello');
    await flushPromises();

    expect(appServerMocks.request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        cwd: '/repo',
        sandbox: 'danger-full-access',
      }),
    );
  });

  it('never probes or relaxes an explicitly configured Codex sandbox', () => {
    const sandboxProbe = vi.fn(() => ({ supported: false }));

    expect(
      loadCodexProviderConfig({
        get: (key, fallback = '') =>
          key === 'TL_CODEX_SANDBOX_MODE' ? 'workspace-write' : fallback,
        sandboxProbe,
      }),
    ).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      skipGitRepoCheck: false,
    });
    expect(sandboxProbe).not.toHaveBeenCalled();
  });

  it('probes the current Codex Linux sandbox syntax used by workspace-write', () => {
    expect(probeCodexWorkspaceSandbox('/opt/codex', 'linux')).toEqual({ supported: true });
    expect(childProcessMocks.spawnSync).toHaveBeenCalledWith(
      '/opt/codex',
      ['sandbox', '--', '/bin/true'],
      {
        encoding: 'utf8',
        timeout: 5000,
      },
    );
  });

  it('recognizes the bwrap loopback permission failure from the Linux sandbox probe', () => {
    childProcessMocks.spawnSync.mockReturnValue({
      status: 1,
      stderr: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n',
      stdout: '',
    });

    expect(probeCodexWorkspaceSandbox(undefined, 'linux')).toEqual({
      supported: false,
      reason: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted',
    });
  });

  it('retries the platform subcommand required by Codex 0.132', () => {
    childProcessMocks.spawnSync
      .mockReturnValueOnce({
        status: 2,
        stderr: "error: unrecognized subcommand '/bin/true'\n",
        stdout: '',
      })
      .mockReturnValueOnce({ status: 0, stderr: '', stdout: '' });

    expect(probeCodexWorkspaceSandbox('/opt/codex', 'linux')).toEqual({ supported: true });
    expect(childProcessMocks.spawnSync).toHaveBeenNthCalledWith(
      2,
      '/opt/codex',
      ['sandbox', 'linux', '--', '/bin/true'],
      {
        encoding: 'utf8',
        timeout: 5000,
      },
    );
  });

  it('recognizes bwrap permission failures after the Codex 0.132 syntax retry', () => {
    childProcessMocks.spawnSync
      .mockReturnValueOnce({
        status: 2,
        stderr: "error: unrecognized subcommand '/bin/true'\n",
        stdout: '',
      })
      .mockReturnValueOnce({
        status: 1,
        stderr: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n',
        stdout: '',
      });

    expect(probeCodexWorkspaceSandbox(undefined, 'linux')).toEqual({
      supported: false,
      reason: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted',
    });
  });

  it('does not disable sandboxing when the probe fails for an unrelated reason', () => {
    childProcessMocks.spawnSync.mockReturnValue({
      status: 2,
      stderr: 'error: unrecognized subcommand',
      stdout: '',
    });

    expect(probeCodexWorkspaceSandbox(undefined, 'linux')).toEqual({ supported: true });
  });

  it('does not probe Codex sandbox support outside Linux', () => {
    expect(probeCodexWorkspaceSandbox('/opt/codex', 'darwin')).toEqual({ supported: true });
    expect(childProcessMocks.spawnSync).not.toHaveBeenCalled();
  });

  it('injects TLive MCP into the app-server thread config', async () => {
    const session = new CodexLiveSession({ workingDirectory: '/repo' });
    session.startTurn('hello');
    await flushPromises();

    expect(appServerMocks.request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        config: {
          mcp_servers: {
            tlive: expect.objectContaining({ url: 'http://127.0.0.1:8081/mcp' }),
          },
        },
      }),
    );
  });

  it('passes the TLive MCP bearer token through the Codex-supported env-var config', async () => {
    process.env.TL_REMOTE_TOKEN = 'remote-token';

    const session = new CodexLiveSession({ workingDirectory: '/repo' });
    session.startTurn('hello');
    await flushPromises();

    expect(appServerMocks.request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        config: {
          mcp_servers: {
            tlive: expect.objectContaining({
              url: 'http://127.0.0.1:8081/mcp',
              bearer_token_env_var: 'TL_REMOTE_TOKEN',
            }),
          },
        },
      }),
    );
  });

  it('reports current context from the latest rollout call instead of cumulative turn usage', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'tlive-codex-usage-'));
    const sessionId = '019fe567-8b11-7f30-b9b5-382f59209bc6';
    const sessionDir = join(codexHome, 'sessions', '2026', '08', '09');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, `rollout-2026-08-09T15-23-16-${sessionId}.jsonl`),
      [
        tokenCountLine(10669, 258400),
        tokenCountLine(10819, 258400, {
          input_tokens: 21346,
          cached_input_tokens: 11776,
          output_tokens: 142,
          total_tokens: 21488,
        }),
      ].join('\n'),
    );
    process.env.CODEX_HOME = codexHome;
    appServerMocks.request.mockImplementation(async (method: string) => {
      if (method === 'thread/start') return { thread: { id: sessionId } };
      if (method === 'turn/start') return { turn: { id: 'turn-usage' } };
      return {};
    });

    try {
      const session = new CodexLiveSession({ workingDirectory: '/repo' });
      const result = session.startTurn('hello');
      await flushPromises();
      emitNotification('thread/tokenUsage/updated', {
        threadId: sessionId,
        turnId: 'turn-usage',
        tokenUsage: {
          last: {
            inputTokens: 21346,
            cachedInputTokens: 11776,
            outputTokens: 142,
            reasoningOutputTokens: 12,
          },
        },
      });
      emitNotification('turn/completed', {
        threadId: sessionId,
        turn: { id: 'turn-usage', status: 'completed', error: null },
      });
      const events = await collect(result.stream);

      expect(events).toEqual([
        { kind: 'status', sessionId },
        {
          kind: 'context_usage',
          tokens: 10819,
          contextWindow: 258400,
          percent: (10819 / 258400) * 100,
        },
        {
          kind: 'query_result',
          sessionId,
          isError: false,
          usage: {
            inputTokens: 21346,
            cachedInputTokens: 11776,
            outputTokens: 142,
            reasoningOutputTokens: 12,
            contextTokens: 10819,
          },
        },
      ]);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('keeps a late first-turn response from closing a newer turn stream', async () => {
    const firstTurn = deferred<Record<string, unknown>>();
    let turnStarts = 0;
    appServerMocks.request.mockImplementation(async (method: string) => {
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') {
        turnStarts++;
        return turnStarts === 1 ? firstTurn.promise : { turn: { id: 'turn-2' } };
      }
      return {};
    });

    const session = new CodexLiveSession({ workingDirectory: '/repo' });
    session.startTurn('first');
    await flushPromises();

    const secondTurn = session.startTurn('second');
    const secondReader = secondTurn.stream.getReader();
    await flushPromises();

    firstTurn.resolve({ turn: { id: 'turn-1' } });
    await flushPromises();

    expect(session.isTurnActive).toBe(true);

    emitNotification('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-2',
      itemId: 'msg-2',
      delta: 'second still open',
    });
    await expect(secondReader.read()).resolves.toEqual({
      done: false,
      value: { kind: 'status', sessionId: 'thread-1' },
    });
    await expect(secondReader.read()).resolves.toEqual({
      done: false,
      value: { kind: 'text_delta', text: 'second still open' },
    });
  });

  it('steers an active Codex turn through app-server', async () => {
    const session = new CodexLiveSession({ workingDirectory: '/repo' });
    session.startTurn('first');
    await flushPromises();

    await session.sendWithPriority('focus on tests', 'now');

    expect(appServerMocks.request).toHaveBeenCalledWith('turn/steer', {
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'focus on tests', text_elements: [] }],
    });
  });
});

function tokenCountLine(
  lastTotalTokens: number,
  contextWindow: number,
  totalTokenUsage = {
    input_tokens: 10592,
    cached_input_tokens: 3840,
    output_tokens: 77,
    total_tokens: 10669,
  },
): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: totalTokenUsage,
        last_token_usage: {
          input_tokens: lastTotalTokens - 65,
          cached_input_tokens: 7936,
          output_tokens: 65,
          total_tokens: lastTotalTokens,
        },
        model_context_window: contextWindow,
      },
    },
  });
}

function emitNotification(method: string, params: Record<string, unknown>): void {
  appServerMocks.onNotification?.({ method, params });
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function collect(stream: ReadableStream<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const reader = stream.getReader();
  const events: CanonicalEvent[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) return events;
    events.push(next.value);
  }
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

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
