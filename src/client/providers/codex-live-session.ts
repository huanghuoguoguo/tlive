import type {
  ModelReasoningEffort,
  SandboxMode,
  WebSearchMode,
  ApprovalMode,
} from '@openai/codex-sdk';
import { CodexAppServerClient, type CodexAppServerNotification } from './codex-app-server.js';
import { CodexAppServerAdapter } from './codex-app-server-adapter.js';
import type { CanonicalEvent } from '../../shared/canonical/schema.js';
import type {
  CreateSessionParams,
  FileAttachment,
  AgentRuntimeInfo,
  LiveSession,
  MessagePriority,
  QueryControls,
  StreamChatResult,
  TurnParams,
} from '../../shared/providers/base.js';
import { preparePromptWithImages } from './prompt-media.js';
import { readCodexContextUsage } from './session-scanner.js';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tliveMcpConfigForCodex } from './tlive-mcp.js';

export interface CodexRuntimeOptions {
  codexPath?: string;
  model?: string;
  sandboxMode?: SandboxMode;
  approvalPolicy?: ApprovalMode;
  skipGitRepoCheck?: boolean;
  modelReasoningEffort?: ModelReasoningEffort;
  networkAccessEnabled?: boolean;
  webSearchMode?: WebSearchMode;
}

export type CodexSessionOptions = CreateSessionParams & CodexRuntimeOptions;

interface CodexTurnContext {
  readonly token: symbol;
  readonly adapter: CodexAppServerAdapter;
  readonly turnReady: Promise<{ threadId: string; turnId: string } | null>;
  readonly resolveTurnReady: (value: { threadId: string; turnId: string } | null) => void;
  turnId?: string;
  controller: ReadableStreamDefaultController<CanonicalEvent> | null;
  closed: boolean;
}

type CodexAppServerInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'localImage'; path: string };

export class CodexLiveSession implements LiveSession {
  readonly capabilities = { nativeSteer: true, nativeQueue: false };
  readonly runtimeInfo: AgentRuntimeInfo;

  private readonly client: CodexAppServerClient;
  private activeTurn: CodexTurnContext | null = null;
  private sessionId: string | undefined;
  private threadPromise: Promise<string> | null = null;
  private lifecycleCallbacks: { onTurnComplete?: () => void } = {};
  private _isAlive = true;
  private _isTurnActive = false;
  private readonly options: CodexSessionOptions;

  constructor(options: CodexSessionOptions) {
    this.options = resolveCodexSessionOptions(options);
    this.runtimeInfo = {
      provider: 'codex',
      displayName: 'Codex',
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.modelReasoningEffort
        ? { reasoningEffort: this.options.modelReasoningEffort }
        : {}),
    };
    this.sessionId = this.options.sessionId;
    this.client = new CodexAppServerClient({
      codexPath: this.options.codexPath,
      workingDirectory: this.options.workingDirectory,
      onNotification: (notification) => this.handleNotification(notification),
      onExit: (error) => this.handleClientExit(error),
    });
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
    if (this.activeTurn) {
      void this.interruptContext(this.activeTurn).catch(() => {});
      this.closeTurnContext(this.activeTurn);
      this.deactivateTurn(this.activeTurn);
    }

    const context = this.createTurnContext();
    const input = this.buildInput(prompt, params?.attachments);

    const controls: QueryControls = {
      interrupt: async () => this.interruptContext(context),
      stopTask: async () => {},
    };

    const stream = new ReadableStream<CanonicalEvent>({
      start: (controller) => {
        context.controller = controller;
        this.activeTurn = context;
        this._isTurnActive = true;
        void this.consumeTurn(input, context);
      },
      cancel: () => {
        void this.interruptContext(context).catch(() => {});
        this.finishTurnContext(context);
      },
    });

