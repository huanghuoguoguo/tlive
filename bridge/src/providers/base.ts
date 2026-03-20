export interface StreamChatParams {
  prompt: string;
  workingDirectory: string;
  model?: string;
  sessionId?: string;
  permissionMode?: 'acceptEdits' | 'plan' | 'default';
  attachments?: FileAttachment[];
  abortSignal?: AbortSignal;
}

export interface FileAttachment {
  type: 'image' | 'file';
  name: string;
  mimeType: string;
  base64Data: string;
}

export interface LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string>;
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
  data: { session_id: string; is_error: boolean; usage?: { input_tokens: number; output_tokens: number; cost_usd?: number } };
}

export interface ErrorEvent {
  type: 'error';
  data: string;
}

export type SSEEvent = TextEvent | ToolUseEvent | ToolResultEvent | PermissionRequestEvent | ResultEvent | ErrorEvent;
