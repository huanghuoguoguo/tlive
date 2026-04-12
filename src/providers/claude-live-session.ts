/**
 * ClaudeLiveSession — wraps a long-lived Claude SDK query() with AsyncGenerator prompt.
 *
 * Follows the SDK's recommended "streaming input mode": one query() stays alive
 * across multiple turns. Each startTurn() yields a new user message into the
 * generator; the background consumer routes SDK events to the active turn's stream.
 *
 * Aligned with Codex's Thread/Turn/Steer model:
 *   startTurn() ≈ turn/start
 *   steerTurn() ≈ turn/steer
 *   interruptTurn() ≈ turn/interrupt
 *   close() ≈ thread unsubscribe
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAdapter } from '../messages/claude-adapter.js';
import type { CanonicalEvent } from '../messages/schema.js';
import type {
  LiveSession, StreamChatResult, QueryControls, TurnParams,
  PermissionRequestHandler, AskUserQuestionHandler, EffortLevel,
} from './base.js';
import type { ClaudeSettingSource } from '../config.js';
import type { PermissionTimeoutCallback } from './claude-shared.js';
import { buildSubprocessEnv, preparePromptWithImages, SAFE_PERMISSIONS } from './claude-shared.js';
const DEBUG_EVENTS = process.env.TL_DEBUG_EVENTS === '1';

export interface ClaudeLiveSessionOptions {
  workingDirectory: string;
  sessionId?: string;
  cliPath?: string;
  settingSources: ClaudeSettingSource[];
  onPermissionTimeout?: PermissionTimeoutCallback;
  effort?: EffortLevel;
  model?: string;
  /** Additional system prompt text appended to Claude Code's default prompt */
  appendSystemPrompt?: string;
}

export class ClaudeLiveSession implements LiveSession {
  private _query: ReturnType<typeof query> | null = null;
  private adapter = new ClaudeAdapter();
  private _isAlive = true;
  private _isTurnActive = false;
  private currentTurnController: ReadableStreamDefaultController<CanonicalEvent> | null = null;
  private pendingStreamEventCount = 0;
  private pendingStreamEventSubtypes = new Map<string, number>();

  // Message generator coordination
  private messageWaiter: ((msg: string | null) => void) | null = null;
  private messageQueue: string[] = [];

  // Per-turn callback handlers (set by startTurn, read by canUseTool)
  private turnPermissionHandler: PermissionRequestHandler | undefined;
  private turnAskQuestionHandler: AskUserQuestionHandler | undefined;

  // Controls extracted from the query object
  private queryControls: QueryControls | null = null;
  private lifecycleCallbacks: { onTurnComplete?: () => void } = {};

  constructor(private options: ClaudeLiveSessionOptions) {
    this.initQuery();
  }

  get isAlive(): boolean { return this._isAlive; }
  get isTurnActive(): boolean { return this._isTurnActive; }

  setLifecycleCallbacks(callbacks: { onTurnComplete?: () => void }): void {
    this.lifecycleCallbacks = callbacks;
  }

  private initQuery(): void {
    const { workingDirectory, sessionId, cliPath, settingSources, effort, model, appendSystemPrompt } = this.options;
    const self = this;

    // AsyncGenerator that feeds user messages to the query
    async function* generatePrompt() {
      while (true) {
        const msg = await self.nextMessage();
        if (msg === null) return; // session closed
        yield { type: 'user' as const, message: { role: 'user' as const, content: msg } };
      }
    }

    const queryOptions: Record<string, unknown> = {
      cwd: workingDirectory,
      model: model || undefined,
      resume: sessionId || undefined,
      effort: effort || undefined,
      // Required for stream_event partials, including thinking/text deltas.
      includePartialMessages: true,
      // Enable hook lifecycle events (hook_started, hook_progress, hook_response)
      includeHookEvents: true,
      agentProgressSummaries: true,
      promptSuggestions: true,
      toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
      settingSources,
      settings: { permissions: { allow: SAFE_PERMISSIONS } },
      env: buildSubprocessEnv(),
      ...(appendSystemPrompt ? {
        systemPrompt: { type: 'preset', preset: 'claude_code', append: appendSystemPrompt },
      } : {}),
      stderr: (data: string) => {
        const trimmed = data.length > 200 ? data.slice(-200) : data;
        console.log(`[tlive:session] stderr: ${trimmed}`);
      },
      canUseTool: async (
        toolName: string,
        input: Record<string, unknown>,
        cbOptions: { decisionReason?: string; title?: string; suggestions?: unknown[]; signal?: AbortSignal; blockedPath?: string; toolUseID?: string; agentID?: string } = {},
      ): Promise<PermissionResult> => {
        // AskUserQuestion — route to per-turn handler
        if (toolName === 'AskUserQuestion' && self.turnAskQuestionHandler) {
          const questions = (input as Record<string, unknown>).questions as Array<{
            question: string; header: string;
            options: Array<{ label: string; description?: string; preview?: string }>;
            multiSelect: boolean;
          }> ?? [];
          if (questions.length > 0) {
            try {
              const answers = await self.turnAskQuestionHandler(questions);
              return { behavior: 'allow' as const, updatedInput: { questions: (input as Record<string, unknown>).questions, answers } };
            } catch {
              return { behavior: 'deny' as const, message: 'User did not answer' };
            }
          }
        }
        // Permission handler — route to per-turn handler
        if (!self.turnPermissionHandler) {
          return { behavior: 'allow' as const, updatedInput: input };
        }
        const reason = cbOptions.blockedPath
          ? `${cbOptions.decisionReason || toolName} (${cbOptions.blockedPath})`
          : (cbOptions.decisionReason || cbOptions.title || toolName);
        console.log(`[tlive:session] canUseTool: ${toolName} → asking user (${reason})`);
        const decision = await self.turnPermissionHandler(toolName, input, reason);
        if (decision === 'allow') {
          return { behavior: 'allow' as const, updatedInput: input, toolUseID: cbOptions.toolUseID };
        }
        if (decision === 'allow_always') {
          return {
            behavior: 'allow' as const, updatedInput: input, toolUseID: cbOptions.toolUseID,
            ...(cbOptions.suggestions ? { updatedPermissions: cbOptions.suggestions } : {}),
          } as PermissionResult;
        }
        return { behavior: 'deny' as const, message: 'Denied by user via IM', toolUseID: cbOptions.toolUseID };
      },
    };

    if (cliPath) {
      queryOptions.pathToClaudeCodeExecutable = cliPath;
    }

    this._query = query({
      prompt: generatePrompt() as any,
      options: queryOptions as any,
    });

    // Extract controls from the query object
    const q = this._query;
    this.queryControls = {
      interrupt: async () => { await (q as any).interrupt?.(); },
      stopTask: async (taskId: string) => { await (q as any).stopTask?.(taskId); },
    };

    // Start background consumer
    this.consumeInBackground();
  }

