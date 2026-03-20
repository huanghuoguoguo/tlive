import { getBridgeContext } from '../context.js';
import { parseSSE } from '../providers/sse-utils.js';
import type { SSEEvent, FileAttachment, ToolUseEvent, PermissionRequestEvent, ResultEvent } from '../providers/base.js';

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
  sessionId: string;
  text: string;
  attachments?: FileAttachment[];
  onTextDelta?: (delta: string) => void;
  onToolUse?: (event: ToolUseEvent['data']) => void;
  onPermissionRequest?: (event: PermissionRequestEvent['data']) => Promise<void>;
  onResult?: (event: ResultEvent['data']) => void;
  onError?: (error: string) => void;
}

interface ProcessMessageResult {
  text: string;
  sessionId: string;
  usage?: { input_tokens: number; output_tokens: number; cost_usd?: number };
}

export class ConversationEngine {
  async processMessage(params: ProcessMessageParams): Promise<ProcessMessageResult> {
    const { store, llm } = getBridgeContext();
    const lockKey = `session:${params.sessionId}`;
    let fullText = '';
    let usage: { input_tokens: number; output_tokens: number; cost_usd?: number } | undefined;

    // 1. Acquire lock
    await store.acquireLock(lockKey, 600_000);

    try {
      // 2. Build prompt with file content injected
      const imageAttachments = params.attachments?.filter(a => a.type === 'image');
      const prompt = buildPromptWithAttachments(params.text, params.attachments);

      // 3. Save user message
      await store.saveMessage(params.sessionId, {
        role: 'user',
        content: prompt,
        timestamp: new Date().toISOString(),
      });

      // 4. Get session info
      const session = await store.getSession(params.sessionId);
      const workDir = session?.workingDirectory ?? process.cwd();

      // 5. Stream LLM response (pass images as attachments for vision)
      const stream = llm.streamChat({
        prompt,
        workingDirectory: workDir,
        sessionId: session?.sdkSessionId,
        attachments: imageAttachments?.length ? imageAttachments : undefined,
      });

      // 6. Consume stream
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const event = parseSSE(value);
        if (!event) continue;

        switch (event.type) {
          case 'text':
            fullText += event.data as string;
            params.onTextDelta?.(event.data as string);
            break;
          case 'tool_use':
            params.onToolUse?.(event.data as ToolUseEvent['data']);
            break;
          case 'permission_request':
            await params.onPermissionRequest?.(event.data as PermissionRequestEvent['data']);
            break;
          case 'result': {
            const resultData = event.data as ResultEvent['data'];
            usage = resultData.usage;
            // Save SDK session ID for conversation continuity (resume)
            if (resultData.session_id) {
              const existing = await store.getSession(params.sessionId);
              await store.saveSession({
                id: params.sessionId,
                workingDirectory: existing?.workingDirectory ?? process.cwd(),
                createdAt: existing?.createdAt ?? new Date().toISOString(),
                sdkSessionId: resultData.session_id,
              });
            }
            params.onResult?.(resultData);
            break;
          }
          case 'error':
            params.onError?.(event.data as string);
            break;
        }
      }

      // 7. Save assistant message
      await store.saveMessage(params.sessionId, {
        role: 'assistant',
        content: fullText,
        timestamp: new Date().toISOString(),
      });

    } finally {
      // 8. Release lock
      await store.releaseLock(lockKey);
    }

    return { text: fullText, sessionId: params.sessionId, usage };
  }
}
