import type { EffortLevel } from '../utils/types.js';

/** File attachment for LLM vision/file input */
export interface FileAttachment {
  type: 'image' | 'file';
  name: string;
  mimeType: string;
  base64Data: string;
}

/** Permission request handler — called by canUseTool */
export type PermissionRequestHandler = (
  toolName: string,
  toolInput: Record<string, unknown>,
  promptSentence: string,
  signal?: AbortSignal,
) => Promise<'allow' | 'allow_always' | 'deny'>;

/** AskUserQuestion handler — returns user's answers */
export type AskUserQuestionHandler = (
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect: boolean;
  }>,
  signal?: AbortSignal,
) => Promise<Record<string, string>>;

/** Controls for an active query */
export interface QueryControls {
  interrupt(): Promise<void>;
  stopTask(taskId: string): Promise<void>;
}

/** Session configuration — consolidates scattered per-chat Maps (used in sub-project 2) */
export interface SessionMode {
  permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  model?: string;
  effort?: EffortLevel;
  systemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
}
