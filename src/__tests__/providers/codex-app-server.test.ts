import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const processMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: processMocks.spawn }));

import { CodexAppServerClient } from '../../client/providers/codex-app-server.js';

describe('CodexAppServerClient', () => {
  beforeEach(() => vi.clearAllMocks());

  it('initializes JSONL transport, handles requests, and declines unhandled approvals', async () => {
    const child = fakeChildProcess();
    processMocks.spawn.mockReturnValue(child.process);
    const outbound: Array<Record<string, unknown>> = [];
    child.stdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        if (line) outbound.push(JSON.parse(line));
      }
    });

    const client = new CodexAppServerClient({
      codexPath: '/opt/codex',
      workingDirectory: '/repo',
      onNotification: vi.fn(),
      onExit: vi.fn(),
    });
    const request = client.request('thread/start', { cwd: '/repo' });

    await flushPromises();
    expect(processMocks.spawn).toHaveBeenCalledWith(
      '/opt/codex',
      ['app-server'],
      expect.objectContaining({ cwd: '/repo' }),
    );
    expect(outbound[0]).toMatchObject({ method: 'initialize', id: 1 });

    child.stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: 'test' } })}\n`);
    await flushPromises();
    expect(outbound).toContainEqual({ method: 'initialized' });
    expect(outbound).toContainEqual({ method: 'thread/start', id: 2, params: { cwd: '/repo' } });

    child.stdout.write(`${JSON.stringify({ id: 2, result: { thread: { id: 'thread-1' } } })}\n`);
    await expect(request).resolves.toEqual({ thread: { id: 'thread-1' } });

    child.stdout.write(
      `${JSON.stringify({
        id: 90,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread-1' },
      })}\n`,
    );
    await flushPromises();
    expect(outbound).toContainEqual({ id: 90, result: { decision: 'decline' } });

    client.close();
    expect(child.kill).toHaveBeenCalled();
  });
});

function fakeChildProcess() {
  const emitter = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  emitter.stdin = new PassThrough();
  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  emitter.kill = vi.fn();
  return {
    process: emitter,
    stdin: emitter.stdin,
    stdout: emitter.stdout,
    kill: emitter.kill,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
