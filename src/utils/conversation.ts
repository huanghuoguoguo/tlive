import { mkdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { BridgeStore } from '../store/interface.js';
import type { AgentSettingSource } from '../config.js';
import type {
  FileAttachment,
  PermissionRequestHandler,
  QueryControls,
  StreamChatResult,
  EffortLevel,
  AskUserQuestionHandler,
  DeferredToolHandler,
  AgentProvider,
} from '../providers/base.js';
import type { TodoStatus } from './types.js';
import { getTliveHome } from '../core/path.js';

const TEXT_MIME_PREFIXES = [
  'text/',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
  'application/toml',
];
const MIME_BY_EXTENSION: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.xml': 'application/xml',
  '.yaml': 'application/x-yaml',
  '.yml': 'application/x-yaml',
  '.toml': 'application/toml',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.cjs': 'application/javascript',
  '.ts': 'application/typescript',
  '.tsx': 'application/typescript',
  '.jsx': 'application/javascript',
  '.html': 'text/html',
  '.css': 'text/css',
};

/** Maximum file size to decode and inline in prompt (1MB) */
const MAX_INLINE_FILE_SIZE = 1024 * 1024;

function isTextMime(mime: string): boolean {
  return TEXT_MIME_PREFIXES.some((p) => mime.startsWith(p));
}

function effectiveMimeType(att: FileAttachment): string {
  if (att.mimeType && att.mimeType !== 'application/octet-stream') return att.mimeType;
  return (
    MIME_BY_EXTENSION[extname(att.name).toLowerCase()] || att.mimeType || 'application/octet-stream'
  );
}

function safeFileName(name: string): string {
  const trimmed = name.trim() || 'attachment';
  const base = trimmed.replace(/\\/g, '/').split('/').pop() || 'attachment';
  const safe = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return safe.slice(0, 120) || 'attachment';
}

