import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager as PiSessionManager,
  getAgentDir,
  type AgentSession,
  type CreateAgentSessionOptions,
} from '@earendil-works/pi-coding-agent';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PiAdapter } from './pi-adapter.js';
import type { CanonicalEvent } from '../../shared/canonical/schema.js';
import type {
  AgentRuntimeInfo,
  CreateSessionParams,
  FileAttachment,
  LiveSession,
  MessagePriority,
  QueryControls,
  StreamChatResult,
  TurnParams,
} from '../../shared/providers/base.js';
import type { EffortLevel } from '../../shared/providers/effort.js';
import { expandTilde } from '../../shared/core/path.js';
import type { PiRuntimeOptions, PiThinkingLevel } from './pi-config.js';

export type PiSessionOptions = CreateSessionParams & PiRuntimeOptions;

interface PiTurnContext {
  readonly token: symbol;
  readonly abortController: AbortController;
  readonly adapter: PiAdapter;
  controller: ReadableStreamDefaultController<CanonicalEvent> | null;
  closed: boolean;
}

export class PiLiveSession implements LiveSession {
  readonly capabilities = { nativeSteer: true, nativeQueue: true };

  private session: AgentSession | undefined;
  private initPromise: Promise<AgentSession> | undefined;
  private activeTurn: PiTurnContext | null = null;
  private lifecycleCallbacks: { onTurnComplete?: () => void } = {};
  private _isAlive = true;
  private _isTurnActive = false;
  private _runtimeInfo: AgentRuntimeInfo = { provider: 'pi', displayName: 'Pi' };
  private sdkSessionId: string | undefined;

  constructor(private readonly options: PiSessionOptions) {
    this.sdkSessionId = options.sessionId;
    if (options.model) this._runtimeInfo.model = options.model;
    const reasoningEffort = options.thinkingLevel ?? toPiThinkingLevel(options.effort);
    if (reasoningEffort) this._runtimeInfo.reasoningEffort = reasoningEffort;
  }

  get runtimeInfo(): AgentRuntimeInfo {
    return this._runtimeInfo;
  }

  get isAlive(): boolean {
    return this._isAlive;
  }

  get isTurnActive(): boolean {
    return this._isTurnActive;
  }

  setLifecycleCallbacks(callbacks: { onTurnComplete?: () => void }): void {
    this.lifecycleCallbacks = callbacks;
  }

  startTurn(prompt: string, params?: TurnParams): StreamChatResult {
    if (!this._isAlive) throw new Error('Session is closed');
    if (this.activeTurn) throw new Error('Pi session already has an active turn');

    const context = this.createTurnContext();
    const controls: QueryControls = {
      interrupt: async () => {
        context.abortController.abort();
        await this.session?.abort();
      },
      stopTask: async () => {},
    };

    const stream = new ReadableStream<CanonicalEvent>({
      start: (controller) => {
        context.controller = controller;
        this.activeTurn = context;
        this._isTurnActive = true;
        void this.consumeTurn(prompt, params, context);
      },
      cancel: () => {
        context.abortController.abort();
        context.closed = true;
        void this.session?.abort().catch(() => {});
      },
    });

    return { stream, controls };
  }

  steerTurn(text: string): void {
    if (!this._isAlive || !this._isTurnActive || !this.session) return;
    void this.session.steer(text).catch(() => {});
  }

  async sendWithPriority(text: string, priority: MessagePriority): Promise<void> {
    if (!this._isAlive) return;
    const session = await this.getOrCreateSession();
    if (priority === 'later') {
      await session.followUp(text);
      return;
    }
    await session.steer(text);
  }

  async interruptTurn(): Promise<void> {
    this.activeTurn?.abortController.abort();
    await this.session?.abort();
  }

  close(): void {
    this._isAlive = false;
    this._isTurnActive = false;
    this.activeTurn?.abortController.abort();
    this.closeTurnContext(this.activeTurn);
    this.activeTurn = null;
    this.session?.dispose();
  }

