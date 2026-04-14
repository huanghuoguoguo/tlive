import type { CanonicalEvent } from '../messages/schema.js';
import type { FileAttachment, PermissionRequestHandler, QueryControls } from '../messages/types.js';
import type { ClaudeSettingSource } from '../config.js';
import type { EffortLevel } from '../utils/types.js';

export type { FileAttachment, PermissionRequestHandler, QueryControls };

export type { EffortLevel };

/** AskUserQuestion handler type (with preview support) */
export type AskUserQuestionHandler = (
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description?: string; preview?: string }>;
    multiSelect: boolean;
  }>,
  signal?: AbortSignal,
) => Promise<Record<string, string>>;

/** Deferred tool handler type — for EnterPlanMode, EnterWorktree, etc. */
export type DeferredToolHandler = (
  toolName: string,
  toolInput: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<{ behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; message?: string }>;

export interface StreamChatParams {
  prompt: string;
  workingDirectory: string;
  model?: string;
  sessionId?: string;
  permissionMode?: 'acceptEdits' | 'plan' | 'default';
  attachments?: FileAttachment[];
  abortSignal?: AbortSignal;
  /** When set, canUseTool forwards permission requests through this handler instead of auto-allowing */
  onPermissionRequest?: PermissionRequestHandler;
  /** Handler for AskUserQuestion tool — returns user's answer */
  onAskUserQuestion?: AskUserQuestionHandler;
  /** Controls Claude's thinking depth */
  effort?: EffortLevel;
  /** Claude Code settings sources for this turn */
  settingSources?: ClaudeSettingSource[];
}

export interface StreamChatResult {
  stream: ReadableStream<CanonicalEvent>;
  controls?: QueryControls;
}

/** Parameters for starting a turn within a LiveSession */
export interface TurnParams {
  attachments?: FileAttachment[];
  /** Permission handler for this turn */
  onPermissionRequest?: PermissionRequestHandler;
  /** AskUserQuestion handler for this turn */
  onAskUserQuestion?: AskUserQuestionHandler;
  /** Deferred tool handler for EnterPlanMode, EnterWorktree, etc. */
  onDeferredTool?: DeferredToolHandler;
  effort?: EffortLevel;
  model?: string;
}

/** Message priority for SDK native queue */
export type MessagePriority = 'now' | 'next' | 'later';

/**
 * Long-lived session wrapping a persistent query/thread.
 * Follows Claude SDK's AsyncGenerator prompt model: one query() stays alive
 * across multiple turns. Each startTurn() yields a new user message into the generator.
 */
export interface LiveSession {
  /** Start a new turn (user message → agent response). Returns per-turn event stream. */
  startTurn(prompt: string, params?: TurnParams): StreamChatResult;
  /** Inject text into active turn — like Codex turn/steer. No-op if no turn is active. */
  steerTurn(text: string): void;
  /** Send message with SDK native priority. 'now' = steer, 'later' = queue. */
  sendWithPriority(text: string, priority: MessagePriority): Promise<void>;
  /** Interrupt the active turn */
  interruptTurn(): Promise<void>;
  /** Close session and release all resources */
  close(): void;
  /** Optional lifecycle hooks used by bridge-side session governance. */
  setLifecycleCallbacks?(callbacks: { onTurnComplete?: () => void }): void;
  /** Whether the underlying query/thread is still alive */
  readonly isAlive: boolean;
  /** Whether a turn is currently in progress */
  readonly isTurnActive: boolean;
}