function persistFileAttachment(att: FileAttachment, decodedBuffer: Buffer): string | undefined {
  if (att.localPath) return att.localPath;
  try {
    const day = new Date().toISOString().slice(0, 10);
    const dir = join(getTliveHome(), 'attachments', day);
    mkdirSync(dir, { recursive: true });
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeFileName(att.name)}`;
    const filePath = join(dir, fileName);
    writeFileSync(filePath, decodedBuffer);
    return filePath;
  } catch {
    return undefined;
  }
}

export function preparePromptWithFileAttachments(
  text: string,
  attachments?: FileAttachment[],
): string {
  if (!attachments?.length) return text;

  const parts: string[] = [];
  if (text) parts.push(text);

  for (const att of attachments) {
    if (att.type !== 'file') continue;

    const decodedBuffer = Buffer.from(att.base64Data, 'base64');
    const mimeType = effectiveMimeType(att);
    const localPath = persistFileAttachment(att, decodedBuffer);
    const pathLine = localPath ? `\nPath: \`${localPath}\`` : '';

    if (isTextMime(mimeType)) {
      if (decodedBuffer.length > MAX_INLINE_FILE_SIZE) {
        parts.push(
          `\n[File: ${att.name} (${mimeType}) — ${Math.round(decodedBuffer.length / 1024)}KB, too large to inline]${pathLine}`,
        );
      } else {
        const decoded = decodedBuffer.toString('utf-8');
        parts.push(`\n[File: ${att.name} (${mimeType})]${pathLine}\n\`\`\`\n${decoded}\n\`\`\``);
      }
    } else {
      parts.push(`\n[Attached file: ${att.name} (${mimeType}) — saved for agent to inspect]${pathLine}`);
    }
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
  onToolResult?: (event: {
    toolUseId: string;
    content: string;
    isError: boolean;
    isFinal?: boolean;
  }) => void;
  /** Called when query completes — returns Promise to allow async flush of final message */
  onQueryResult?: (event: {
    sessionId: string;
    isError: boolean;
    usage: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      reasoningOutputTokens?: number;
      costUsd?: number;
      modelUsage?: Record<
        string,
        {
          inputTokens: number;
          outputTokens: number;
          cacheReadInputTokens?: number;
          cacheCreationInputTokens?: number;
          costUSD?: number;
        }
      >;
    };
    permissionDenials?: Array<{ toolName: string; toolUseId: string }>;
  }) => void | Promise<void>;
  /** Called when SDK returns a sessionId (for resume) — caller should persist it */
  onSdkSessionId?: (id: string) => void | Promise<void>;
  /** Called on error — returns Promise to allow async flush */
  onError?: (error: string) => void | Promise<void>;
  onAgentStart?: (data: { description: string; taskId?: string }) => void;
  onAgentProgress?: (data: {
    description: string;
    lastTool?: string;
    usage?: { toolUses: number; durationMs: number };
  }) => void;
  onAgentComplete?: (data: { summary: string; status: string }) => void;
  onPromptSuggestion?: (suggestion: string) => void;
  onToolProgress?: (data: { toolName: string; elapsed: number }) => void;
  onRateLimit?: (data: { status: string; utilization?: number; resetsAt?: number }) => void;
  onStatus?: (data: { sessionId: string; model?: string }) => void;
  onSessionInfo?: (data: {
    sessionId: string;
    model: string;
    tools?: string[];
    mcpServers?: Array<{ name: string; status: string }>;
    skills?: string[];
  }) => void;
  onToolUseSummary?: (summary: string) => void;
  onApiRetry?: (data: {
    attempt: number;
    maxRetries: number;
    retryDelayMs: number;
    error?: string;
  }) => void;
  onCompactBoundary?: (data: { trigger: 'manual' | 'auto'; preTokens?: number }) => void;
  onThinkingDelta?: (delta: string) => void;
  onTodoUpdate?: (todos: Array<{ content: string; status: TodoStatus }>) => void;
  /** Provider selected for this logical turn. */
  provider: AgentProvider;
  /** Receives query controls (interrupt, stopTask) when available */
  onControls?: (controls: QueryControls) => void;
  /** SDK-level permission handler — forwarded to streamChat */
  sdkPermissionHandler?: PermissionRequestHandler;
  /** SDK-level AskUserQuestion handler — forwarded to streamChat */
  sdkAskQuestionHandler?: AskUserQuestionHandler;
  /** SDK-level deferred tool handler — forwarded to streamChat */
  sdkDeferredToolHandler?: DeferredToolHandler;
  effort?: EffortLevel;
  /** Override model for this query */
  model?: string;
  /** Provider settings sources for this query. */
  settingSources?: AgentSettingSource[];
  /** Pre-built stream from LiveSession.startTurn() — skips llm.streamChat() */
  streamResult?: StreamChatResult;
}

interface ProcessMessageResult {
  text: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    reasoningOutputTokens?: number;
    costUsd?: number;
  };
}

export class ConversationEngine {
  constructor(private store: BridgeStore) {}

  async processMessage(params: ProcessMessageParams): Promise<ProcessMessageResult> {
    const lockKey = `session:${params.sdkSessionId || `new-${Date.now()}`}`;
    let fullText = '';
    let usage: ProcessMessageResult['usage'];

    // 1. Acquire lock
    await this.store.acquireLock(lockKey, 600_000);

    try {
      // 2. Build prompt with file content injected
      const imageAttachments = params.attachments?.filter((a) => a.type === 'image');
      const prompt = preparePromptWithFileAttachments(params.text, params.attachments);

      // 3. Stream LLM response — use pre-built stream from LiveSession or call streamChat
      const result =
        params.streamResult ??
        params.provider.streamChat({
          prompt,
          workingDirectory: params.workingDirectory,
          model: params.model,
          sessionId: params.sdkSessionId,
          attachments: imageAttachments?.length ? imageAttachments : undefined,
          onPermissionRequest: params.sdkPermissionHandler,
          onAskUserQuestion: params.sdkAskQuestionHandler,
          onDeferredTool: params.sdkDeferredToolHandler,
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
          case 'session_info':
            params.onSessionInfo?.(value);
            break;
          case 'tool_use_summary':
            params.onToolUseSummary?.(value.summary);
            break;
          case 'api_retry':
            params.onApiRetry?.(value);
            break;
          case 'compact_boundary':
            params.onCompactBoundary?.(value);
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
