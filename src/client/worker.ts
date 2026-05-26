import { WebSocket, type RawData } from 'ws';
import { hostname, homedir, networkInterfaces, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AgentProviderRegistry,
  AgentProviderDescriptor,
} from '../shared/providers/registry.js';
import type { LiveSession, QueryControls } from '../shared/providers/base.js';
import type { AgentProviderKind } from '../shared/providers/kinds.js';
import { generateId } from '../shared/core/id.js';
import {
  encodeRemoteProtocolMessage,
  parseRemoteProtocolMessage,
  REMOTE_PROTOCOL_VERSION,
  type ClientHelloMessage,
  type ControlMessage,
  type ClientCommandMessage,
  type InteractionResponseMessage,
  type RemoteClientHostDescriptor,
  type RemoteInteractionKind,
  type RemoteProviderDescriptor,
  type RemoteSessionDescriptor,
  type ServerToClientMessage,
  type TurnStartMessage,
} from '../shared/protocol/messages.js';
import { invalidateLocalSessionIndex, listLocalSessionDescriptors } from './session-index.js';

const execAsync = promisify(exec);

export interface RemoteClientWorkerOptions {
  serverUrl: string;
  token: string;
  clientId: string;
  name: string;
  workspaces: string[];
  reconnectIntervalMs: number;
  version?: string;
}

interface LocalSessionEntry {
  sessionId: string;
  provider: AgentProviderKind;
  workingDirectory: string;
  sdkSessionId?: string;
  session: LiveSession;
}

interface ActiveTurn {
  turnId: string;
  sessionId: string;
  controls?: QueryControls;
}

