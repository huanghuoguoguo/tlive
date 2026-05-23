/**
 * ClaudeLiveSession — wraps a long-lived Claude SDK query() with AsyncGenerator prompt.
 *
 * Follows the SDK's recommended "streaming input mode": one query() stays alive
 * across multiple turns. Each startTurn() yields a new user message into the
 * generator; the background consumer routes SDK events to the active turn's stream.
 *
 * The bridge exposes a small turn-oriented control surface:
 *   startTurn() starts a user turn
 *   steerTurn() injects text into the active turn
 *   interruptTurn() interrupts the active turn
 *   close() releases the session
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAdapter } from './claude-adapter.js';
import type { CanonicalEvent } from '../../shared/canonical/schema.js';
import type {
  LiveSession,
  StreamChatResult,
  QueryControls,
  TurnParams,
  PermissionRequestHandler,
  AskUserQuestionHandler,
  DeferredToolHandler,
  AgentRuntimeInfo,
  EffortLevel,
  PermissionTimeoutCallback,
} from '../../shared/providers/base.js';
import type { AgentSettingSource } from '../../shared/config.js';
import { preparePromptWithImages } from './prompt-media.js';
import {
  buildClaudeQueryOptions,
  createClaudeQueryControls,
  routeAskUserQuestionRequest,
  routeDeferredToolRequest,
  routePermissionRequest,
  type ClaudeCanUseToolOptions,
} from './claude-query-options.js';
import { ClaudeEventLogger } from './claude-event-logger.js';

export interface ClaudeLiveSessionOptions {
  workingDirectory: string;
  sessionId?: string;
  cliPath?: string;
  settingSources: AgentSettingSource[];
  onPermissionTimeout?: PermissionTimeoutCallback;
  effort?: EffortLevel;
  model?: string;
  /** Additional system prompt text appended to Claude Code's default prompt */
  appendSystemPrompt?: string;
}

export class ClaudeLiveSession implements LiveSession {
  readonly capabilities = { nativeSteer: true, nativeQueue: true };
  readonly runtimeInfo: AgentRuntimeInfo;

  private _query: ReturnType<typeof query> | null = null;
  private adapter = new ClaudeAdapter();
  private _isAlive = true;
  private _isTurnActive = false;
  private currentTurnController: ReadableStreamDefaultController<CanonicalEvent> | null = null;
  private eventLogger = new ClaudeEventLogger('tlive:session');

  // Message generator coordination
  private messageWaiter: ((msg: string | null) => void) | null = null;
  private messageQueue: string[] = [];

  // Per-turn callback handlers (set by startTurn, read by canUseTool)
  private turnPermissionHandler: PermissionRequestHandler | undefined;
  private turnAskQuestionHandler: AskUserQuestionHandler | undefined;
  private turnDeferredToolHandler: DeferredToolHandler | undefined;

  // Controls extracted from the query object
  private queryControls: QueryControls | null = null;
  private lifecycleCallbacks: { onTurnComplete?: () => void } = {};

  constructor(private options: ClaudeLiveSessionOptions) {
    this.runtimeInfo = {
      provider: 'claude',
      displayName: 'Claude Code',
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { reasoningEffort: options.effort } : {}),
    };
    this.initQuery();
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

  private initQuery(): void {
    const {
      workingDirectory,
      sessionId,
      cliPath,
      settingSources,
      effort,
      model,
      appendSystemPrompt,
    } = this.options;
    const self = this;

    // AsyncGenerator that feeds user messages to the query
    async function* generatePrompt() {
      while (true) {
        const msg = await self.nextMessage();
        if (msg === null) return; // session closed
        yield { type: 'user' as const, message: { role: 'user' as const, content: msg } };
      }
    }

    const queryOptions = buildClaudeQueryOptions({
      cwd: workingDirectory,
      model,
      resume: sessionId,
      effort,
      settingSources,
      appendSystemPrompt,
      cliPath,
      toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
      stderr: (data: string) => {
        const trimmed = data.length > 200 ? data.slice(-200) : data;
        console.log(`[tlive:session] stderr: ${trimmed}`);
      },
      canUseTool: async (
        toolName: string,
        input: Record<string, unknown>,
        cbOptions: ClaudeCanUseToolOptions = {},
      ) => {
        const deferred = await routeDeferredToolRequest(
          toolName,
          input,
          cbOptions,
          self.turnDeferredToolHandler,
        );
        if (deferred) return deferred;

        const answer = await routeAskUserQuestionRequest(
          toolName,
          input,
          cbOptions,
          self.turnAskQuestionHandler,
        );
        if (answer) return answer;

        return routePermissionRequest({
          logPrefix: 'tlive:session',
          toolName,
          input,
          options: cbOptions,
          handler: self.turnPermissionHandler,
          includeBlockedPath: true,
        });
      },
    });

    this._query = query({
      prompt: generatePrompt() as any,
      options: queryOptions as any,
    });

    // Extract controls from the query object
    this.queryControls = createClaudeQueryControls(this._query);

    // Start background consumer
    this.consumeInBackground();
  }

