import type { BridgeStore } from '../store/interface.js';
import type { ClaudeSettingSource } from '../config.js';
import type { FileAttachment, LLMProvider, PermissionRequestHandler, QueryControls, StreamChatResult, EffortLevel } from '../providers/base.js';
import type { AskUserQuestionHandler } from '../messages/types.js';
import type { TodoStatus } from '../utils/types.js';

const TEXT_MIME_PREFIXES = ['text/', 'application/json', 'application/xml', 'application/javascript', 'application/typescript', 'application/x-yaml', 'application/toml'];

function isTextMime(mime: string): boolean {
  return TEXT_MIME_PREFIXES.some(p => mime.startsWith(p));
}

function buildPromptWithAttachments(text: string, attachments?: FileAttachment[]): string {
  if (!attachments?.length) return text;

  const parts: string[] = [];
  if (text) parts.push(text);

  for (const att of attachments) {
    if (att.type === 'file' && isTextMime(att.mimeType)) {
      const decoded = Buffer.from(att.base64Data, 'base64').toString('utf-8');
      parts.push(`\n[File: ${att.name}]\n\`\`\`\n${decoded}\n\`\`\``);
    } else if (att.type === 'file') {
      parts.push(`\n[Attached file: ${att.name} (${att.mimeType}) — binary file, cannot display inline]`);
    }
    // Images are passed via the attachments array to the LLM provider directly
  }

  return parts.join('\n');
}

interface ProcessMessageParams {
  sdkSessionId?: string;
  workingDirectory: string;
  text: string;
  attachments?: FileAttachment[];
  onTextDelta?: (delta: string) => void;
  onToolStart?: (event: { id: string; name: string; input: Record<string, unknown> }) => void;
  onToolResult?: (event: { toolUseId: string; content: string; isError: boolean }) => void;
  /** Called when query completes — returns Promise to allow async flush of final message */
  onQueryResult?: (event: { sessionId: string; isError: boolean; usage: { inputTokens: number; outputTokens: number; costUsd?: number; modelUsage?: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number }> }; permissionDenials?: Array<{ toolName: string; toolUseId: string }> }) => void | Promise<void>;
  /** Called when SDK returns a sessionId (for resume) — caller should persist it */
  onSdkSessionId?: (id: string) => void | Promise<void>;
  /** Called on error — returns Promise to allow async flush */
  onError?: (error: string) => void | Promise<void>;
  onAgentStart?: (data: { description: string; taskId?: string }) => void;
  onAgentProgress?: (data: { description: string; lastTool?: string; usage?: { toolUses: number; durationMs: number } }) => void;
  onAgentComplete?: (data: { summary: string; status: string }) => void;
  onPromptSuggestion?: (suggestion: string) => void;
  onToolProgress?: (data: { toolName: string; elapsed: number }) => void;
  onRateLimit?: (data: { status: string; utilization?: number; resetsAt?: number }) => void;
  onStatus?: (data: { sessionId: string; model: string }) => void;
  onThinkingDelta?: (delta: string) => void;
  onTodoUpdate?: (todos: Array<{ content: string; status: TodoStatus }>) => void;
  /** Receives query controls (interrupt, stopTask) when available */
  onControls?: (controls: QueryControls) => void;
  /** SDK-level permission handler — forwarded to streamChat */
  sdkPermissionHandler?: PermissionRequestHandler;
  /** SDK-level AskUserQuestion handler — forwarded to streamChat */
  sdkAskQuestionHandler?: AskUserQuestionHandler;
  effort?: EffortLevel;
  /** Override model for this query */
  model?: string;
  /** Claude settings sources for this query */
  settingSources?: ClaudeSettingSource[];
  /** Pre-built stream from LiveSession.startTurn() — skips llm.streamChat() */
  streamResult?: StreamChatResult;
}

interface ProcessMessageResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
}

export class ConversationEngine {
  constructor(
    private store: BridgeStore,
    private llm: LLMProvider,
  ) {}

  async processMessage(params: ProcessMessageParams): Promise<ProcessMessageResult> {
    const lockKey = `session:${params.sdkSessionId || `new-${Date.now()}`}`;
    let fullText = '';
    let usage: { inputTokens: number; outputTokens: number; costUsd?: number } | undefined;

    // 1. Acquire lock
    await this.store.acquireLock(lockKey, 600_000);

    try {
      // 2. Build prompt with file content injected
      const imageAttachments = params.attachments?.filter(a => a.type === 'image');
      const prompt = buildPromptWithAttachments(params.text, params.attachments);

      // 3. Stream LLM response — use pre-built stream from LiveSession or call streamChat
      const result = params.streamResult ?? this.llm.streamChat({
        prompt,
        workingDirectory: params.workingDirectory,
        model: params.model,
        sessionId: params.sdkSessionId,
        attachments: imageAttachments?.length ? imageAttachments : undefined,
        onPermissionRequest: params.sdkPermissionHandler,
        onAskUserQuestion: params.sdkAskQuestionHandler,
        effort: params.effort,
        settingSources: params.settingSources,
      });

      // Expose query controls (interrupt, stopTask) to caller
      if (result.controls) {
        params.onControls?.(result.controls);
      }

      // 4. Consume stream
      const reader = result.stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        switch (value.kind) {
          case 'text_delta':
            fullText += value.text;
            params.onTextDelta?.(value.text);
            break;
          case 'thinking_delta':
            params.onThinkingDelta?.(value.text);
            break;
          case 'tool_start':
            params.onToolStart?.(value);
            break;
          case 'tool_result':
            params.onToolResult?.(value);
            break;
          case 'query_result': {
            usage = value.usage;
            if (value.sessionId && params.onSdkSessionId) {
              await params.onSdkSessionId(value.sessionId);
            }
            // Handle error in query_result (combined event to prevent double flush)
            if (value.isError && value.error && params.onError) {
              await params.onError(value.error);
            } else if (params.onQueryResult) {
              await params.onQueryResult(value);
            }
            break;
          }
          case 'agent_start':
            params.onAgentStart?.(value);
            break;
          case 'agent_progress':
            params.onAgentProgress?.(value);
            break;
          case 'agent_complete':
            params.onAgentComplete?.(value);
            break;
          case 'prompt_suggestion':
            params.onPromptSuggestion?.(value.suggestion);
            break;
          case 'tool_progress':
            params.onToolProgress?.(value);
            break;
          case 'rate_limit':
            params.onRateLimit?.(value);
            break;
          case 'status':
            params.onStatus?.(value);
            break;
          case 'todo_update':
            params.onTodoUpdate?.(value.todos);
            break;
          case 'error':
            if (params.onError) {
              await params.onError(value.message);
            }
            break;
        }
      }
    } finally {
      // 5. Release lock
      await this.store.releaseLock(lockKey);
    }

    return { text: fullText, usage };
  }
}
