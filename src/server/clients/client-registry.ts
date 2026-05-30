import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { URL } from 'node:url';
import type { AgentProviderKind } from '../../shared/providers/kinds.js';
import type { CanonicalEvent } from '../../shared/canonical/schema.js';
import { generateId } from '../../shared/core/id.js';
import {
  encodeRemoteProtocolMessage,
  parseRemoteProtocolMessage,
  REMOTE_PROTOCOL_VERSION,
  type ClientHelloMessage,
  type ClientCommandMessage,
  type ClientCommandResultMessage,
  type ClientStatusMessage,
  type ControlMessage,
  type ControlResultMessage,
  type InteractionRequestMessage,
  type RemoteClientHostDescriptor,
  type RemoteProviderDescriptor,
  type RemoteClientUpgradeDescriptor,
  type RemoteSessionDescriptor,
  type RemoteWorkspaceDescriptor,
  type ServerPingMessage,
  type ServerToClientMessage,
  type TurnCompleteMessage,
  type TurnErrorMessage,
  type TurnEventMessage,
  type TurnStartMessage,
} from '../../shared/protocol/messages.js';

export interface RemoteClientRegistryOptions {
  port: number;
  path: string;
  token: string;
  serverId?: string;
  heartbeatIntervalMs: number;
  clientTimeoutMs: number;
}

export interface RemoteClientSnapshot {
  clientId: string;
  name: string;
  note?: string;
  providers: RemoteProviderDescriptor[];
  workspaces: RemoteWorkspaceDescriptor[];
  sessions: RemoteSessionDescriptor[];
  activeTurns: number;
  lastSeenAt: number;
  host?: RemoteClientHostDescriptor;
  remoteAddress?: string;
  upgrade?: RemoteClientUpgradeDescriptor;
  version?: string;
}

export interface RemoteTurnCallbacks {
  onStarted?: () => void;
  onEvent: (event: CanonicalEvent) => void;
  onComplete: () => void;
  onError: (message: string) => void;
  onInteractionRequest: (message: InteractionRequestMessage) => void;
}

interface RemoteClientConnection extends RemoteClientSnapshot {
  socket: WebSocket;
}

interface RegisteredTurn {
  clientId: string;
  callbacks: RemoteTurnCallbacks;
}

interface PendingControl {
  resolve: (message: ControlResultMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingClientCommand {
  clientId: string;
  resolve: (message: ClientCommandResultMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RemoteClientRegistry {
  private wss: WebSocketServer | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly serverId: string;
  private readonly clients = new Map<string, RemoteClientConnection>();
  private readonly socketRemoteAddresses = new WeakMap<WebSocket, string>();
  private readonly turns = new Map<string, RegisteredTurn>();
  private readonly pendingControls = new Map<string, PendingControl>();
  private readonly pendingClientCommands = new Map<string, PendingClientCommand>();

  constructor(private readonly options: RemoteClientRegistryOptions) {
    this.serverId = options.serverId || generateId('server', 8);
  }

  start(): void {
    if (this.wss) return;
    this.wss = new WebSocketServer({ port: this.options.port, path: this.options.path });
    this.wss.on('connection', (socket, request) => {
      const remoteAddress = normalizeRemoteAddress(request.socket.remoteAddress);
      if (remoteAddress) this.socketRemoteAddresses.set(socket, remoteAddress);
      if (!this.isAuthorized(request.url, request.headers.authorization)) {
        socket.close(1008, 'unauthorized');
        return;
      }
      socket.on('message', (data) => this.handleSocketMessage(socket, data));
      socket.on('close', () => this.unregisterSocket(socket, 'client disconnected'));
      socket.on('error', (err) => {
        console.warn(`[remote-server] client socket error: ${err.message}`);
      });
    });

    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.options.heartbeatIntervalMs);
    console.log(
      `[remote-server] Listening on ws://0.0.0.0:${this.options.port}${this.options.path}`,
    );
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const client of this.clients.values()) {
      client.socket.close(1001, 'server stopping');
    }
    this.clients.clear();
    this.failAllTurns('remote server stopped');
    for (const pending of this.pendingControls.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('remote server stopped'));
    }
    this.pendingControls.clear();
    for (const pending of this.pendingClientCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('remote server stopped'));
    }
    this.pendingClientCommands.clear();
    this.wss?.close();
    this.wss = null;
  }

