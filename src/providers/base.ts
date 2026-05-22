import type { CanonicalEvent } from '../canonical/schema.js';
import type { AgentSettingSource } from '../config.js';
import type { EffortLevel } from '../utils/types.js';
import type { AgentProviderKind } from './kinds.js';
import type {
  AskUserQuestionHandler,
  DeferredToolHandler,
  FileAttachment,
  PermissionRequestHandler,
  PermissionTimeoutCallback,
  QueryControls,
  AgentProviderRuntimeMode,
} from './types.js';

export type {
  AskUserQuestionHandler,
  DeferredToolHandler,
  FileAttachment,
  PermissionRequestHandler,
  PermissionTimeoutCallback,
  QueryControls,
};

export type { EffortLevel };
export type { AgentProviderKind };

export interface AgentProviderCapabilities {
  /** Provider runtime shape; do not infer this from native steering flags. */
  runtimeMode: AgentProviderRuntimeMode;
  /** Provider can inject text into a running turn. */
  nativeSteer: boolean;
  /** Provider can enqueue follow-up messages inside its own runtime. */
  nativeQueue: boolean;
  /** Provider exposes per-tool interactive permission callbacks. */
  interactivePermissions: boolean;
  /** Provider exposes AskUserQuestion-style callbacks. */
  askUserQuestion: boolean;
  /** Provider exposes deferred tool callbacks such as EnterPlanMode. */
  deferredTools: boolean;
  /** Provider supports user/project/local setting source selection. */
  settingSources: boolean;
  /** Provider supports resuming a previous SDK/runtime conversation id. */
  sessionResume: boolean;
  /** Provider accepts image attachments as native inputs. */
  imageInputs: boolean;
}

export interface StreamChatParams {
  prompt: string;
  workingDirectory: string;
  model?: string;
  sessionId?: string;
  /** Execution client id selected by the control plane. */
  clientId?: string;
  permissionMode?: 'acceptEdits' | 'plan' | 'default';
  attachments?: FileAttachment[];
  abortSignal?: AbortSignal;
  /** When set, canUseTool forwards permission requests through this handler instead of auto-allowing */
  onPermissionRequest?: PermissionRequestHandler;
  /** Handler for AskUserQuestion tool — returns user's answer */
  onAskUserQuestion?: AskUserQuestionHandler;
  /** Deferred tool handler for EnterPlanMode, EnterWorktree, etc. */
  onDeferredTool?: DeferredToolHandler;
  /** Controls the provider's thinking depth when supported. */
  effort?: EffortLevel;
  /** Provider settings sources for this turn when supported. */
  settingSources?: AgentSettingSource[];
}

export interface CreateSessionParams {
  workingDirectory: string;
  sessionId?: string;
  /** Execution client id selected by the control plane. */
  clientId?: string;
  effort?: EffortLevel;
  model?: string;
  settingSources?: AgentSettingSource[];
  appendSystemPrompt?: string;
}

export interface StreamChatResult {
  stream: ReadableStream<CanonicalEvent>;
  controls?: QueryControls;
}

/** Runtime metadata for the actual provider session currently running. */
export interface AgentRuntimeInfo {
  provider: AgentProviderKind;
  displayName: string;
  model?: string;
  reasoningEffort?: string;
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
 */
export interface LiveSession {
  readonly capabilities?: Pick<AgentProviderCapabilities, 'nativeSteer' | 'nativeQueue'>;
  readonly runtimeInfo?: AgentRuntimeInfo;
  /** Start a new turn (user message → agent response). Returns per-turn event stream. */
  startTurn(prompt: string, params?: TurnParams): StreamChatResult;
  /** Inject text into active turn. No-op if no turn is active. */
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

export interface AgentProvider {
  readonly kind: AgentProviderKind;
  readonly displayName: string;
  readonly capabilities: AgentProviderCapabilities;
  onPermissionTimeout?: PermissionTimeoutCallback;
  createSession(params: CreateSessionParams): LiveSession;
  streamChat(params: StreamChatParams): StreamChatResult;
}