    return { stream, controls };
  }

  steerTurn(text: string): void {
    void this.sendWithPriority(text, 'now').catch((error) => {
      console.warn(`[codex-app-server] steer failed: ${errorMessage(error)}`);
    });
  }

  async sendWithPriority(text: string, priority: MessagePriority): Promise<void> {
    if (priority !== 'now') throw new Error('Codex provider does not support native queueing');
    const context = this.activeTurn;
    if (!this._isAlive || !context || context.closed) {
      throw new Error('Codex session has no active turn');
    }
    const ready = await context.turnReady;
    if (!ready || context.closed || this.activeTurn?.token !== context.token) {
      throw new Error('Codex turn completed before it could be steered');
    }
    await this.client.request('turn/steer', {
      threadId: ready.threadId,
      expectedTurnId: ready.turnId,
      input: [textInput(text)],
    });
  }

  async interruptTurn(): Promise<void> {
    const context = this.activeTurn;
    if (context) await this.interruptContext(context);
  }

  close(): void {
    this._isAlive = false;
    const context = this.activeTurn;
    if (context) {
      context.resolveTurnReady(null);
      this.closeTurnContext(context);
      this.deactivateTurn(context);
    }
    this.client.close();
  }

  private async consumeTurn(
    input: CodexAppServerInput[],
    context: CodexTurnContext,
  ): Promise<void> {
    try {
      const threadId = await this.ensureThread();
      if (context.closed) {
        context.resolveTurnReady(null);
        return;
      }
      this.enqueueTurnEvent(context, context.adapter.setSessionId(threadId));
      const response = await this.client.request('turn/start', {
        threadId,
        input,
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.options.modelReasoningEffort ? { effort: this.options.modelReasoningEffort } : {}),
      });
      const turnId = stringField(recordField(response, 'turn'), 'id');
      if (!turnId) throw new Error('Codex app-server did not return a turn id');
      context.turnId = turnId;
      context.resolveTurnReady({ threadId, turnId });
    } catch (err) {
      context.resolveTurnReady(null);
      for (const mapped of context.adapter.mapError(err)) this.enqueueTurnEvent(context, mapped);
      this.finishTurnContext(context);
    }
  }

  private handleNotification(notification: CodexAppServerNotification): void {
    const context = this.activeTurn;
    if (!context || context.closed) return;
    const params = notification.params ?? {};
    const notificationThreadId = stringField(params, 'threadId');
    if (notificationThreadId && this.sessionId && notificationThreadId !== this.sessionId) return;
    const notificationTurnId =
      stringField(params, 'turnId') || stringField(recordField(params, 'turn'), 'id');
    if (notificationTurnId && context.turnId && notificationTurnId !== context.turnId) return;

    if (notification.method === 'turn/started') {
      const turnId = stringField(recordField(params, 'turn'), 'id');
      if (turnId) context.turnId = turnId;
    }

    for (const mapped of context.adapter.mapNotification(notification)) {
      if (mapped.kind === 'query_result') {
        this.enqueueTerminalEvent(context, mapped);
        this.finishTurnContext(context);
      } else {
        this.enqueueTurnEvent(context, mapped);
      }
    }
  }

  private handleClientExit(error: Error): void {
    this._isAlive = false;
    const context = this.activeTurn;
    if (!context || context.closed) return;
    context.resolveTurnReady(null);
    for (const mapped of context.adapter.mapError(error)) this.enqueueTurnEvent(context, mapped);
    this.finishTurnContext(context);
  }

  private async ensureThread(): Promise<string> {
    if (!this.threadPromise) this.threadPromise = this.createOrResumeThread();
    return this.threadPromise;
  }

  private async createOrResumeThread(): Promise<string> {
    const common = this.buildThreadParams();
    const response = this.options.sessionId
      ? await this.client.request('thread/resume', {
          threadId: this.options.sessionId,
          ...common,
        })
      : await this.client.request('thread/start', {
          ...common,
          serviceName: 'tlive',
        });
    const threadId = stringField(recordField(response, 'thread'), 'id');
    if (!threadId) throw new Error('Codex app-server did not return a thread id');
    this.sessionId = threadId;
    return threadId;
  }

  private enqueueTerminalEvent(
    context: CodexTurnContext,
    event: Extract<CanonicalEvent, { kind: 'query_result' }>,
  ): void {
    if (context.closed || event.isError) {
      this.enqueueTurnEvent(context, event);
      return;
    }

    const contextUsage = readCodexContextUsage(event.sessionId);
    if (!contextUsage) {
      this.enqueueTurnEvent(context, event);
      return;
    }

    if (contextUsage.contextWindow !== undefined) {
      this.enqueueTurnEvent(context, {
        kind: 'context_usage',
        tokens: contextUsage.tokens,
        contextWindow: contextUsage.contextWindow,
        percent:
          contextUsage.contextWindow > 0
            ? (contextUsage.tokens / contextUsage.contextWindow) * 100
            : null,
      });
    }
    this.enqueueTurnEvent(context, {
      ...event,
      usage: { ...event.usage, contextTokens: contextUsage.tokens },
    });
  }

  private createTurnContext(): CodexTurnContext {
    let resolveTurnReady!: (value: { threadId: string; turnId: string } | null) => void;
    const turnReady = new Promise<{ threadId: string; turnId: string } | null>((resolve) => {
      resolveTurnReady = resolve;
    });
    return {
      token: Symbol('codex-turn'),
      adapter: new CodexAppServerAdapter({
        sessionId: this.sessionId,
        model: this.runtimeInfo.model,
      }),
      turnReady,
      resolveTurnReady,
      controller: null,
      closed: false,
    };
  }

  private enqueueTurnEvent(context: CodexTurnContext, event: CanonicalEvent): void {
    if (context.closed) return;
    try {
      context.controller?.enqueue(event);
    } catch {
      context.closed = true;
    }
  }

  private finishTurnContext(context: CodexTurnContext): void {
    context.resolveTurnReady(null);
    this.closeTurnContext(context);
    if (this.activeTurn?.token !== context.token) return;

    this.rememberActiveSessionId(context);
    this.deactivateTurn(context);
    this.lifecycleCallbacks.onTurnComplete?.();
  }

  private closeTurnContext(context: CodexTurnContext): void {
    context.closed = true;
    try {
      context.controller?.close();
    } catch {
      /* already closed */
    }
    context.controller = null;
  }

  private deactivateTurn(context: CodexTurnContext): void {
    if (this.activeTurn?.token !== context.token) return;
    this.activeTurn = null;
    this._isTurnActive = false;
  }

  private rememberActiveSessionId(context: CodexTurnContext): void {
    if (this.activeTurn?.token !== context.token) return;
    this.sessionId = context.adapter.currentSessionId ?? this.sessionId;
  }

  private buildInput(prompt: string, attachments?: FileAttachment[]): CodexAppServerInput[] {
    const fullPrompt = this.options.appendSystemPrompt
      ? `${this.options.appendSystemPrompt}\n\n${prompt}`
      : prompt;
    const prepared = preparePromptWithImages(fullPrompt, attachments);
    return [
      textInput(prepared.prompt),
      ...prepared.imagePaths.map((path) => ({ type: 'localImage' as const, path })),
    ];
  }

  private buildThreadParams(): Record<string, unknown> {
    const config: Record<string, unknown> = { ...tliveMcpConfigForCodex() };
    if (this.options.webSearchMode) config.web_search = this.options.webSearchMode;
    if (this.options.networkAccessEnabled !== undefined) {
      config.sandbox_workspace_write = { network_access: this.options.networkAccessEnabled };
    }
    return {
      cwd: this.options.workingDirectory,
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.sandboxMode ? { sandbox: this.options.sandboxMode } : {}),
      ...(this.options.approvalPolicy ? { approvalPolicy: this.options.approvalPolicy } : {}),
      config,
    };
  }

  private async interruptContext(context: CodexTurnContext): Promise<void> {
    const ready = await context.turnReady;
    if (!ready) return;
    await this.client.request('turn/interrupt', {
      threadId: ready.threadId,
      turnId: ready.turnId,
    });
  }
}