  private async consumeInBackground(): Promise<void> {
    if (!this._query) return;
    try {
      for await (const msg of this._query) {
        if (!this._isAlive) break;
        this.eventLogger.logSdkMessage(msg as { type: string; subtype?: string });

        const events = this.adapter.mapMessage(msg as any);
        this.eventLogger.logMappedEvents(events);
        for (const event of events) {
          if (!this._isAlive) break;
          this.currentTurnController?.enqueue(event);

          // result event = turn boundary
          if (event.kind === 'query_result') {
            this._isTurnActive = false;
            try {
              this.currentTurnController?.close();
            } catch {
              /* already closed */
            }
            this.currentTurnController = null;
            this.lifecycleCallbacks.onTurnComplete?.();
            // Reset adapter state between turns to prevent hiddenToolUseIds leak
            this.adapter.reset();
          }
        }
      }
    } catch (err) {
      this.eventLogger.flush();
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[tlive:session] query ended with error: ${message}`);
      this.adapter.reset();
      // Emit error to active turn if any
      if (this.currentTurnController) {
        try {
          this.currentTurnController.enqueue({ kind: 'error', message } as CanonicalEvent);
          this.currentTurnController.close();
        } catch {
          /* controller may already be closed */
        }
      }
    } finally {
      this.eventLogger.flush();
      this._isAlive = false;
      this._isTurnActive = false;
      this.currentTurnController = null;
    }
  }

  startTurn(prompt: string, params?: TurnParams): StreamChatResult {
    if (!this._isAlive) throw new Error('Session is closed');

    // Guard: close previous turn if still active (shouldn't happen with proper locking)
    if (this._isTurnActive && this.currentTurnController) {
      try {
        this.currentTurnController.close();
      } catch {
        /* already closed */
      }
      this._isTurnActive = false;
      this.currentTurnController = null;
    }

    // Set per-turn handlers (read by canUseTool callback)
    this.turnPermissionHandler = params?.onPermissionRequest;
    this.turnAskQuestionHandler = params?.onAskUserQuestion;
    this.turnDeferredToolHandler = params?.onDeferredTool;

    // Apply per-turn model/effort changes via SDK Query methods
    if (params?.model && this._query) {
      (this._query as any).setModel?.(params.model).catch(() => {});
    }

    // Prepare prompt with images if needed
    const { prompt: finalPrompt } = preparePromptWithImages(prompt, params?.attachments);

    const stream = new ReadableStream<CanonicalEvent>({
      start: (controller) => {
        this.currentTurnController = controller;
        this._isTurnActive = true;
        // Push message to generator → yields to query
        this.pushMessage(finalPrompt);
      },
    });

    return { stream, controls: this.queryControls ?? undefined };
  }

  steerTurn(text: string): void {
    if (!this._isTurnActive || !this._isAlive) return;
    this.pushMessage(text);
  }

  async sendWithPriority(text: string, priority: 'now' | 'next' | 'later'): Promise<void> {
    if (!this._isAlive) return;
    // Use SDK's native send() method with priority
    const q = this._query as any;
    if (q?.send) {
      await q.send({
        type: 'user',
        message: { role: 'user', content: text },
        priority,
      });
    } else {
      // Fallback: use generator pushMessage (no priority support)
      this.pushMessage(text);
    }
  }

  async interruptTurn(): Promise<void> {
    await this.queryControls?.interrupt();
  }

  close(): void {
    this.eventLogger.flush();
    this._isAlive = false;
    this._isTurnActive = false;
    // Signal generator to stop
    if (this.messageWaiter) {
      this.messageWaiter(null);
      this.messageWaiter = null;
    }
    // Close the query process
    try {
      (this._query as any)?.close?.();
    } catch {
      /* ignore */
    }
    // Close any active turn stream
    try {
      this.currentTurnController?.close();
    } catch {
      /* ignore */
    }
    this.currentTurnController = null;
  }

  // ── Message queue helpers ──

  private pushMessage(msg: string): void {
    if (this.messageWaiter) {
      this.messageWaiter(msg);
      this.messageWaiter = null;
    } else {
      this.messageQueue.push(msg);
    }
  }

  private nextMessage(): Promise<string | null> {
    if (this.messageQueue.length > 0) {
      return Promise.resolve(this.messageQueue.shift()!);
    }
    if (!this._isAlive) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      this.messageWaiter = resolve;
    });
  }
}
