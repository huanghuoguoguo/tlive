import { describe, expect, it, vi } from 'vitest';
import { RemoteAgentProvider } from '../../server/providers/remote-agent-provider.js';
import type {
  RemoteClientRegistry,
  RemoteClientSnapshot,
} from '../../server/clients/client-registry.js';
import type { AgentProviderKind } from '../../shared/providers/kinds.js';
import type { AgentProviderCapabilities } from '../../shared/providers/base.js';

const PI_CAPABILITIES: AgentProviderCapabilities = {
  runtimeMode: 'interactive',
  nativeSteer: true,
  nativeQueue: true,
  drainsQueueWhenIdle: false,
  interactivePermissions: false,
  askUserQuestion: false,
  deferredTools: false,
  settingSources: false,
  sessionResume: true,
  imageInputs: true,
};

function registryWithClient(
  kind: AgentProviderKind,
  capabilities: AgentProviderCapabilities,
): RemoteClientRegistry {
  const snapshot: RemoteClientSnapshot = {
    clientId: 'client-1',
    name: 'test',
    providers: [{ kind, displayName: 'Pi', capabilities, available: true }],
    workspaces: [],
    sessions: [],
    activeTurns: 0,
    lastSeenAt: 0,
  };
  return {
    selectClient: vi.fn(() => snapshot),
    registerTurn: vi.fn(),
    unregisterTurn: vi.fn(),
    sendTurnStart: vi.fn(),
    sendControl: vi.fn(async () => ({ ok: true })),
  } as unknown as RemoteClientRegistry;
}

describe('remote provider capabilities', () => {
  it('treats Pi as interactive with native steer and queue', () => {
    const provider = new RemoteAgentProvider('pi', registryWithClient('pi', PI_CAPABILITIES));

    expect(provider.displayName).toBe('Remote Pi');
    expect(provider.capabilities.nativeSteer).toBe(true);
    expect(provider.capabilities.nativeQueue).toBe(true);
    expect(provider.createSession({ workingDirectory: '/repo' }).capabilities).toEqual({
      nativeSteer: true,
      nativeQueue: true,
      drainsQueueWhenIdle: false,
    });
  });

  it('keeps Codex turn-based', () => {
    const provider = new RemoteAgentProvider('codex', registryWithClient('codex', PI_CAPABILITIES));

    expect(provider.capabilities.nativeSteer).toBe(false);
    expect(provider.capabilities.nativeQueue).toBe(false);
  });

  it('reports Claude as able to drain its queue while idle', () => {
    const provider = new RemoteAgentProvider(
      'claude',
      registryWithClient('claude', { ...PI_CAPABILITIES, drainsQueueWhenIdle: true }),
    );

    expect(provider.capabilities.drainsQueueWhenIdle).toBe(true);
    expect(provider.createSession({ workingDirectory: '/repo' }).capabilities).toMatchObject({
      drainsQueueWhenIdle: true,
    });
  });

  it('prefers the capabilities the bound client reported', async () => {
    const provider = new RemoteAgentProvider(
      'pi',
      registryWithClient('pi', { ...PI_CAPABILITIES, nativeSteer: false }),
    );
    const session = provider.createSession({ workingDirectory: '/repo' });

    // Before a client is bound the static table applies.
    expect(session.capabilities).toEqual({
      nativeSteer: true,
      nativeQueue: true,
      drainsQueueWhenIdle: false,
    });

    await session.startTurn('hello').stream.cancel();

    // The client runs the agent, so its answer wins for steering.
    expect(session.capabilities).toEqual({
      nativeSteer: false,
      nativeQueue: true,
      drainsQueueWhenIdle: false,
    });
  });

  it('falls back to the static table when an older client omits the flag', async () => {
    const provider = new RemoteAgentProvider(
      'claude',
      registryWithClient(
        'claude',
        JSON.parse(JSON.stringify({ ...PI_CAPABILITIES, drainsQueueWhenIdle: undefined })),
      ),
    );
    const session = provider.createSession({ workingDirectory: '/repo' });

    await session.startTurn('hello').stream.cancel();

    expect(session.capabilities?.drainsQueueWhenIdle).toBe(true);
  });

  it('bounds the controls the inbound message loop waits on', async () => {
    const registry = registryWithClient('pi', PI_CAPABILITIES);
    const sendControl = registry.sendControl as unknown as ReturnType<typeof vi.fn>;
    const session = new RemoteAgentProvider('pi', registry).createSession({
      workingDirectory: '/repo',
    });

    await session.startTurn('busy work').stream.cancel();
    await session.interruptTurn();
    await session.sendWithPriority('side note', 'now');

    // A worker that stops answering used to hold the whole Feishu loop for the
    // registry's 30s default before reporting anything.
    for (const [, message, timeoutMs] of sendControl.mock.calls) {
      if (message.action === 'interrupt' || message.action === 'send_priority') {
        expect(timeoutMs).toBeLessThan(30_000);
      }
    }
    expect(sendControl.mock.calls.some(([, m]) => m.action === 'interrupt')).toBe(true);

    sendControl.mockClear();
    session.close();

    expect(sendControl).toHaveBeenCalledWith(
      'client-1',
      expect.objectContaining({ action: 'close' }),
      undefined,
    );
  });
});
