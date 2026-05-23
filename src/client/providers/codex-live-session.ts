import type {
  Input,
  ModelReasoningEffort,
  SandboxMode,
  Thread,
  ThreadOptions,
  WebSearchMode,
  ApprovalMode,
} from '@openai/codex-sdk';
import { Codex } from '@openai/codex-sdk';
import { CodexAdapter } from './codex-adapter.js';
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
  readonly abortController: AbortController;
  readonly adapter: CodexAdapter;
  controller: ReadableStreamDefaultController<CanonicalEvent> | null;
  closed: boolean;
}

export class CodexLiveSession implements LiveSession {
  readonly capabilities = { nativeSteer: false, nativeQueue: false };
  readonly runtimeInfo: AgentRuntimeInfo;

  private readonly codex: Codex;
  private readonly thread: Thread;
  private activeTurn: CodexTurnContext | null = null;
  private sessionId: string | undefined;
  private lifecycleCallbacks: { onTurnComplete?: () => void } = {};
  private _isAlive = true;
  private _isTurnActive = false;
  private readonly options: CodexSessionOptions;

  constructor(options: CodexSessionOptions) {
    this.options = resolveCodexSessionOptions(options);
    this.codex = new Codex({
      ...(this.options.codexPath ? { codexPathOverride: this.options.codexPath } : {}),
      config: tliveMcpConfigForCodex(),
    });
    const threadOptions = this.buildThreadOptions(this.options);
    this.runtimeInfo = {
      provider: 'codex',
      displayName: 'Codex',
      ...(threadOptions.model ? { model: threadOptions.model } : {}),
      ...(threadOptions.modelReasoningEffort
        ? { reasoningEffort: threadOptions.modelReasoningEffort }
        : {}),
    };
    this.thread = this.options.sessionId
      ? this.codex.resumeThread(this.options.sessionId, threadOptions)
      : this.codex.startThread(threadOptions);
    this.sessionId = this.options.sessionId;
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
      this.activeTurn.abortController.abort();
      this.closeTurnContext(this.activeTurn);
      this.deactivateTurn(this.activeTurn);
    }

    const context = this.createTurnContext();
    const input = this.buildInput(prompt, params?.attachments);

    const controls: QueryControls = {
      interrupt: async () => {
        context.abortController.abort();
      },
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
        context.abortController.abort();
        context.closed = true;
      },
    });

    return { stream, controls };
  }

  steerTurn(_text: string): void {
    // Codex SDK runs one prompt per spawned exec process; it has no active-turn steer API.
  }

  async sendWithPriority(_text: string, _priority: MessagePriority): Promise<void> {
    throw new Error('Codex provider does not support native steer or queue');
  }

  async interruptTurn(): Promise<void> {
    this.activeTurn?.abortController.abort();
  }

  close(): void {
    this._isAlive = false;
    if (!this.activeTurn) return;
    this.activeTurn.abortController.abort();
    this.closeTurnContext(this.activeTurn);
    this.deactivateTurn(this.activeTurn);
  }

  private async consumeTurn(input: Input, context: CodexTurnContext): Promise<void> {
    try {
      const { events } = await this.thread.runStreamed(input, {
        signal: context.abortController.signal,
      });
      for await (const event of events) {
        for (const mapped of context.adapter.mapEvent(event)) {
          this.enqueueTurnEvent(context, mapped);
        }
        this.rememberActiveSessionId(context);
      }
    } catch (err) {
      for (const mapped of context.adapter.mapError(err, context.abortController.signal.aborted)) {
        this.enqueueTurnEvent(context, mapped);
      }
    } finally {
      this.finishTurnContext(context);
    }
  }

  private createTurnContext(): CodexTurnContext {
    return {
      token: Symbol('codex-turn'),
      abortController: new AbortController(),
      adapter: new CodexAdapter({
        sessionId: this.thread.id ?? this.sessionId,
        model: this.runtimeInfo.model,
      }),
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
    this.sessionId = context.adapter.sessionId ?? this.sessionId;
  }

  private buildInput(prompt: string, attachments?: FileAttachment[]): Input {
    const fullPrompt = this.options.appendSystemPrompt
      ? `${this.options.appendSystemPrompt}\n\n${prompt}`
      : prompt;
    const prepared = preparePromptWithImages(fullPrompt, attachments);
    if (!prepared.imagePaths.length) return prepared.prompt;
    return [
      { type: 'text', text: prepared.prompt },
      ...prepared.imagePaths.map((path) => ({ type: 'local_image' as const, path })),
    ];
  }

  private buildThreadOptions(options: CodexSessionOptions): ThreadOptions {
    return {
      workingDirectory: options.workingDirectory,
      ...(options.model ? { model: options.model } : {}),
      ...(options.sandboxMode ? { sandboxMode: options.sandboxMode } : {}),
      ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
      ...(options.skipGitRepoCheck !== undefined
        ? { skipGitRepoCheck: options.skipGitRepoCheck }
        : {}),
      ...(options.modelReasoningEffort
        ? { modelReasoningEffort: options.modelReasoningEffort }
        : {}),
      ...(options.networkAccessEnabled !== undefined
        ? { networkAccessEnabled: options.networkAccessEnabled }
        : {}),
      ...(options.webSearchMode ? { webSearchMode: options.webSearchMode } : {}),
    };
  }
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
