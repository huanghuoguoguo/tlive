import type { CanonicalEvent } from '../../shared/canonical/schema.js';
import { generateId } from '../../shared/core/id.js';
import type {
  AgentProvider,
  AgentProviderCapabilities,
  AgentRuntimeInfo,
  CreateSessionParams,
  LiveSession,
  MessagePriority,
  QueryControls,
  StreamChatParams,
  StreamChatResult,
  TurnParams,
} from '../../shared/providers/base.js';
import type { AgentProviderKind } from '../../shared/providers/kinds.js';
import { CommandBlockedError, NoActiveTurnError } from '../../shared/providers/errors.js';
import type {
  InteractionRequestMessage,
  RemoteInteractionKind,
  TurnStartMessage,
} from '../../shared/protocol/messages.js';
import type { RemoteClientRegistry, RemoteClientSnapshot } from '../clients/client-registry.js';

/**
 * Controls the inbound message loop waits on. A worker that ignores them used to
 * hold the whole Feishu loop for the registry's 30s default before failing.
 */
const INLINE_CONTROL_TIMEOUT_MS = 8_000;

function remoteDisplayName(provider: AgentProviderKind): string {
  if (provider === 'claude') return 'Remote Claude Code';
  if (provider === 'pi') return 'Remote Pi';
  return 'Remote Codex';
}

/**
 * Server-side fallback table, used until a client reports its own capabilities
 * through `client.hello` (see {@link RemoteLiveSession.capabilities}). Codex runs
 * one turn per process launch, so it is the only genuinely turn-based provider.
 */
