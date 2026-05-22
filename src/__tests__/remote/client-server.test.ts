import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteClientWorker } from '../../client/worker.js';
import type { CanonicalEvent } from '../../canonical/schema.js';
import { RemoteAgentProvider } from '../../server/remote-agent-provider.js';
import { RemoteClientRegistry } from '../../server/client-registry.js';
import { singleProviderRegistry } from '../../providers/registry.js';
import { FakeClaudeProvider, waitFor } from '../e2e/harness.js';
import type { AgentProvider } from '../../providers/base.js';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to allocate test port'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function collect(stream: ReadableStream<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const reader = stream.getReader();
  const events: CanonicalEvent[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) return events;
    events.push(value);
  }
}

describe('remote client/server bridge', () => {
  let cleanup: (() => void | Promise<void>)[] = [];

  afterEach(async () => {
    for (const fn of cleanup.reverse()) {
      await fn();
    }
    cleanup = [];
  });

  it('streams a remote provider turn over WebSocket', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tlive-remote-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const port = await freePort();
    const registry = new RemoteClientRegistry({
      port,
      path: '/tlive',
      token: 'test-token',
      heartbeatIntervalMs: 10_000,
      clientTimeoutMs: 30_000,
    });
    registry.start();
    cleanup.push(() => registry.stop());

    const fake = new FakeClaudeProvider('remote ok');
    const worker = new RemoteClientWorker(singleProviderRegistry(fake as unknown as AgentProvider), {
      serverUrl: `ws://127.0.0.1:${port}/tlive`,
      token: 'test-token',
      clientId: 'worker-1',
      name: 'worker-1',
      providers: ['claude'],
      workspaces: [root],
      maxConcurrency: 1,
      reconnectIntervalMs: 100,
    });
    const workerRun = worker.start();
    cleanup.push(async () => {
      worker.stop();
      await Promise.race([workerRun, new Promise((resolve) => setTimeout(resolve, 200))]);
    });

    await waitFor(() => registry.listClients().find((client) => client.clientId === 'worker-1'));

    const provider = new RemoteAgentProvider('claude', registry);
    const session = provider.createSession({ workingDirectory: root });
    const result = session.startTurn('hello remote');
    const events = await collect(result.stream);

    expect(fake.prompts).toContain('hello remote');
    expect(events).toContainEqual({ kind: 'text_delta', text: 'remote ok' });
    expect(events.some((event) => event.kind === 'query_result')).toBe(true);
  });

  it('round-trips provider permission requests to the server turn handler', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tlive-remote-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const port = await freePort();
    const registry = new RemoteClientRegistry({
      port,
      path: '/tlive',
      token: 'test-token',
      heartbeatIntervalMs: 10_000,
      clientTimeoutMs: 30_000,
    });
    registry.start();
    cleanup.push(() => registry.stop());

    const fake = new FakeClaudeProvider(async (_prompt, params) => {
      const decision = await params?.onPermissionRequest?.('Bash', { command: 'pwd' }, 'Allow?');
      return [
        { kind: 'text_delta', text: decision ?? 'missing' },
        {
          kind: 'query_result',
          sessionId: 'sdk-session-perm',
          isError: false,
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        },
      ];
    });
    const worker = new RemoteClientWorker(singleProviderRegistry(fake as unknown as AgentProvider), {
      serverUrl: `ws://127.0.0.1:${port}/tlive`,
      token: 'test-token',
      clientId: 'worker-1',
      name: 'worker-1',
      providers: ['claude'],
      workspaces: [root],
      maxConcurrency: 1,
      reconnectIntervalMs: 100,
    });
    const workerRun = worker.start();
    cleanup.push(async () => {
      worker.stop();
      await Promise.race([workerRun, new Promise((resolve) => setTimeout(resolve, 200))]);
    });

    await waitFor(() => registry.listClients().find((client) => client.clientId === 'worker-1'));

    const provider = new RemoteAgentProvider('claude', registry);
    const session = provider.createSession({ workingDirectory: root });
    const result = session.startTurn('needs permission', {
      onPermissionRequest: async (toolName, input, promptSentence) => {
        expect(toolName).toBe('Bash');
        expect(input).toEqual({ command: 'pwd' });
        expect(promptSentence).toBe('Allow?');
        return 'allow';
      },
    });
    const events = await collect(result.stream);

    expect(events).toContainEqual({ kind: 'text_delta', text: 'allow' });
  });
});
