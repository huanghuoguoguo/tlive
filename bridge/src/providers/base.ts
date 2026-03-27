/** Called by canUseTool when permission prompting is enabled. */
export type PermissionRequestHandler = (
  toolName: string,
  toolInput: Record<string, unknown>,
  promptSentence: string,
  signal?: AbortSignal,
) => Promise<'allow' | 'allow_always' | 'deny'>;

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

export interface FileAttachment {
  type: 'image' | 'file';
  name: string;
  mimeType: string;
  base64Data: string;
}

/** Controls for an active query — interrupt, stop subagents, etc. */
export interface QueryControls {
  interrupt(): Promise<void>;
  stopTask(taskId: string): Promise<void>;
}

export interface StreamChatResult {
  stream: ReadableStream<string>;
  controls?: QueryControls;
}

export interface LLMProvider {
  streamChat(params: StreamChatParams): StreamChatResult;
}

// SSE event types from Claude SDK / CLI
export interface TextEvent {
  type: 'text';
  data: string;
}

export interface ToolUseEvent {
  type: 'tool_use';
  data: { id: string; name: string; input: unknown };
}

export interface ToolResultEvent {
  type: 'tool_result';
  data: { tool_use_id: string; content: string; is_error: boolean };
}

export interface PermissionRequestEvent {
  type: 'permission_request';
  data: { permissionRequestId: string; toolName: string; toolInput: unknown };
}

export interface ResultEvent {
  type: 'result';
  data: {
    session_id: string;
    is_error: boolean;
    usage?: { input_tokens: number; output_tokens: number; cost_usd?: number };
    permission_denials?: Array<{ tool_name: string; tool_use_id: string; tool_input: Record<string, unknown> }>;
  };
}

export interface ErrorEvent {
  type: 'error';
  data: string;
}

export type SSEEvent = TextEvent | ToolUseEvent | ToolResultEvent | PermissionRequestEvent | ResultEvent | ErrorEvent;
