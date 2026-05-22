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
import type { CanonicalEvent } from '../canonical/schema.js';
import type {
  CreateSessionParams,
  FileAttachment,
  AgentRuntimeInfo,
  LiveSession,
  MessagePriority,
  QueryControls,
  StreamChatResult,
  TurnParams,
} from './base.js';
import { preparePromptWithImages } from './prompt-media.js';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

export class CodexLiveSession implements LiveSession {
  readonly capabilities = { nativeSteer: false, nativeQueue: false };
  readonly runtimeInfo: AgentRuntimeInfo;

  private readonly codex: Codex;
  private readonly thread: Thread;
  private readonly adapter: CodexAdapter;
  private currentAbortController: AbortController | null = null;
  private currentTurnController: ReadableStreamDefaultController<CanonicalEvent> | null = null;
  private lifecycleCallbacks: { onTurnComplete?: () => void } = {};
  private _isAlive = true;
  private _isTurnActive = false;
  private readonly options: CodexSessionOptions;

  constructor(options: CodexSessionOptions) {
    this.options = resolveCodexSessionOptions(options);
    this.codex = new Codex({
      ...(this.options.codexPath ? { codexPathOverride: this.options.codexPath } : {}),
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
    this.adapter = new CodexAdapter({
      sessionId: this.options.sessionId,
      model: threadOptions.model,
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
    if (this._isTurnActive) {
      this.currentAbortController?.abort();
      this.closeCurrentTurn();
    }

    const abortController = new AbortController();
    this.currentAbortController = abortController;
    const input = this.buildInput(prompt, params?.attachments);

    const controls: QueryControls = {
      interrupt: async () => {
        abortController.abort();
      },
      stopTask: async () => {},
    };

    const stream = new ReadableStream<CanonicalEvent>({
      start: (controller) => {
        this.currentTurnController = controller;
        this._isTurnActive = true;
        void this.consumeTurn(input, abortController);
      },
      cancel: () => {
        abortController.abort();
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
    this.currentAbortController?.abort();
  }

  close(): void {
    this._isAlive = false;
    this.currentAbortController?.abort();
    this.closeCurrentTurn();
  }

  private async consumeTurn(input: Input, abortController: AbortController): Promise<void> {
    try {
      const { events } = await this.thread.runStreamed(input, {
        signal: abortController.signal,
      });
      for await (const event of events) {
        for (const mapped of this.adapter.mapEvent(event)) {
          this.currentTurnController?.enqueue(mapped);
        }
      }
    } catch (err) {
      for (const mapped of this.adapter.mapError(err, abortController.signal.aborted)) {
        this.currentTurnController?.enqueue(mapped);
      }
    } finally {
      this.adapter.reset();
      this.closeCurrentTurn();
      this.lifecycleCallbacks.onTurnComplete?.();
    }
  }

  private closeCurrentTurn(): void {
    this._isTurnActive = false;
    this.currentAbortController = null;
    try {
      this.currentTurnController?.close();
    } catch {
      /* already closed */
    }
    this.currentTurnController = null;
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
  const configPath = join(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'config.toml');
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
