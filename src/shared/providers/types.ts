import type { FileAttachment } from '../media/attachments.js';

export type { FileAttachment };

/** Runtime execution shape exposed at the provider capability boundary. */
export type AgentProviderRuntimeMode = 'interactive' | 'turn-based';

/** Permission request handler — called by canUseTool. */
export type PermissionRequestHandler = (
  toolName: string,
  toolInput: Record<string, unknown>,
  promptSentence: string,
  signal?: AbortSignal,
) => Promise<'allow' | 'allow_always' | 'deny'>;

/** AskUserQuestion handler — returns the user's answers. */
export type AskUserQuestionHandler = (
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description?: string; preview?: string }>;
    multiSelect: boolean;
  }>,
  signal?: AbortSignal,
) => Promise<Record<string, string>>;

/** Deferred tool handler — for EnterPlanMode, EnterWorktree, etc. */
export type DeferredToolHandler = (
  toolName: string,
  toolInput: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<{
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}>;

/** Controls for an active query. */
export interface QueryControls {
  interrupt(): Promise<void>;
  stopTask(taskId: string): Promise<void>;
}

/** Called when a provider-side permission request times out. */
export type PermissionTimeoutCallback = (toolName: string, toolUseId: string) => void;
