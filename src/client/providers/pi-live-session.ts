import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type AgentSession,
  type CreateAgentSessionOptions,
  createAgentSession,
  getAgentDir,
  ModelRuntime,
  SessionManager as PiSessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type { CanonicalEvent } from '../../shared/canonical/schema.js';
import { expandTilde } from '../../shared/core/path.js';
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
import { CommandBlockedError, NoActiveTurnError } from '../../shared/providers/errors.js';
import type { AskUserQuestionHandler } from '../../shared/providers/types.js';
import { PiAdapter } from './pi-adapter.js';
import { createPiAskBridge } from './pi-ask-bridge.js';
import type { PiRuntimeOptions, PiThinkingLevel } from './pi-config.js';

export type PiSessionOptions = CreateSessionParams & PiRuntimeOptions;

/** A Pi model descriptor as resolved from the runtime catalog. */
type PiModel = NonNullable<ReturnType<ModelRuntime['getModel']>>;

interface PiTurnContext {
  readonly token: symbol;
  readonly abortController: AbortController;
  readonly adapter: PiAdapter;
  controller: ReadableStreamDefaultController<CanonicalEvent> | null;
  closed: boolean;
}

/** How long the next turn waits for an aborted pi run to go idle before prompting anyway. */
const TURN_RETIRE_TIMEOUT_MS = 15_000;

export class PiLiveSession implements LiveSession {
  readonly capabilities = {
    nativeSteer: true,
    nativeQueue: true,
    drainsQueueWhenIdle: false,
  };

  private session: AgentSession | undefined;
  private initPromise: Promise<AgentSession> | undefined;
  /** Held so `/model` can re-derive the compaction reserve for the new window. */
  private settingsManager: SettingsManager | undefined;
  private activeTurn: PiTurnContext | null = null;
  /** Set when a turn was torn down while pi may still be running; the next turn waits on it. */
  private abandonedRun: Promise<unknown> | undefined;
  private lifecycleCallbacks: { onTurnComplete?: () => void } = {};
  private _isAlive = true;
  private _isTurnActive = false;
  private _runtimeInfo: AgentRuntimeInfo = { provider: 'pi', displayName: 'Pi' };
  private sdkSessionId: string | undefined;
  /** AskUserQuestion handler from the current turn — used to bridge Pi's `ask` tool to Feishu */
  private _turnAskQuestionHandler: AskUserQuestionHandler | undefined;

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
    // Reaching here with a turn still held means the bridge already gave up on it, so
    // refusing would poison the session: every later message hit the same guard while
    // /stop had nothing left to act on.
    if (this.activeTurn) this.retireTurnContext(this.activeTurn, true);