  listClients(): RemoteClientSnapshot[] {
    return [...this.clients.values()].map(({ socket: _socket, ...snapshot }) => snapshot);
  }

  listProviderDescriptors(provider: AgentProviderKind): RemoteProviderDescriptor[] {
    return this.listClients()
      .flatMap((client) => client.providers)
      .filter((descriptor) => descriptor.kind === provider);
  }

  hasProvider(provider: AgentProviderKind): boolean {
    return this.listProviderDescriptors(provider).some((descriptor) => descriptor.available);
  }

  selectClient(
    provider: AgentProviderKind,
    workingDirectory: string,
    preferredClientId?: string,
  ): RemoteClientSnapshot {
    const candidates = [...this.clients.values()]
      .filter((client) => !preferredClientId || client.clientId === preferredClientId)
      .filter((client) => client.providers.some((p) => p.kind === provider && p.available))
      .sort((a, b) => a.activeTurns - b.activeTurns || a.clientId.localeCompare(b.clientId));

    const selected = candidates[0];
    if (!selected) {
      const connected = this.clients.size;
      throw new Error(
        `No remote client is available for provider=${provider}, client=${preferredClientId ?? 'auto'}, cwd=${workingDirectory} (connected=${connected})`,
      );
    }
    return this.snapshot(selected);
  }

  registerTurn(turnId: string, clientId: string, callbacks: RemoteTurnCallbacks): void {
    this.turns.set(turnId, { clientId, callbacks });
  }

  unregisterTurn(turnId: string): void {
    const registered = this.turns.get(turnId);
    if (!registered) return;
    this.turns.delete(turnId);
    const client = this.clients.get(registered.clientId);
    if (client) {
      client.activeTurns = Math.max(0, client.activeTurns - 1);
    }
  }

  sendTurnStart(clientId: string, message: TurnStartMessage): void {
    const client = this.requireClient(clientId);
    client.activeTurns += 1;
    this.send(client.socket, message);
  }

