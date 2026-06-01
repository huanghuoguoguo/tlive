import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteClientWorker } from '../../client/worker.js';
import type { CanonicalEvent } from '../../shared/canonical/schema.js';
import { RemoteAgentProvider } from '../../server/providers/remote-agent-provider.js';
import { RemoteClientRegistry } from '../../server/clients/client-registry.js';
import { singleProviderRegistry } from '../../shared/providers/registry.js';
import { FakeClaudeProvider, waitFor } from '../e2e/harness.js';
import type { AgentProvider, LiveSession, StreamChatResult } from '../../shared/providers/base.js';
import type { FileAttachment } from '../../shared/media/attachments.js';

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
      workspaces: [root],
      reconnectIntervalMs: 100,
    });
    const workerRun = worker.start();
    cleanup.push(async () => {
      worker.stop();
      await Promise.race([workerRun, new Promise((resolve) => setTimeout(resolve, 200))]);
    });

    await waitFor(() => registry.listClients().find((client) => client.clientId === 'worker-1'));

    const statResult = await registry.statPath('worker-1', outsideRoot);
    expect(statResult).toMatchObject({ ok: true, exists: true, isDirectory: true });

    const shellResult = await registry.execShell('worker-1', 'pwd', outsideRoot);
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
      workspaces: [root],
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

  it('transfers image attachments to the remote execution client', async () => {
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

    const receivedAttachments: FileAttachment[][] = [];
    const fake = createAttachmentCapturingProvider(receivedAttachments);
    const worker = new RemoteClientWorker(singleProviderRegistry(fake), {
      serverUrl: `ws://127.0.0.1:${port}/tlive`,
      token: 'test-token',
      clientId: 'worker-1',
      name: 'worker-1',
      workspaces: [root],
      reconnectIntervalMs: 100,
    });
    const workerRun = worker.start();
    cleanup.push(async () => {
      worker.stop();
      await Promise.race([workerRun, new Promise((resolve) => setTimeout(resolve, 200))]);
    });

    await waitFor(() => registry.listClients().find((client) => client.clientId === 'worker-1'));

    const image: FileAttachment = {
      type: 'image',
      name: 'diagram.png',
      mimeType: 'image/png',
      base64Data: Buffer.from('png-bytes').toString('base64'),
    };
    const provider = new RemoteAgentProvider('claude', registry);
    const session = provider.createSession({ workingDirectory: root });
    const result = session.startTurn('inspect remote image', { attachments: [image] });
    const events = await collect(result.stream);

    expect(receivedAttachments).toEqual([[image]]);
    expect(events).toContainEqual({
      kind: 'query_result',
      sessionId: 'remote-image-session',
      isError: false,
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    });
  });
});

function createAttachmentCapturingProvider(received: FileAttachment[][]): AgentProvider {
  return {
    kind: 'claude',
    displayName: 'Claude',
    capabilities: {
      runtimeMode: 'interactive',
      nativeSteer: true,
      nativeQueue: true,
      interactivePermissions: true,
      askUserQuestion: true,
      deferredTools: true,
      settingSources: true,
      sessionResume: true,
      imageInputs: true,
    },
    createSession: () => createAttachmentCapturingSession(received),
    streamChat: (): StreamChatResult => {
      throw new Error('streamChat should not be called by the remote worker');
    },
  };
}

function createAttachmentCapturingSession(received: FileAttachment[][]): LiveSession {
  let alive = true;
  let turnActive = false;
  return {
    capabilities: { nativeSteer: true, nativeQueue: true },
    runtimeInfo: { provider: 'claude', displayName: 'Claude' },
    get isAlive() {
      return alive;
    },
    get isTurnActive() {
      return turnActive;
    },
    startTurn: (_prompt, params): StreamChatResult => {
      turnActive = true;
      received.push(params?.attachments ?? []);
      const stream = new ReadableStream<CanonicalEvent>({
        start(controller) {
          controller.enqueue({
            kind: 'query_result',
            sessionId: 'remote-image-session',
            isError: false,
            usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
          });
          controller.close();
          turnActive = false;
        },
      });
      return { stream };
    },
    steerTurn: () => {},
    sendWithPriority: async () => {},
    interruptTurn: async () => {
      turnActive = false;
    },
    close: () => {
      alive = false;
      turnActive = false;
    },
    setLifecycleCallbacks: () => {},
  };
}