  private async consumeTurn(
    prompt: string,
    params: TurnParams | undefined,
    context: PiTurnContext,
  ): Promise<void> {
    let unsubscribe: (() => void) | undefined;
    try {
      const session = await this.getOrCreateSession(params);
      context.adapter.updateRuntime({
        sessionId: this.sdkSessionId,
        model: this._runtimeInfo.model,
        reasoningEffort: this._runtimeInfo.reasoningEffort,
      });
      this.enqueueTurnEvent(context, {
        kind: 'status',
        sessionId: this.sdkSessionId ?? '',
        ...(this._runtimeInfo.model ? { model: this._runtimeInfo.model } : {}),
      });
      unsubscribe = session.subscribe((event) => {
        for (const mapped of context.adapter.mapEvent(event)) {
          this.enqueueTurnEvent(context, mapped);
        }
      });

      const prepared = this.buildPrompt(prompt, params);
      await session.prompt(prepared.prompt, {
        expandPromptTemplates: true,
        ...(prepared.images ? { images: prepared.images } : {}),
      });

      this.rememberSessionId(session);
      context.adapter.updateRuntime({
        sessionId: this.sdkSessionId,
        model: this._runtimeInfo.model,
        reasoningEffort: this._runtimeInfo.reasoningEffort,
      });
      for (const mapped of context.adapter.mapComplete(session.messages)) {
        this.enqueueTurnEvent(context, mapped);
      }
    } catch (err) {
      for (const mapped of context.adapter.mapError(err, context.abortController.signal.aborted)) {
        this.enqueueTurnEvent(context, mapped);
      }
    } finally {
      unsubscribe?.();
      this.finishTurnContext(context);
    }
  }

  private createTurnContext(): PiTurnContext {
    return {
      token: Symbol('pi-turn'),
      abortController: new AbortController(),
      adapter: new PiAdapter({
        sessionId: this.sdkSessionId,
        model: this._runtimeInfo.model,
        reasoningEffort: this._runtimeInfo.reasoningEffort,
      }),
      controller: null,
      closed: false,
    };
  }

  private async getOrCreateSession(params?: TurnParams): Promise<AgentSession> {
    if (this.session) return this.session;
    this.initPromise ??= this.createPiSession(params);
    this.session = await this.initPromise;
    return this.session;
  }

  private async createPiSession(params?: TurnParams): Promise<AgentSession> {
    if (this.options.offline) process.env.PI_OFFLINE = '1';

    const authStorage = this.createAuthStorage();
    const modelRegistry = ModelRegistry.create(authStorage, this.modelsJsonPath());
    const model = this.resolveModel(modelRegistry, params?.model ?? this.options.model);
    const thinkingLevel =
      this.options.thinkingLevel ?? toPiThinkingLevel(params?.effort ?? this.options.effort);

    const createOptions: CreateAgentSessionOptions = {
      cwd: this.options.workingDirectory,
      agentDir: this.options.agentDir,
      authStorage,
      modelRegistry,
      sessionManager: this.createSessionManager(),
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };

    const result = await createAgentSession(createOptions);
    this.rememberSessionId(result.session);
    this.updateRuntimeInfo(result.session);
    return result.session;
  }

  private createAuthStorage(): AuthStorage {
    const agentDir = this.options.agentDir ? resolve(expandTilde(this.options.agentDir)) : undefined;
    return AuthStorage.create(agentDir ? join(agentDir, 'auth.json') : undefined);
  }

  private modelsJsonPath(): string | undefined {
    return this.options.agentDir
      ? join(resolve(expandTilde(this.options.agentDir)), 'models.json')
      : undefined;
  }