    this._turnAskQuestionHandler = params?.onAskUserQuestion;

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
        this.retireTurnContext(context);
      },
    });

    return { stream, controls };
  }

  steerTurn(text: string): void {
    const session = this.session;
    if (!this._isAlive || !session?.isStreaming) {
      console.warn('[pi] steer ignored: no agent run to steer into');
      return;
    }
    const blocked = piTuiOnlyCommandName(text);
    if (blocked) {
      console.warn(`[pi] /${blocked} cannot be steered; ignored`);
      return;
    }
    void session.steer(text).catch((err: unknown) => {
      console.warn(`[pi] steer failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  async sendWithPriority(text: string, priority: MessagePriority): Promise<void> {
    // Never create a session just to inject into it: pi's steer()/followUp() are
    // plain enqueues that resolve happily with no agent run consuming them, so
    // the bridge would report success for a message nobody will ever read.
    const session = this.session;
    if (!this._isAlive || !session?.isStreaming) {
      throw new NoActiveTurnError('Pi has no running agent turn to inject into');
    }
    const blocked = piTuiOnlyCommandName(text);
    if (blocked) {
      throw new CommandBlockedError(blocked);
    }
    if (priority === 'later') {
      await session.followUp(text);
      return;
    }
    await session.steer(text);
  }

  async interruptTurn(): Promise<void> {
    this.activeTurn?.abortController.abort();
    // pi's abort() signals synchronously but then waits for the agent to go idle,
    // which can take minutes while the upstream retries. The caller is the inbound
    // message loop, so awaiting here stalls every chat behind one /stop. The turn
    // still closes through session.prompt() settling in consumeTurn.
    if (!this.session) return;
    this.abandonedRun = this.session.abort().catch((err: unknown) => {
      console.warn(
        `[pi] abort did not settle: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
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
      await this.awaitRunHandoff(session);
      const initialMessageCount = session.messages.length;
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
      // Bind the ask bridge UIContext so Pi's `ask` tool routes through Feishu
      await session.bindExtensions({
        uiContext: createPiAskBridge(this._turnAskQuestionHandler, context.abortController.signal),
      });

      unsubscribe = session.subscribe((event) => {
        for (const mapped of context.adapter.mapEvent(event)) {
          this.enqueueTurnEvent(context, mapped);
        }
      });

      const modelCommand = parsePiModelCommand(prompt);
      if (modelCommand) {
        await this.handleModelCommand(session, modelCommand.modelPattern, context);
        return;
      }

      const compactCommand = parsePiCompactCommand(prompt);
      if (compactCommand) {
        await this.handleCompactCommand(session, compactCommand.customInstructions, context);
        return;
      }

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
      // Emit context usage BEFORE mapComplete so it's available when footer is rendered
      const ctxUsage = session.getContextUsage();
      if (ctxUsage) {
        console.log(
          `[pi] contextUsage: tokens=${ctxUsage.tokens} window=${ctxUsage.contextWindow} percent=${ctxUsage.percent}%`,
        );
        this.enqueueTurnEvent(context, {
          kind: 'context_usage',
          tokens: ctxUsage.tokens,
          contextWindow: ctxUsage.contextWindow,
          percent: ctxUsage.percent,
        });
      } else {
        console.log(
          `[pi] contextUsage: undefined (model=${session.model?.id ?? 'none'}, window=${session.model?.contextWindow ?? 0})`,
        );
      }
      for (const mapped of context.adapter.mapComplete(
        session.messages.slice(initialMessageCount),
        ctxUsage?.tokens ?? undefined,
      )) {
        this.enqueueTurnEvent(context, mapped);
      }
    } catch (err) {
      for (const mapped of context.adapter.mapError(err, context.abortController.signal.aborted)) {
        this.enqueueTurnEvent(context, mapped);
      }
    } finally {
      unsubscribe?.();
      this.finishTurnContext(context);
      this._turnAskQuestionHandler = undefined;
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

  private async handleModelCommand(
    session: AgentSession,
    modelPattern: string | undefined,
    context: PiTurnContext,
  ): Promise<void> {
    if (!modelPattern) throw new Error('Usage: /model <provider/model>');

    const model = this.resolveModel(session.modelRuntime, modelPattern);
    if (!model) throw new Error(`Pi model not found: ${modelPattern}`);

    await session.setModel(model);
    this.applyCompactionReserve(session);
    this.updateRuntimeInfo(session);
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
    this.enqueueTurnEvent(context, {
      kind: 'text_delta',
      text: `Model switched to ${model.provider}/${model.id}`,
    });

    const ctxUsage = session.getContextUsage();
    if (ctxUsage) {
      this.enqueueTurnEvent(context, {
        kind: 'context_usage',
        tokens: ctxUsage.tokens,
        contextWindow: ctxUsage.contextWindow,
        percent: ctxUsage.percent,
      });
    }
    for (const mapped of context.adapter.mapComplete([], ctxUsage?.tokens ?? undefined)) {
      this.enqueueTurnEvent(context, mapped);
    }
  }

  /**
   * Run `/compact [instructions]`. Pi only implements this command in its TUI, so
   * tlive calls the SDK method directly. `compaction_start`/`compaction_end` reach
   * the card through the subscription set up in {@link consumeTurn}.
   * Failures ("Already compacted" / "session too small") surface as a failed turn.
   */
  private async handleCompactCommand(
    session: AgentSession,
    customInstructions: string | undefined,
    context: PiTurnContext,
  ): Promise<void> {
    const result = await session.compact(customInstructions);
    this.enqueueTurnEvent(context, {
      kind: 'text_delta',
      text: `📦 已压缩上下文（压缩前 ${result.tokensBefore} tokens）`,
    });

    const ctxUsage = session.getContextUsage();
    if (ctxUsage) {
      this.enqueueTurnEvent(context, {
        kind: 'context_usage',
        tokens: ctxUsage.tokens,
        contextWindow: ctxUsage.contextWindow,
        percent: ctxUsage.percent,
      });
    }
    for (const mapped of context.adapter.mapComplete([], ctxUsage?.tokens ?? undefined)) {
      this.enqueueTurnEvent(context, mapped);
    }
  }

  private async getOrCreateSession(params?: TurnParams): Promise<AgentSession> {
    if (this.session) return this.session;
    this.initPromise ??= this.createPiSession(params);
    this.session = await this.initPromise;
    return this.session;
  }

  private async createPiSession(params?: TurnParams): Promise<AgentSession> {
    if (this.options.offline) process.env.PI_OFFLINE = '1';

    const modelRuntime = await this.createModelRuntime();
    const sessionManager = this.createSessionManager();
    const restoredContext = sessionManager.buildSessionContext();
    // Pi's createAgentSession only restores the model recorded in a resumed
    // session when no explicit model is supplied. The configured model is a
    // default for new sessions, not an override for a model changed via /model.
    const hasSavedModel = restoredContext.messages.length > 0 && !!restoredContext.model;
    const model = hasSavedModel
      ? undefined
      : this.resolveModel(modelRuntime, params?.model ?? this.options.model);
    const thinkingLevel =
      this.options.thinkingLevel ?? toPiThinkingLevel(params?.effort ?? this.options.effort);
    const settingsManager = SettingsManager.create(
      this.options.workingDirectory,
      this.agentDirPath(),
    );

    const createOptions: CreateAgentSessionOptions = {
      cwd: this.options.workingDirectory,
      agentDir: this.options.agentDir,
      modelRuntime,
      settingsManager,
      sessionManager,
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };

    const result = await createAgentSession(createOptions);
    this.settingsManager = settingsManager;
    this.applyCompactionReserve(result.session);
    this.rememberSessionId(result.session);
    this.updateRuntimeInfo(result.session);
    return result.session;
  }

  private agentDirPath(): string {
    return this.options.agentDir ? resolve(expandTilde(this.options.agentDir)) : getAgentDir();
  }

  /**
   * Pi compacts only once the context passes `contextWindow - reserveTokens`, and
   * in 0.85.1 `reserveTokens` is one fixed number for every model (per-model
   * overrides landed later). On a 258k window the 16384 default means 94%, while a
   * 118k model stops answering around 83% and never reaches its 86% line either. So
   * hold back a share of the window instead — never a smaller share than
   * settings.json already asks for. Re-applied after `/model` switches windows.
   */
  private applyCompactionReserve(session: AgentSession): void {
    const percent = this.options.compactReservePercent ?? 0;
    const contextWindow = session.model?.contextWindow;
    if (!this.settingsManager || !percent || !contextWindow || contextWindow <= 0) return;

    const wanted = Math.floor((contextWindow * percent) / 100);
    const current = this.settingsManager.getCompactionSettings();
    if (wanted <= current.reserveTokens) return;

    this.settingsManager.applyOverrides({ compaction: { reserveTokens: wanted } });
    console.log(
      `[pi] compaction: window=${contextWindow} reserveTokens=${wanted} (${percent}%) trigger=${contextWindow - wanted}`,
    );
  }

  /**
   * Pi 0.85 merged `AuthStorage` + `ModelRegistry` into a single `ModelRuntime`.
   * It resolves credentials and the model catalog from `~/.pi/agent` by default,
   * so we only point it elsewhere when TL_PI_AGENT_DIR is set.
   */
  private async createModelRuntime(): Promise<ModelRuntime> {
    if (!this.options.agentDir) return ModelRuntime.create();
    const agentDir = this.agentDirPath();
    return ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: join(agentDir, 'models.json'),
    });
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
    modelRuntime: ModelRuntime,
    modelPattern: string | undefined,
  ): PiModel | undefined {
    if (!modelPattern) {
      if (!this.options.provider) return undefined;
      const model =
        modelRuntime
          .getAvailableSnapshot()
          .find((candidate) => candidate.provider === this.options.provider) ??
        modelRuntime.getModels().find((candidate) => candidate.provider === this.options.provider);
      if (!model) throw new Error(`Pi provider not found: ${this.options.provider}`);
      return model;
    }
    const trimmed = modelPattern.trim();
    if (!trimmed) return undefined;

    const slash = trimmed.indexOf('/');
    if (slash > 0) {
      const model = modelRuntime.getModel(trimmed.slice(0, slash), trimmed.slice(slash + 1));
      if (!model) throw new Error(`Pi model not found: ${trimmed}`);
      return model;
    }

    if (this.options.provider) {
      const model = modelRuntime.getModel(this.options.provider, trimmed);
      if (!model) throw new Error(`Pi model not found: ${this.options.provider}/${trimmed}`);
      return model;
    }

    const model = modelRuntime
      .getModels()
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

  /**
   * Tears down a turn the bridge no longer has a consumer for. pi's abort() signals
   * synchronously but only settles once the agent goes idle, so the promise is kept and
   * the next turn hands off on it — prompting a still-streaming agent just throws.
   */
  private retireTurnContext(context: PiTurnContext, force = false): void {
    if (context.closed && !force) return;
    if (this.activeTurn && this.activeTurn.token !== context.token) return;
    console.warn('[pi] turn retired: aborting the local run so the session stays usable');
    if (this.activeTurn?.token === context.token) {
      this.activeTurn = null;
      this._isTurnActive = false;
    }
    context.abortController.abort();
    this.closeTurnContext(context);
    if (!this.session) return;
    this.abandonedRun = this.session.abort().catch((err: unknown) => {
      console.warn(
        `[pi] abort did not settle: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private async awaitRunHandoff(session: AgentSession): Promise<void> {
    const pending = this.abandonedRun;
    if (!pending) return;
    this.abandonedRun = undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, TURN_RETIRE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
    if (session.isStreaming) {
      console.warn(
        `[pi] previous run still streaming after ${TURN_RETIRE_TIMEOUT_MS}ms; prompting anyway`,
      );
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

function parsePiModelCommand(prompt: string): { modelPattern?: string } | undefined {
  const trimmed = prompt.trim();
  if (trimmed === '/model') return {};
  const match = /^\/model\s+(.+)$/.exec(trimmed);
  if (!match) return undefined;
  return { modelPattern: match[1].trim() || undefined };
}

function parsePiCompactCommand(prompt: string): { customInstructions?: string } | undefined {
  const trimmed = prompt.trim();
  if (trimmed === '/compact') return {};
  const match = /^\/compact\s+(.+)$/.exec(trimmed);
  if (!match) return undefined;
  return { customInstructions: match[1].trim() || undefined };
}

/**
 * Pi implements these in the interactive TUI, not in `AgentSession.prompt()`, so
 * forwarding them as prompt text hands the model a literal "/compact" instead of
 * running the command. Steering and follow-up would do exactly that, so these
 * names are rejected there. Keep in sync with pi's `core/slash-commands.ts`.
 */
const PI_TUI_ONLY_COMMANDS = new Set([
  'compact',
  'model',
  'settings',
  'scoped-models',
  'export',
  'import',
  'share',
  'copy',
  'name',
  'session',
  'changelog',
  'hotkeys',
  'fork',
  'clone',
  'tree',
  'login',
  'logout',
  'new',
  'resume',
  'reload',
  'quit',
]);

export function piTuiOnlyCommandName(text: string): string | undefined {
  const match = /^\/([a-z0-9_-]+)/i.exec(text.trim());
  if (!match) return undefined;
  const name = match[1].toLowerCase();
  return PI_TUI_ONLY_COMMANDS.has(name) ? name : undefined;
}

export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || getAgentDir();
}

function resolvePiSessionPath(sessionId: string): string {
  return resolve(expandTilde(sessionId));
}