  private async consumeInBackground(): Promise<void> {
    if (!this._query) return;
    try {
      for await (const msg of this._query) {
        if (!this._isAlive) break;
        this.logSdkMessage(msg as { type: string; subtype?: string });

        const events = this.adapter.mapMessage(msg as any);
        if (DEBUG_EVENTS && events.length > 0) {
          const summary = events.map((event) => {
            switch (event.kind) {
              case 'thinking_delta':
              case 'text_delta':
                return `${event.kind}:${event.text.length}`;
              case 'tool_start':
                return `tool_start:${event.name}`;
              case 'tool_result':
                return `tool_result:${event.toolUseId}:${event.content.length}`;
              case 'agent_start':
              case 'agent_progress':
                return `${event.kind}:${event.description}`;
              case 'agent_complete':
                return `agent_complete:${event.status}`;
              default:
                return event.kind;
            }
          }).join(', ');
          console.log(`[tlive:session] mapped events: ${summary}`);
        }
        for (const event of events) {
          if (!this._isAlive) break;
          this.currentTurnController?.enqueue(event);

          // result event = turn boundary
          if (event.kind === 'query_result') {
            this._isTurnActive = false;
            try {
              this.currentTurnController?.close();
            } catch { /* already closed */ }
            this.currentTurnController = null;
            this.lifecycleCallbacks.onTurnComplete?.();
            // Reset adapter state between turns to prevent hiddenToolUseIds leak
            this.adapter.reset();
          }
        }
      }
    } catch (err) {
      this.flushPendingStreamEventLog();
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[tlive:session] query ended with error: ${message}`);
      this.adapter.reset();
      // Emit error to active turn if any
      if (this.currentTurnController) {
        try {
          this.currentTurnController.enqueue({ kind: 'error', message } as CanonicalEvent);
          this.currentTurnController.close();
        } catch { /* controller may already be closed */ }
      }
    } finally {
      this.flushPendingStreamEventLog();
      this._isAlive = false;
      this._isTurnActive = false;
      this.currentTurnController = null;
    }
  }

  startTurn(prompt: string, params?: TurnParams): StreamChatResult {
    if (!this._isAlive) throw new Error('Session is closed');

    // Guard: close previous turn if still active (shouldn't happen with proper locking)
    if (this._isTurnActive && this.currentTurnController) {
      try { this.currentTurnController.close(); } catch { /* already closed */ }
      this._isTurnActive = false;
      this.currentTurnController = null;
    }

    // Set per-turn handlers (read by canUseTool callback)
    this.turnPermissionHandler = params?.onPermissionRequest;
    this.turnAskQuestionHandler = params?.onAskUserQuestion;

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
        parent_tool_use_id: null,
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
    this.flushPendingStreamEventLog();
    this._isAlive = false;
    this._isTurnActive = false;
    // Signal generator to stop
    if (this.messageWaiter) {
      this.messageWaiter(null);
      this.messageWaiter = null;
    }
    // Close the query process
    try { (this._query as any)?.close?.(); } catch { /* ignore */ }
    // Close any active turn stream
    try { this.currentTurnController?.close(); } catch { /* ignore */ }
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
    return new Promise(resolve => { this.messageWaiter = resolve; });
  }

  private logSdkMessage(msg: { type: string; subtype?: string }): void {
    const subtype = msg.subtype ? `.${msg.subtype}` : '';
    if (msg.type === 'stream_event') {
      this.pendingStreamEventCount++;
      const key = subtype;
      this.pendingStreamEventSubtypes.set(key, (this.pendingStreamEventSubtypes.get(key) ?? 0) + 1);
      return;
    }
    this.flushPendingStreamEventLog();
    console.log(`[tlive:session] msg: ${msg.type}${subtype}`);
  }

  private flushPendingStreamEventLog(): void {
    if (this.pendingStreamEventCount === 0) {
      return;
    }
    const subtypeSummary = [...this.pendingStreamEventSubtypes.entries()]
      .filter(([_, count]) => count > 0)
      .map(([subtype, count]) => subtype ? `${subtype}×${count}` : `plain×${count}`)
      .join(', ');
    const suffix = subtypeSummary && this.pendingStreamEventSubtypes.size > 1
      ? ` (${subtypeSummary})`
      : '';
    console.log(`[tlive:session] msg: stream_event ×${this.pendingStreamEventCount}${suffix}`);
    this.pendingStreamEventCount = 0;
    this.pendingStreamEventSubtypes.clear();
  }
}