  private createSessionManager(): PiSessionManager {
    const cwd = this.options.workingDirectory;
    const sessionDir = this.options.sessionDir
      ? resolve(expandTilde(this.options.sessionDir))
      : undefined;

    if (this.options.noSession) return PiSessionManager.inMemory(cwd);
    if (!this.options.sessionId) return PiSessionManager.create(cwd, sessionDir);

    const sessionPath = resolvePiSessionPath(this.options.sessionId);
    if (!existsSync(sessionPath)) {
      throw new Error(`Pi session file not found: ${this.options.sessionId}`);
    }
    return PiSessionManager.open(sessionPath, sessionDir, cwd);
  }

  private resolveModel(
    modelRegistry: ModelRegistry,
    modelPattern: string | undefined,
  ): ReturnType<ModelRegistry['find']> | undefined {
    if (!modelPattern) {
      if (!this.options.provider) return undefined;
      const model =
        modelRegistry.getAvailable().find((candidate) => candidate.provider === this.options.provider) ??
        modelRegistry.getAll().find((candidate) => candidate.provider === this.options.provider);
      if (!model) throw new Error(`Pi provider not found: ${this.options.provider}`);
      return model;
    }
    const trimmed = modelPattern.trim();
    if (!trimmed) return undefined;

    const slash = trimmed.indexOf('/');
    if (slash > 0) {
      const model = modelRegistry.find(trimmed.slice(0, slash), trimmed.slice(slash + 1));
      if (!model) throw new Error(`Pi model not found: ${trimmed}`);
      return model;
    }

    if (this.options.provider) {
      const model = modelRegistry.find(this.options.provider, trimmed);
      if (!model) throw new Error(`Pi model not found: ${this.options.provider}/${trimmed}`);
      return model;
    }

    const model = modelRegistry
      .getAll()
      .find((candidate) => candidate.id === trimmed || candidate.name === trimmed);
    if (!model) throw new Error(`Pi model not found: ${trimmed}`);
    return model;
  }

  private buildPrompt(
    prompt: string,
    params?: TurnParams,
  ): { prompt: string; images?: Array<{ type: 'image'; data: string; mimeType: string }> } {
    const fullPrompt = this.options.appendSystemPrompt
      ? `${this.options.appendSystemPrompt}\n\n${prompt}`
      : prompt;
    const images = params?.attachments
      ?.filter((attachment) => attachment.type === 'image' && attachment.base64Data)
      .map((attachment: FileAttachment) => ({
        type: 'image' as const,
        data: attachment.base64Data,
        mimeType: attachment.mimeType || 'image/png',
      }));
    return {
      prompt: fullPrompt,
      ...(images?.length ? { images } : {}),
    };
  }

  private rememberSessionId(session: AgentSession): void {
    this.sdkSessionId = session.sessionFile ?? session.sessionId ?? this.sdkSessionId;
  }

  private updateRuntimeInfo(session: AgentSession): void {
    this._runtimeInfo = {
      provider: 'pi',
      displayName: 'Pi',
      ...(session.model ? { model: `${session.model.provider}/${session.model.id}` } : {}),
      ...(session.thinkingLevel ? { reasoningEffort: session.thinkingLevel } : {}),
    };
  }

  private enqueueTurnEvent(context: PiTurnContext, event: CanonicalEvent): void {
    if (context.closed) return;
    try {
      context.controller?.enqueue(event);
    } catch {
      context.closed = true;
    }
  }

  private finishTurnContext(context: PiTurnContext): void {
    this.closeTurnContext(context);
    if (this.activeTurn?.token !== context.token) return;
    this.activeTurn = null;
    this._isTurnActive = false;
    this.lifecycleCallbacks.onTurnComplete?.();
  }

  private closeTurnContext(context: PiTurnContext | null): void {
    if (!context) return;
    context.closed = true;
    try {
      context.controller?.close();
    } catch {
      /* already closed */
    }
    context.controller = null;
  }
}

export function toPiThinkingLevel(effort: EffortLevel | undefined): PiThinkingLevel | undefined {
  if (effort === 'max') return 'xhigh';
  return effort;
}

export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || getAgentDir();
}

function resolvePiSessionPath(sessionId: string): string {
  return resolve(expandTilde(sessionId));
}