function remoteCapabilities(provider: AgentProviderKind): AgentProviderCapabilities {
  if (provider === 'claude') {
    return {
      runtimeMode: 'interactive',
      nativeSteer: true,
      nativeQueue: true,
      drainsQueueWhenIdle: true,
      interactivePermissions: true,
      askUserQuestion: true,
      deferredTools: true,
      settingSources: true,
      sessionResume: true,
      imageInputs: true,
    };
  }
  if (provider === 'pi') {
    return {
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
  }
  return {
    runtimeMode: 'turn-based',
    nativeSteer: false,
    nativeQueue: false,
    drainsQueueWhenIdle: false,
    interactivePermissions: false,
    askUserQuestion: false,
    deferredTools: false,
    settingSources: false,
    sessionResume: true,
    imageInputs: true,
  };
}

export class RemoteAgentProvider implements AgentProvider {
  readonly displayName: string;
  readonly capabilities: AgentProviderCapabilities;

  constructor(
    readonly kind: AgentProviderKind,
    private readonly clients: RemoteClientRegistry,
  ) {
    this.displayName = remoteDisplayName(kind);
    this.capabilities = remoteCapabilities(kind);
  }

  createSession(params: CreateSessionParams): LiveSession {
    return new RemoteLiveSession(this.kind, this.clients, params);
  }

  streamChat(params: StreamChatParams): StreamChatResult {
    const session = this.createSession({
      workingDirectory: params.workingDirectory,
      sessionId: params.sessionId,
      clientId: params.clientId,
      effort: params.effort,
      model: params.model,
      settingSources: params.settingSources,
    });
    return session.startTurn(params.prompt, {
      attachments: params.attachments,
      onPermissionRequest: params.onPermissionRequest,
      onAskUserQuestion: params.onAskUserQuestion,
      onDeferredTool: params.onDeferredTool,
      effort: params.effort,
      model: params.model,
    });
  }
}

class RemoteLiveSession implements LiveSession {
  readonly runtimeInfo: AgentRuntimeInfo;

  private readonly remoteSessionId = generateId('remote-session', 8);
  private client: RemoteClientSnapshot | null = null;
  private _isAlive = true;
  private _isTurnActive = false;
  private currentTurnId: string | null = null;
  private currentController: ReadableStreamDefaultController<CanonicalEvent> | null = null;
  private currentTurnParams: TurnParams | undefined;
  private lifecycleCallbacks: { onTurnComplete?: () => void } = {};

  constructor(
    private readonly provider: AgentProviderKind,
    private readonly clients: RemoteClientRegistry,
    private readonly params: CreateSessionParams,
  ) {
    this.runtimeInfo = {
      provider,
      displayName: remoteDisplayName(provider),
      ...(params.model ? { model: params.model } : {}),
      ...(params.effort ? { reasoningEffort: params.effort } : {}),
    };
  }

  get isAlive(): boolean {
    return this._isAlive;
  }

  /**
   * Steering and queueing are really features of the client that runs the agent,
   * so prefer what that client reported in `client.hello`. The static table only
   * covers the window before the first turn binds a client.
   */
  get capabilities(): Pick<
    AgentProviderCapabilities,
    'nativeSteer' | 'nativeQueue' | 'drainsQueueWhenIdle'
  > {
    const reported = this.client?.providers.find(
      (descriptor) => descriptor.kind === this.provider,
    )?.capabilities;
    const fallback = remoteCapabilities(this.provider);
    return {
      nativeSteer: reported?.nativeSteer ?? fallback.nativeSteer,
      nativeQueue: reported?.nativeQueue ?? fallback.nativeQueue,
      drainsQueueWhenIdle: reported?.drainsQueueWhenIdle ?? fallback.drainsQueueWhenIdle,
    };
  }

  get isTurnActive(): boolean {
    return this._isTurnActive;
  }

  setLifecycleCallbacks(callbacks: { onTurnComplete?: () => void }): void {
    this.lifecycleCallbacks = callbacks;
  }

  startTurn(prompt: string, params?: TurnParams): StreamChatResult {
    if (!this._isAlive) throw new Error('Remote session is closed');
    if (this._isTurnActive) {
      this.closeCurrentTurn();
    }

    const turnId = generateId('turn', 10);
    const controls: QueryControls = {
      interrupt: async () => this.sendControl('interrupt'),
      stopTask: async (taskId: string) => this.sendControl('stop_task', { taskId }),
    };

    const stream = new ReadableStream<CanonicalEvent>({
      start: (controller) => {
        this.currentController = controller;
        this.currentTurnId = turnId;
        this.currentTurnParams = params;
        this._isTurnActive = true;
        try {
          const client = this.ensureClient();
          this.clients.registerTurn(turnId, client.clientId, {
            onEvent: (event) => this.enqueueTurnEvent(turnId, event),
            onError: (message) => this.enqueueTurnError(turnId, message),
            onComplete: () => this.finishTurn(turnId),
            onInteractionRequest: (message) => this.handleInteractionRequest(message),
          });
          this.clients.sendTurnStart(client.clientId, this.buildTurnStart(turnId, prompt, params));
        } catch (err) {
          this._isAlive = false;
          this.clients.unregisterTurn(turnId);
          this.enqueueTurnError(turnId, err instanceof Error ? err.message : String(err));
          this.finishTurn(turnId);
        }
      },
      cancel: () => {
        void this.sendControl('interrupt').catch(() => {});
        this.closeCurrentTurn();
      },
    });

    return { stream, controls };
  }

  steerTurn(text: string): void {
    void this.sendControl('steer', { text }).catch((err) => {
      console.warn(`[remote-provider] steer failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  async sendWithPriority(text: string, priority: MessagePriority): Promise<void> {
    await this.sendControl('send_priority', { text, priority });
  }

  async interruptTurn(): Promise<void> {
    await this.sendControl('interrupt');
  }

  close(): void {
    if (!this._isAlive) return;
    this._isAlive = false;
    void this.sendControl('close').catch(() => {});
    this.closeCurrentTurn();
  }

  private ensureClient(): RemoteClientSnapshot {
    if (this.client) return this.client;
    this.client = this.clients.selectClient(
      this.provider,
      this.params.workingDirectory,
      this.params.clientId,
    );
    return this.client;
  }

  private buildTurnStart(
    turnId: string,
    prompt: string,
    turnParams?: TurnParams,
  ): TurnStartMessage {
    return {
      type: 'turn.start',
      turnId,
      sessionId: this.remoteSessionId,
      provider: this.provider,
      prompt,
      workingDirectory: this.params.workingDirectory,
      sdkSessionId: this.params.sessionId,
      model: turnParams?.model ?? this.params.model,
      effort: turnParams?.effort ?? this.params.effort,
      settingSources: this.params.settingSources,
      appendSystemPrompt: this.params.appendSystemPrompt,
      attachments: turnParams?.attachments,
    };
  }

  private enqueueTurnEvent(turnId: string, event: CanonicalEvent): void {
    if (this.currentTurnId !== turnId) return;
    try {
      this.currentController?.enqueue(event);
    } catch {
      this.closeCurrentTurn();
    }
  }

  private enqueueTurnError(turnId: string, message: string): void {
    if (this.currentTurnId !== turnId) return;
    this.enqueueTurnEvent(turnId, { kind: 'error', message });
  }

  private finishTurn(turnId: string): void {
    if (this.currentTurnId !== turnId) return;
    try {
      this.currentController?.close();
    } catch {
      /* already closed */
    }
    this.currentController = null;
    this.currentTurnId = null;
    this.currentTurnParams = undefined;
    this._isTurnActive = false;
    this.lifecycleCallbacks.onTurnComplete?.();
  }

  private closeCurrentTurn(): void {
    const turnId = this.currentTurnId;
    if (turnId) this.clients.unregisterTurn(turnId);
    try {
      this.currentController?.close();
    } catch {
      /* already closed */
    }
    this.currentController = null;
    this.currentTurnId = null;
    this.currentTurnParams = undefined;
    this._isTurnActive = false;
  }

  private async sendControl(
    action: 'interrupt' | 'stop_task' | 'close' | 'steer' | 'send_priority',
    extra: { taskId?: string; text?: string; priority?: MessagePriority } = {},
  ): Promise<void> {
    if (!this.client) return;
    const result = await this.clients.sendControl(
      this.client.clientId,
      {
        sessionId: this.remoteSessionId,
        action,
        ...extra,
      },
      // Only 'close' has nobody waiting on it; the rest block the inbound loop.
      action === 'close' ? undefined : INLINE_CONTROL_TIMEOUT_MS,
    );
    if (!result.ok) {
      // Restore the refusal the client classified, so the engine can tell "no turn
      // to inject into" apart from a transport failure.
      if (result.code === 'no_active_turn') {
        throw new NoActiveTurnError(result.error ?? 'Remote provider has no active turn');
      }
      if (result.code === 'command_blocked') {
        throw new CommandBlockedError();
      }
      throw new Error(result.error || `Remote control failed: ${action}`);
    }
  }

  private async handleInteractionRequest(message: InteractionRequestMessage): Promise<void> {
    if (!this.client) return;
    try {
      const result = await this.resolveInteraction(message.kind, message.payload);
      this.clients.sendInteractionResponse(this.client.clientId, {
        type: 'interaction.response',
        interactionId: message.interactionId,
        ok: true,
        result,
      });
    } catch (err) {
      this.clients.sendInteractionResponse(this.client.clientId, {
        type: 'interaction.response',
        interactionId: message.interactionId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async resolveInteraction(
    kind: RemoteInteractionKind,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    const params = this.currentTurnParams;
    if (kind === 'permission') {
      const handler = params?.onPermissionRequest;
      if (!handler) return 'deny';
      return handler(
        stringField(payload, 'toolName'),
        recordField(payload, 'toolInput'),
        stringField(payload, 'promptSentence'),
      );
    }
    if (kind === 'ask_user_question') {
      const handler = params?.onAskUserQuestion;
      if (!handler) return {};
      return handler(arrayField(payload, 'questions') as Parameters<typeof handler>[0]);
    }

    const handler = params?.onDeferredTool;
    if (!handler) return { behavior: 'deny', message: 'No deferred tool handler is available' };
    return handler(stringField(payload, 'toolName'), recordField(payload, 'toolInput'));
  }
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

function recordField(payload: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = payload[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayField(payload: Record<string, unknown>, key: string): unknown[] {
  const value = payload[key];
  return Array.isArray(value) ? value : [];
}