function textInput(text: string): CodexAppServerInput {
  return { type: 'text', text, text_elements: [] };
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  return typeof field === 'object' && field !== null && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : {};
}

function stringField(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === 'string' ? value[key] : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resolveCodexSessionOptions(options: CodexSessionOptions): CodexSessionOptions {
  const userDefaults = readCodexUserDefaults();
  return {
    ...options,
    model: options.model ?? userDefaults.model,
    modelReasoningEffort: options.modelReasoningEffort ?? userDefaults.modelReasoningEffort,
  };
}

function readCodexUserDefaults(): Pick<CodexRuntimeOptions, 'model' | 'modelReasoningEffort'> {
  const configPath = join(
    process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'),
    'config.toml',
  );
  if (!existsSync(configPath)) return {};

  try {
    const content = readFileSync(configPath, 'utf8');
    const values = parseTopLevelTomlStrings(content);
    const effort = normalizeCodexEffort(values.model_reasoning_effort);
    return {
      ...(values.model ? { model: values.model } : {}),
      ...(effort ? { modelReasoningEffort: effort } : {}),
    };
  } catch {
    return {};
  }
}

function parseTopLevelTomlStrings(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) break;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    const quoted = /^"((?:\\"|[^"])*)"$/.exec(rawValue);
    values[key] = quoted ? quoted[1].replace(/\\"/g, '"') : rawValue.trim();
  }
  return values;
}

function normalizeCodexEffort(value: string | undefined): ModelReasoningEffort | undefined {
  return value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
    ? value
    : undefined;
}
