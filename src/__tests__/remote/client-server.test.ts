import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteClientWorker } from '../../client/worker.js';
import type { RemoteClientIdentity, RemoteClientIdentityStore } from '../../client/identity.js';
import type { CanonicalEvent } from '../../shared/canonical/schema.js';
import { RemoteAgentProvider } from '../../server/providers/remote-agent-provider.js';
import { RemoteClientRegistry } from '../../server/clients/client-registry.js';
import { singleProviderRegistry } from '../../shared/providers/registry.js';
import { FakeClaudeProvider, waitFor } from '../e2e/harness.js';
import type { AgentProvider } from '../../shared/providers/base.js';

class MemoryIdentityStore implements RemoteClientIdentityStore {
  identity: RemoteClientIdentity | null;

  constructor(identity: RemoteClientIdentity | null = null) {
    this.identity = identity;
  }

  load(): RemoteClientIdentity | null {
    return this.identity;
  }

  save(identity: RemoteClientIdentity): void {
    this.identity = identity;
  }
}

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
    const outsideRoot = mkdtempSync(join(tmpdir(), 'tlive-remote-outside-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    cleanup.push(() => rmSync(outsideRoot, { recursive: true, force: true }));
    const port = await freePort();
    const identityStorePath = join(root, 'server-identities.json');
    const registry = new RemoteClientRegistry({
      port,
      path: '/tlive',
      token: 'test-token',
      heartbeatIntervalMs: 10_000,
      clientTimeoutMs: 30_000,
      identityStorePath,
    });
    registry.start();
    cleanup.push(() => registry.stop());

    const fake = new FakeClaudeProvider('remote ok');
    const identityStore = new MemoryIdentityStore();
    const worker = new RemoteClientWorker(singleProviderRegistry(fake as unknown as AgentProvider), {
      serverUrl: `ws://127.0.0.1:${port}/tlive`,
      token: 'test-token',
      name: 'worker-1',
      workspaces: [root],
      reconnectIntervalMs: 100,
      identityStore,
      machineFingerprint: 'machine-a',
    });
    const workerRun = worker.start();
    cleanup.push(async () => {
      worker.stop();
      await Promise.race([workerRun, new Promise((resolve) => setTimeout(resolve, 200))]);
    });

    await waitFor(() => identityStore.identity);
    const clientId = identityStore.identity?.clientId ?? '';
    expect(clientId).toMatch(/^client-/);
    expect(registry.listClients()[0]?.clientId).toBe(clientId);

    const statResult = await registry.statPath(clientId, outsideRoot);
    expect(statResult).toMatchObject({ ok: true, exists: true, isDirectory: true });

    const shellResult = await registry.execShell(clientId, 'pwd', outsideRoot);
    expect(shellResult.ok).toBe(true);
    expect(shellResult.stdout?.trim()).toBe(outsideRoot);

    const provider = new RemoteAgentProvider('claude', registry);
    const session = provider.createSession({ workingDirectory: outsideRoot });
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
    const identityStorePath = join(root, 'server-identities.json');
    const registry = new RemoteClientRegistry({
      port,
      path: '/tlive',
      token: 'test-token',
      heartbeatIntervalMs: 10_000,
      clientTimeoutMs: 30_000,
      identityStorePath,
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
    const identityStore = new MemoryIdentityStore();
    const worker = new RemoteClientWorker(singleProviderRegistry(fake as unknown as AgentProvider), {
      serverUrl: `ws://127.0.0.1:${port}/tlive`,
      token: 'test-token',
      name: 'worker-1',
      workspaces: [root],
      reconnectIntervalMs: 100,
      identityStore,
      machineFingerprint: 'machine-a',
    });
    const workerRun = worker.start();
    cleanup.push(async () => {
      worker.stop();
      await Promise.race([workerRun, new Promise((resolve) => setTimeout(resolve, 200))]);
    });

    await waitFor(() => identityStore.identity);

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

  it('rejects a copied client identity from a different machine fingerprint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tlive-remote-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const port = await freePort();
    const registry = new RemoteClientRegistry({
      port,
      path: '/tlive',
      token: 'test-token',
      heartbeatIntervalMs: 10_000,
      clientTimeoutMs: 30_000,
      identityStorePath: join(root, 'server-identities.json'),
    });
    registry.start();
    cleanup.push(() => registry.stop());

    const fake = new FakeClaudeProvider('remote ok');
    const firstStore = new MemoryIdentityStore();
    const firstWorker = new RemoteClientWorker(singleProviderRegistry(fake as unknown as AgentProvider), {
      serverUrl: `ws://127.0.0.1:${port}/tlive`,
      token: 'test-token',
      name: 'first-worker',
      workspaces: [root],
      reconnectIntervalMs: 100,
      identityStore: firstStore,
      machineFingerprint: 'machine-a',
    });
    const firstRun = firstWorker.start();
    cleanup.push(async () => {
      firstWorker.stop();
      await Promise.race([firstRun, new Promise((resolve) => setTimeout(resolve, 200))]);
    });

    await waitFor(() => firstStore.identity);
    const copiedStore = new MemoryIdentityStore(firstStore.identity);
    const secondWorker = new RemoteClientWorker(singleProviderRegistry(fake as unknown as AgentProvider), {
      serverUrl: `ws://127.0.0.1:${port}/tlive`,
      token: 'test-token',
      name: 'copied-worker',
      workspaces: [root],
      reconnectIntervalMs: 100,
      identityStore: copiedStore,
      machineFingerprint: 'machine-b',
    });
    const secondRun = secondWorker.start();
    cleanup.push(async () => {
      secondWorker.stop();
      await Promise.race([secondRun, new Promise((resolve) => setTimeout(resolve, 200))]);
    });

    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(registry.listClients()).toHaveLength(1);
    expect(registry.listClients()[0]?.clientId).toBe(firstStore.identity?.clientId);
  });
});