  async sendControl(
    clientId: string,
    message: Omit<ControlMessage, 'type' | 'controlId'>,
    timeoutMs = 30_000,
  ): Promise<ControlResultMessage> {
    const client = this.requireClient(clientId);
    const controlId = generateId('control', 8);
    const outbound: ControlMessage = { type: 'control', controlId, ...message };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControls.delete(controlId);
        reject(new Error(`Remote control timed out: ${message.action}`));
      }, timeoutMs);
      this.pendingControls.set(controlId, { resolve, reject, timer });
      this.send(client.socket, outbound);
    });
  }

  async statPath(
    clientId: string,
    path: string,
    timeoutMs = 10_000,
  ): Promise<ClientCommandResultMessage> {
    return this.sendClientCommand(clientId, { action: 'path.stat', path }, timeoutMs);
  }

  async listDirectory(
    clientId: string,
    path: string,
    timeoutMs = 10_000,
  ): Promise<ClientCommandResultMessage> {
    return this.sendClientCommand(clientId, { action: 'path.list', path }, timeoutMs);
  }

  async execShell(
    clientId: string,
    command: string,
    cwd: string,
    options: { timeoutMs?: number; maxBufferBytes?: number } = {},
  ): Promise<ClientCommandResultMessage> {
    return this.sendClientCommand(
      clientId,
      {
        action: 'shell.exec',
        command,
        cwd,
        timeoutMs: options.timeoutMs,
        maxBufferBytes: options.maxBufferBytes,
      },
      options.timeoutMs ? options.timeoutMs + 1_000 : 31_000,
    );
  }

  async upgradeClient(
    clientId: string,
    version: string,
    timeoutMs = 30_000,
  ): Promise<ClientCommandResultMessage> {
    return this.sendClientCommand(clientId, { action: 'client.upgrade', version }, timeoutMs);
  }

  private async sendClientCommand(
    clientId: string,
    message: Omit<ClientCommandMessage, 'type' | 'commandId'>,
    timeoutMs: number,
  ): Promise<ClientCommandResultMessage> {
    const client = this.requireClient(clientId);
    const commandId = generateId('cmd', 10);
    const outbound: ClientCommandMessage = { type: 'client.command', commandId, ...message };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingClientCommands.delete(commandId);
        reject(new Error(`Remote client command timed out: ${message.action}`));
      }, timeoutMs);
      this.pendingClientCommands.set(commandId, { clientId, resolve, reject, timer });
      this.send(client.socket, outbound);
    });
  }

  sendInteractionResponse(clientId: string, message: ServerToClientMessage): void {
    const client = this.requireClient(clientId);
    this.send(client.socket, message);
  }

  private isAuthorized(requestUrl: string | undefined, authorization: string | undefined): boolean {
    const token = this.options.token;
    if (!token) return true;
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    let queryToken: string | undefined;
    try {
      queryToken =
        new URL(requestUrl || '/', 'ws://localhost').searchParams.get('token') ?? undefined;
    } catch {
      queryToken = undefined;
    }
    return bearer === token || queryToken === token;
  }

  private handleSocketMessage(socket: WebSocket, data: RawData): void {
    const raw = data.toString('utf-8');
    let parsed: ReturnType<typeof parseRemoteProtocolMessage>;
    try {
      parsed = parseRemoteProtocolMessage(JSON.parse(raw));
    } catch (err) {
      console.warn(`[remote-server] invalid message: ${err instanceof Error ? err.message : err}`);
      socket.close(1003, 'invalid message');
      return;
    }

    if (parsed.type === 'client.hello') {
      this.registerClient(socket, parsed);
      return;
    }

    const client = this.getClientBySocket(socket);
    if (!client) {
      socket.close(1008, 'hello required');
      return;
    }
    client.lastSeenAt = Date.now();

    switch (parsed.type) {
      case 'client.pong':
        break;
      case 'client.status':
        this.updateClientStatus(client, parsed);
        break;
      case 'turn.started':
        this.turns.get(parsed.turnId)?.callbacks.onStarted?.();
        break;
      case 'turn.event':
        this.handleTurnEvent(parsed);
        break;
      case 'turn.complete':
        this.handleTurnComplete(parsed);
        break;
      case 'turn.error':
        this.handleTurnError(parsed);
        break;
      case 'interaction.request':
        this.turns.get(parsed.turnId)?.callbacks.onInteractionRequest(parsed);
        break;
      case 'control.result':
        this.resolveControl(parsed);
        break;
      case 'client.command.result':
        this.resolveClientCommand(parsed);
        break;
      default:
        console.warn(`[remote-server] unexpected client message: ${parsed.type}`);
    }
  }

  private registerClient(socket: WebSocket, message: ClientHelloMessage): void {
    if (message.protocolVersion !== REMOTE_PROTOCOL_VERSION) {
      socket.close(1002, 'protocol version mismatch');
      return;
    }

    const existing = this.clients.get(message.clientId);
    if (existing && existing.socket !== socket) {
      existing.socket.close(1000, 'client reconnected');
      this.unregisterSocket(existing.socket, 'client reconnected');
    }

    const client: RemoteClientConnection = {
      clientId: message.clientId,
      name: message.name,
      note: message.note,
      providers: message.providers,
      workspaces: message.workspaces,
      sessions: message.sessions ?? [],
      activeTurns: 0,
      lastSeenAt: Date.now(),
      host: message.host,
      remoteAddress: this.socketRemoteAddresses.get(socket),
      upgrade: message.upgrade,
      version: message.version,
      socket,
    };
    this.clients.set(client.clientId, client);
    this.send(socket, {
      type: 'server.hello',
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      serverId: this.serverId,
      heartbeatIntervalMs: this.options.heartbeatIntervalMs,
    });
    console.log(
      `[remote-server] client connected id=${client.clientId} name=${client.name} providers=${client.providers.map((p) => p.kind).join(',') || 'none'}`,
    );
  }

  private unregisterSocket(socket: WebSocket, reason: string): void {
    const client = this.getClientBySocket(socket);
    if (!client) return;
    this.clients.delete(client.clientId);
    for (const [turnId, turn] of this.turns) {
      if (turn.clientId !== client.clientId) continue;
      turn.callbacks.onError(reason);
      turn.callbacks.onComplete();
      this.turns.delete(turnId);
    }
    for (const [commandId, pending] of this.pendingClientCommands) {
      if (pending.clientId !== client.clientId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(`Remote client disconnected: ${client.clientId}`));
      this.pendingClientCommands.delete(commandId);
    }
    console.log(`[remote-server] client disconnected id=${client.clientId}: ${reason}`);
  }

  private handleTurnEvent(message: TurnEventMessage): void {
    this.turns.get(message.turnId)?.callbacks.onEvent(message.event);
  }

  private handleTurnComplete(message: TurnCompleteMessage): void {
    const turn = this.turns.get(message.turnId);
    if (!turn) return;
    turn.callbacks.onComplete();
    this.unregisterTurn(message.turnId);
  }

  private handleTurnError(message: TurnErrorMessage): void {
    const turn = this.turns.get(message.turnId);
    if (!turn) return;
    turn.callbacks.onError(message.message);
    turn.callbacks.onComplete();
    this.unregisterTurn(message.turnId);
  }

  private resolveControl(message: ControlResultMessage): void {
    const pending = this.pendingControls.get(message.controlId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingControls.delete(message.controlId);
    pending.resolve(message);
  }

  private resolveClientCommand(message: ClientCommandResultMessage): void {
    const pending = this.pendingClientCommands.get(message.commandId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingClientCommands.delete(message.commandId);
    pending.resolve(message);
  }

  private updateClientStatus(client: RemoteClientConnection, message: ClientStatusMessage): void {
    client.activeTurns = message.activeTurns;
    client.sessions = message.sessions ?? client.sessions;
  }

  private sendHeartbeat(): void {
    const now = Date.now();
    const ping: ServerPingMessage = { type: 'server.ping', timestamp: now };
    for (const client of this.clients.values()) {
      if (now - client.lastSeenAt > this.options.clientTimeoutMs) {
        client.socket.close(1001, 'heartbeat timeout');
        this.unregisterSocket(client.socket, 'heartbeat timeout');
        continue;
      }
      this.send(client.socket, ping);
    }
  }

  private failAllTurns(message: string): void {
    for (const turn of this.turns.values()) {
      turn.callbacks.onError(message);
      turn.callbacks.onComplete();
    }
    this.turns.clear();
  }

  private requireClient(clientId: string): RemoteClientConnection {
    const client = this.clients.get(clientId);
    if (!client || client.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`Remote client is not connected: ${clientId}`);
    }
    return client;
  }

  private getClientBySocket(socket: WebSocket): RemoteClientConnection | undefined {
    return [...this.clients.values()].find((client) => client.socket === socket);
  }

  private snapshot(client: RemoteClientConnection): RemoteClientSnapshot {
    const { socket: _socket, ...snapshot } = client;
    return snapshot;
  }

  private send(socket: WebSocket, message: ServerToClientMessage): void {
    if (socket.readyState !== WebSocket.OPEN) {
      throw new Error('Remote socket is not open');
    }
    socket.send(encodeRemoteProtocolMessage(message));
  }
}

function normalizeRemoteAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}