interface PendingInteraction {
  resolve: (message: InteractionResponseMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RemoteClientWorker {
  private socket: WebSocket | null = null;
  private stopped = false;
  private readonly sessions = new Map<string, LocalSessionEntry>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly pendingInteractions = new Map<string, PendingInteraction>();

  constructor(
    private readonly providers: AgentProviderRegistry,
    private readonly options: RemoteClientWorkerOptions,
  ) {}

  async start(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectOnce();
      } catch (err) {
        if (this.stopped) break;
        console.warn(`[remote-client] connection ended: ${err instanceof Error ? err.message : err}`);
      }
      if (!this.stopped) {
        await delay(this.options.reconnectIntervalMs);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close(1000, 'client stopped');
    this.interruptActiveTurns();
    for (const pending of this.pendingInteractions.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('remote client stopped'));
    }
    this.pendingInteractions.clear();
  }

  private async connectOnce(): Promise<void> {
    const url = this.urlWithToken(this.options.serverUrl);
    const socket = new WebSocket(url, {
      headers: this.options.token
        ? { Authorization: `Bearer ${this.options.token}` }
        : undefined,
    });
    this.socket = socket;

    await new Promise<void>((resolveOpen, rejectOpen) => {
      const onOpen = () => {
        socket.off('error', onError);
        resolveOpen();
      };
      const onError = (err: Error) => {
        socket.off('open', onOpen);
        rejectOpen(err);
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
    });

    this.send(this.buildHello());
    console.log(`[remote-client] connected to ${this.options.serverUrl} as ${this.options.clientId}`);

    await new Promise<void>((resolveClose) => {
      socket.on('message', (data) => this.handleMessage(data));
      socket.on('close', () => {
        if (this.socket === socket) this.socket = null;
        this.interruptActiveTurns();
        resolveClose();
      });
      socket.on('error', (err) => {
        console.warn(`[remote-client] socket error: ${err.message}`);
      });
    });
  }

  private buildHello(): ClientHelloMessage {
    const descriptors = this.reportableProviderDescriptors().map((descriptor) =>
      this.toRemoteProviderDescriptor(descriptor),
    );
    return {
      type: 'client.hello',
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      clientId: this.options.clientId,
      name: this.options.name,
      providers: descriptors,
      workspaces: this.options.workspaces.map((path) => ({ path: resolve(path) })),
      sessions: this.scanSessions(),
      host: buildClientHostDescriptor(),
      version: this.options.version,
    };
  }

  private reportableProviderDescriptors(): AgentProviderDescriptor[] {
    return this.providers
      .list()
      .filter((descriptor) => descriptor.available && Boolean(this.providers.get(descriptor.kind)));
  }

  private toRemoteProviderDescriptor(
    descriptor: AgentProviderDescriptor,
  ): RemoteProviderDescriptor {
    const provider = this.providers.get(descriptor.kind);
    return {
      kind: descriptor.kind,
      displayName: provider?.displayName ?? descriptor.displayName,
      capabilities: provider?.capabilities ?? {
        runtimeMode: descriptor.kind === 'claude' ? 'interactive' : 'turn-based',
        nativeSteer: descriptor.kind === 'claude',
        nativeQueue: descriptor.kind === 'claude',
        interactivePermissions: descriptor.kind === 'claude',
        askUserQuestion: descriptor.kind === 'claude',
        deferredTools: descriptor.kind === 'claude',
        settingSources: descriptor.kind === 'claude',
        sessionResume: true,
        imageInputs: true,
      },
      available: descriptor.available && Boolean(provider),
      version: descriptor.version,
      reason: descriptor.reason,
    };
  }

  private handleMessage(data: RawData): void {
    let message: ServerToClientMessage;
    try {
      message = parseRemoteProtocolMessage(JSON.parse(data.toString('utf-8'))) as ServerToClientMessage;
    } catch (err) {
      console.warn(`[remote-client] invalid server message: ${err instanceof Error ? err.message : err}`);
      return;
    }

    switch (message.type) {
      case 'server.hello':
        break;
      case 'server.ping':
        this.send({ type: 'client.pong', timestamp: message.timestamp });
        break;
      case 'turn.start':
        void this.handleTurnStart(message);
        break;
      case 'control':
        void this.handleControl(message);
        break;
      case 'client.command':
        void this.handleClientCommand(message);
        break;
      case 'interaction.response':
        this.resolveInteraction(message);
        break;
      default:
        console.warn('[remote-client] unexpected server message');
    }
  }

  private async handleTurnStart(message: TurnStartMessage): Promise<void> {
    try {
      const entry = this.getOrCreateSession(message);
      const result = entry.session.startTurn(message.prompt, {
        attachments: message.attachments,
        effort: message.effort,
        model: message.model,
        onPermissionRequest: (toolName, toolInput, promptSentence, signal) =>
          this.requestInteraction(
            message.turnId,
            'permission',
            { toolName, toolInput, promptSentence },
            signal,
          ) as Promise<'allow' | 'allow_always' | 'deny'>,
        onAskUserQuestion: (questions, signal) =>
          this.requestInteraction(message.turnId, 'ask_user_question', { questions }, signal) as Promise<
            Record<string, string>
          >,
        onDeferredTool: (toolName, toolInput, signal) =>
          this.requestInteraction(
            message.turnId,
            'deferred_tool',
            { toolName, toolInput },
            signal,
          ) as Promise<{ behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; message?: string }>,
      });
      this.activeTurns.set(message.turnId, {
        turnId: message.turnId,
        sessionId: message.sessionId,
        controls: result.controls,
      });
      this.send({ type: 'turn.started', turnId: message.turnId });
      this.sendStatus();
      await this.consumeTurn(message.turnId, entry, result.stream);
    } catch (err) {
      this.send({
        type: 'turn.error',
        turnId: message.turnId,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.activeTurns.delete(message.turnId);
      invalidateLocalSessionIndex();
      this.sendStatus();
    }
  }

  private getOrCreateSession(message: TurnStartMessage): LocalSessionEntry {
    const existing = this.sessions.get(message.sessionId);
    if (
      existing?.session.isAlive &&
      existing.provider === message.provider &&
      existing.workingDirectory === message.workingDirectory &&
      (message.sdkSessionId === undefined || existing.sdkSessionId === message.sdkSessionId)
    ) {
      return existing;
    }

    existing?.session.close();
    const provider = this.providers.require(message.provider);
    const session = provider.createSession({
      workingDirectory: message.workingDirectory,
      sessionId: message.sdkSessionId,
      effort: message.effort,
      model: message.model,
      settingSources: message.settingSources,
      appendSystemPrompt: message.appendSystemPrompt,
    });
    const entry: LocalSessionEntry = {
      sessionId: message.sessionId,
      provider: message.provider,
      workingDirectory: message.workingDirectory,
      sdkSessionId: message.sdkSessionId,
      session,
    };
    this.sessions.set(message.sessionId, entry);
    return entry;
  }

  private async consumeTurn(
    turnId: string,
    entry: LocalSessionEntry,
    stream: ReadableStream<import('../shared/canonical/schema.js').CanonicalEvent>,
  ): Promise<void> {
    try {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.kind === 'query_result') {
          entry.sdkSessionId = value.sessionId || entry.sdkSessionId;
        }
        this.send({ type: 'turn.event', turnId, event: value });
      }
      this.send({ type: 'turn.complete', turnId });
    } catch (err) {
      this.send({
        type: 'turn.error',
        turnId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async requestInteraction(
    turnId: string,
    kind: RemoteInteractionKind,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const interactionId = generateId('interaction', 10);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingInteractions.delete(interactionId);
        reject(new Error(`Remote interaction timed out: ${kind}`));
      }, 10 * 60 * 1000);
      const abort = () => {
        clearTimeout(timer);
        this.pendingInteractions.delete(interactionId);
        reject(new Error(`Remote interaction aborted: ${kind}`));
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.pendingInteractions.set(interactionId, {
        resolve: (message) => {
          signal?.removeEventListener('abort', abort);
          resolve(message.result);
        },
        reject,
        timer,
      });
      this.send({ type: 'interaction.request', interactionId, turnId, kind, payload });
    });
  }

  private resolveInteraction(message: InteractionResponseMessage): void {
    const pending = this.pendingInteractions.get(message.interactionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingInteractions.delete(message.interactionId);
    if (message.ok) {
      pending.resolve(message);
    } else {
      pending.reject(new Error(message.error || 'Remote interaction failed'));
    }
  }

  private async handleControl(message: ControlMessage): Promise<void> {
    try {
      const entry = this.sessions.get(message.sessionId);
      if (!entry) throw new Error(`No local session: ${message.sessionId}`);

      if (message.action === 'interrupt') {
        await entry.session.interruptTurn();
      } else if (message.action === 'stop_task') {
        const turn = this.activeTurnForSession(message.sessionId);
        await turn?.controls?.stopTask(message.taskId || '');
      } else if (message.action === 'close') {
        entry.session.close();
        this.sessions.delete(message.sessionId);
      } else if (message.action === 'steer') {
        entry.session.steerTurn(message.text || '');
      } else if (message.action === 'send_priority') {
        await entry.session.sendWithPriority(message.text || '', message.priority || 'later');
      }

      this.send({ type: 'control.result', controlId: message.controlId, ok: true });
    } catch (err) {
      this.send({
        type: 'control.result',
        controlId: message.controlId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleClientCommand(message: ClientCommandMessage): Promise<void> {
    try {
      if (message.action === 'path.stat') {
        if (!message.path) throw new Error('path is required');
        const path = resolveClientPath(message.path);
        const st = await stat(path);
        this.send({
          type: 'client.command.result',
          commandId: message.commandId,
          ok: true,
          path,
          exists: true,
          isDirectory: st.isDirectory(),
        });
        return;
      }

      if (message.action === 'shell.exec') {
        if (!message.command) throw new Error('command is required');
        if (!message.cwd) throw new Error('cwd is required');
        const result = await execAsync(message.command, {
          cwd: message.cwd,
          timeout: message.timeoutMs ?? 30_000,
          maxBuffer: message.maxBufferBytes ?? 4 * 1024 * 1024,
        });
        this.send({
          type: 'client.command.result',
          commandId: message.commandId,
          ok: true,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: 0,
        });
        return;
      }

      throw new Error(`Unsupported client command: ${message.action}`);
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
        signal?: NodeJS.Signals;
      };
      if (message.action === 'path.stat' && nodeErr.code === 'ENOENT') {
        this.send({
          type: 'client.command.result',
          commandId: message.commandId,
          ok: true,
          path: message.path ? resolveClientPath(message.path) : undefined,
          exists: false,
          isDirectory: false,
        });
        return;
      }
      this.send({
        type: 'client.command.result',
        commandId: message.commandId,
        ok: false,
        stdout: typeof nodeErr.stdout === 'string' ? nodeErr.stdout : undefined,
        stderr: typeof nodeErr.stderr === 'string' ? nodeErr.stderr : undefined,
        exitCode: typeof nodeErr.code === 'number' ? nodeErr.code : undefined,
        signal: nodeErr.signal,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private activeTurnForSession(sessionId: string): ActiveTurn | undefined {
    return [...this.activeTurns.values()].find((turn) => turn.sessionId === sessionId);
  }

  private interruptActiveTurns(): void {
    for (const turn of this.activeTurns.values()) {
      const entry = this.sessions.get(turn.sessionId);
      void entry?.session.interruptTurn().catch(() => {});
    }
    this.activeTurns.clear();
  }

  private sendStatus(): void {
    this.send({
      type: 'client.status',
      activeTurns: this.activeTurns.size,
      sessions: this.scanSessions(),
    });
  }

  private scanSessions(): RemoteSessionDescriptor[] {
    const providerKinds = this.reportableProviderDescriptors().map((provider) => provider.kind);
    return listLocalSessionDescriptors(providerKinds, 20);
  }

  private urlWithToken(serverUrl: string): string {
    if (!this.options.token) return serverUrl;
    const url = new URL(serverUrl);
    if (!url.searchParams.has('token')) {
      url.searchParams.set('token', this.options.token);
    }
    return url.toString();
  }

  private send(message: Parameters<typeof encodeRemoteProtocolMessage>[0]): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(encodeRemoteProtocolMessage(message));
  }
}

export function defaultRemoteClientName(): string {
  return hostname();
}

function buildClientHostDescriptor(): RemoteClientHostDescriptor {
  return {
    hostname: hostname(),
    platform: platform(),
    ipAddresses: localIpv4Addresses(),
  };
}

function localIpv4Addresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue;
      out.push(entry.address);
    }
  }
  return [...new Set(out)].slice(0, 4);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function resolveClientPath(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return resolve(path);
}
