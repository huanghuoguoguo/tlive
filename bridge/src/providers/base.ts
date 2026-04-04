import type { CanonicalEvent } from '../messages/schema.js';
import type { FileAttachment, PermissionRequestHandler, QueryControls } from '../messages/types.js';

export type { FileAttachment, PermissionRequestHandler, QueryControls };

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
  onAskUserQuestion?: (
    questions: Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect: boolean;
    }>,
    signal?: AbortSignal,
  ) => Promise<Record<string, string>>;
  /** Controls Claude's thinking depth: low/medium/high/max */
  effort?: 'low' | 'medium' | 'high' | 'max';
}

export interface StreamChatResult {
  stream: ReadableStream<CanonicalEvent>;
  controls?: QueryControls;
}

export interface LLMProvider {
  streamChat(params: StreamChatParams): StreamChatResult;
}
