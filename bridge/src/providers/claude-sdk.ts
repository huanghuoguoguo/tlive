/**
 * LLM Provider using @anthropic-ai/claude-agent-sdk query() function.
 * Based on Claude-to-IM-skill's implementation.
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, PermissionResult, SDKPermissionDenial } from '@anthropic-ai/claude-agent-sdk';
import { sseEvent } from './sse-utils.js';
import type { LLMProvider, StreamChatParams, StreamChatResult, QueryControls } from './base.js';
import type { PendingPermissions } from '../permissions/gateway.js';

// ── Auth error classification ──

const CLI_AUTH_PATTERNS = [/not logged in/i, /please run \/login/i];
const API_AUTH_PATTERNS = [/unauthorized/i, /invalid.*api.?key/i, /401\b/];

function classifyAuthError(text: string): 'cli' | 'api' | false {
  if (CLI_AUTH_PATTERNS.some(re => re.test(text))) return 'cli';
  if (API_AUTH_PATTERNS.some(re => re.test(text))) return 'api';
  return false;
}

// ── Environment isolation ──

const ENV_ALWAYS_STRIP = ['CLAUDECODE'];

function buildSubprocessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (ENV_ALWAYS_STRIP.some(prefix => k.startsWith(prefix))) continue;
    out[k] = v;
  }
  return out;
}

// ── CLI discovery and version check ──

function findClaudeCli(): string | undefined {
  // Check CTI_CLAUDE_CODE_EXECUTABLE env var first
  const fromEnv = process.env.CTI_CLAUDE_CODE_EXECUTABLE;
  if (fromEnv) return fromEnv;

  // Try `which claude`
  try {
    return execSync('which claude', { encoding: 'utf-8', timeout: 5000 }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function checkCliVersion(cliPath: string): { ok: boolean; version?: string; error?: string } {
  try {
    const version = execSync(`"${cliPath}" --version`, { encoding: 'utf-8', timeout: 10000 }).trim();
    const match = version.match(/(\d+)\.\d+/);
    if (!match || parseInt(match[1]) < 2) {
      return { ok: false, version, error: `Claude CLI ${version} too old (need >= 2.x)` };
    }
    return { ok: true, version };
  } catch {
    return { ok: false, error: 'Failed to run claude --version' };
  }
}

// ── StreamState ──

interface StreamState {
  hasReceivedResult: boolean;
  hasStreamedText: boolean;
  lastAssistantText: string;
}

export type PermissionTimeoutCallback = (toolName: string, toolUseId: string) => void;

export class ClaudeSDKProvider implements LLMProvider {
  private pendingPerms: PendingPermissions;
  private cliPath: string | undefined;

  /** Called when a permission request times out — set by main.ts to send IM notifications */
  onPermissionTimeout?: PermissionTimeoutCallback;

  constructor(pendingPerms: PendingPermissions) {
    this.pendingPerms = pendingPerms;

    // Preflight check
    this.cliPath = findClaudeCli();
    if (this.cliPath) {
      const check = checkCliVersion(this.cliPath);
      if (!check.ok) {
        console.warn(`[claude-sdk] CLI preflight warning: ${check.error}`);
      } else {
        console.log(`[claude-sdk] Using Claude CLI ${check.version} at ${this.cliPath}`);
      }
    } else {
      console.warn('[claude-sdk] Claude CLI not found — SDK will use default resolution');
    }
  }

  streamChat(params: StreamChatParams): StreamChatResult {
    const pendingPerms = this.pendingPerms;
    const cliPath = this.cliPath;
    const onPermissionTimeout = this.onPermissionTimeout;

    // Query controls exposed for interrupt/stopTask
    let controls: QueryControls | undefined;

    const stream = new ReadableStream<string>({
      start(controller) {
        (async () => {
          const state: StreamState = {
            hasReceivedResult: false,
            hasStreamedText: false,
            lastAssistantText: '',
          };

          let stderrBuf = '';

          try {
            // Save image attachments to temp files so Claude Code can read them
            let prompt = params.prompt;
            if (params.attachments?.length) {
              const imgDir = join(tmpdir(), 'tlive-images');
              mkdirSync(imgDir, { recursive: true });
              const imagePaths: string[] = [];
              for (const att of params.attachments) {
                if (att.type === 'image') {
                  const ext = att.mimeType === 'image/png' ? '.png' : att.mimeType === 'image/gif' ? '.gif' : '.jpg';
                  const filePath = join(imgDir, `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`);
                  writeFileSync(filePath, Buffer.from(att.base64Data, 'base64'));
                  imagePaths.push(filePath);
                }
              }
              if (imagePaths.length > 0) {
                const imageRefs = imagePaths.map(p => p).join('\n');
                prompt = `[User sent ${imagePaths.length} image(s) — read them to see the content]\n${imageRefs}\n\n${prompt}`;
              }
            }

            const queryOptions: Record<string, unknown> = {
              cwd: params.workingDirectory,
              model: params.model || undefined,
              resume: params.sessionId || undefined,
              permissionMode: params.permissionMode || undefined,
              effort: params.effort || undefined,
              // Enable AI-generated progress summaries for subagents (~30s interval)
              agentProgressSummaries: true,
              // Enable prompt suggestions (predicted next user prompt after each turn)
              promptSuggestions: true,
              // Use Claude Code's native permission rules for fine-grained control.
              // Safe read-only tools + safe Bash patterns are pre-approved.
              // Dangerous operations (write, delete, network) still trigger canUseTool.
              settings: {
                permissions: {
                  allow: [
                    // Read-only tools — always safe
                    'Read(*)', 'Glob(*)', 'Grep(*)', 'WebSearch(*)', 'WebFetch(*)',
                    'Agent(*)', 'Task(*)', 'TodoRead(*)', 'ToolSearch(*)',
                    // Safe Bash commands — read-only, no side effects
                    'Bash(cat *)', 'Bash(head *)', 'Bash(tail *)', 'Bash(less *)',
                    'Bash(wc *)', 'Bash(ls *)', 'Bash(tree *)', 'Bash(find *)',
                    'Bash(grep *)', 'Bash(rg *)', 'Bash(ag *)',
                    'Bash(file *)', 'Bash(stat *)', 'Bash(du *)', 'Bash(df *)',
                    'Bash(which *)', 'Bash(type *)', 'Bash(whereis *)',
                    'Bash(echo *)', 'Bash(printf *)', 'Bash(date *)',
                    'Bash(pwd)', 'Bash(whoami)', 'Bash(uname *)', 'Bash(env)',
                    'Bash(git log *)', 'Bash(git status *)', 'Bash(git diff *)',
                    'Bash(git show *)', 'Bash(git blame *)', 'Bash(git branch *)',
                    'Bash(node -v *)', 'Bash(npm list *)', 'Bash(npx tsc *)',
                    'Bash(go version *)', 'Bash(go list *)',
                  ],
                },
              },
              env: buildSubprocessEnv(),
              stderr: (data: string) => {
                stderrBuf += data;
                if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
              },
              abortController: params.abortSignal
                ? Object.assign(new AbortController(), { signal: params.abortSignal })
                : undefined,
              canUseTool: async (
                toolName: string,
                input: Record<string, unknown>,
                options: { decisionReason?: string; title?: string; suggestions?: unknown[]; signal?: AbortSignal } = {},
              ): Promise<PermissionResult> => {
                // AskUserQuestion — route to dedicated handler
                if (toolName === 'AskUserQuestion' && params.onAskUserQuestion) {
                  const questions = (input as Record<string, unknown>).questions as Array<{
                    question: string;
                    header: string;
                    options: Array<{ label: string; description?: string }>;
                    multiSelect: boolean;
                  }> ?? [];
                  if (questions.length > 0) {
                    try {
                      const answers = await params.onAskUserQuestion(questions, options.signal);
                      return {
                        behavior: 'allow' as const,
                        updatedInput: { questions: (input as Record<string, unknown>).questions, answers },
                      };
                    } catch {
                      return { behavior: 'deny' as const, message: 'User did not answer' };
                    }
                  }
                }
                // If no handler (perm off) → auto-allow
                if (!params.onPermissionRequest) {
                  return { behavior: 'allow' as const, updatedInput: input };
                }
                // Already aborted by SDK (subagent stopped) → don't bother asking
                if (options.signal?.aborted) {
                  return { behavior: 'deny' as const, message: 'Cancelled by SDK' };
                }
                const reason = options.decisionReason || options.title || toolName;
                console.log(`[claude-sdk] canUseTool: ${toolName} → asking user (${reason})`);
                // Pass abort signal so handler can clean up gateway entry on cancel
                const decision = await params.onPermissionRequest(toolName, input, reason, options.signal);
                if (decision === 'allow') {
                  return { behavior: 'allow' as const, updatedInput: input };
                }
                if (decision === 'allow_always') {
                  // SDK API uses behavior:'allow' + updatedPermissions to persist the rule.
                  // 'allow_always' is our internal concept, mapped to SDK's permission update mechanism.
                  return {
                    behavior: 'allow' as const,
                    updatedInput: input,
                    ...(options.suggestions ? { updatedPermissions: options.suggestions } : {}),
                  } as PermissionResult;
                }
                return { behavior: 'deny' as const, message: 'Denied by user via IM' };
              },
            };

            if (cliPath) {
              queryOptions.pathToClaudeCodeExecutable = cliPath;
            }

            const q = query({
              prompt: prompt as Parameters<typeof query>[0]['prompt'],
              options: queryOptions as Parameters<typeof query>[0]['options'],
            });

            // Expose query controls for interrupt/stopTask
            controls = {
              interrupt: () => (q as any).interrupt?.() ?? Promise.resolve(),
              stopTask: (taskId: string) => (q as any).stopTask?.(taskId) ?? Promise.resolve(),
            };

            for await (const msg of q) {
              // Debug: log message types to diagnose early termination
              const sub = 'subtype' in msg ? `.${msg.subtype}` : '';
              const turns = 'num_turns' in msg ? ` turns=${msg.num_turns}` : '';
              console.log(`[claude-sdk] msg: ${msg.type}${sub}${turns}`);
              handleMessage(msg, controller, state);
            }

            console.log(`[claude-sdk] query ended. streamed=${state.hasStreamedText} text_len=${state.lastAssistantText.length}`);
            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            // Check for auth errors first
            const authType = classifyAuthError(message) || (stderrBuf ? classifyAuthError(stderrBuf) : false);
            if (authType === 'cli') {
              console.error('[claude-sdk] Auth error: not logged in. Run `claude /login` to authenticate.');
              controller.enqueue(sseEvent('error', 'Not logged in. Run `claude /login` to authenticate.'));
              controller.close();
              return;
            }
            if (authType === 'api') {
              console.error('[claude-sdk] Auth error: invalid API key or unauthorized.');
              controller.enqueue(sseEvent('error', 'Invalid API key or unauthorized. Check your credentials.'));
              controller.close();
              return;
            }

            // If result was already received, this is just transport teardown noise
            if (state.hasReceivedResult && message.includes('process exited with code')) {
              controller.close();
              return;
            }

            const diagInfo = stderrBuf ? ` [stderr: ${stderrBuf.slice(-200)}]` : '';
            console.error(`[claude-sdk] query error: ${message}${diagInfo}`);

            controller.enqueue(sseEvent('error', message));
            controller.close();
          }
        })();
      },
    });

    return { stream, controls };
  }
}

/** Mutates state; returns true if text was streamed in this message. */
function handleMessage(
  msg: SDKMessage,
  controller: ReadableStreamDefaultController<string>,
  state: StreamState,
): void {
  switch (msg.type) {
    case 'stream_event': {
      const event = msg.event;
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        state.lastAssistantText += event.delta.text;
        controller.enqueue(sseEvent('text', event.delta.text));
        state.hasStreamedText = true;
      }
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        controller.enqueue(sseEvent('tool_use', {
          id: event.content_block.id,
          name: event.content_block.name,
          input: {},
        }));
      }
      break;
    }

    case 'assistant': {
      if (msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            controller.enqueue(sseEvent('tool_use', {
              id: block.id,
              name: block.name,
              input: block.input,
            }));
          } else if (block.type === 'text' && block.text && !state.hasStreamedText) {
            // Fallback: if no stream_event text_delta was received,
            // emit the full text from the assistant message
            state.lastAssistantText = block.text;
            controller.enqueue(sseEvent('text', block.text));
            state.hasStreamedText = true;
          }
        }
      }
      break;
    }

    case 'user': {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
            const rb = block as { tool_use_id: string; content?: unknown; is_error?: boolean };
            controller.enqueue(sseEvent('tool_result', {
              tool_use_id: rb.tool_use_id,
              content: typeof rb.content === 'string' ? rb.content : JSON.stringify(rb.content ?? ''),
              is_error: rb.is_error || false,
            }));
          }
        }
      }
      break;
    }

    case 'result': {
      state.hasReceivedResult = true;
      // Log permission denials — these explain why Claude may have stopped early
      const denials = 'permission_denials' in msg && Array.isArray(msg.permission_denials)
        ? msg.permission_denials as SDKPermissionDenial[]
        : [];
      if (denials.length > 0) {
        console.warn(`[claude-sdk] Permission denials:`, denials.map(d => `${d.tool_name}(${d.tool_use_id})`).join(', '));
      }
      if (msg.subtype === 'success') {
        controller.enqueue(sseEvent('result', {
          session_id: msg.session_id,
          is_error: msg.is_error,
          usage: {
            input_tokens: msg.usage.input_tokens,
            output_tokens: msg.usage.output_tokens,
            cost_usd: msg.total_cost_usd,
          },
          permission_denials: denials.length > 0 ? denials : undefined,
        }));
      } else {
        const errors = 'errors' in msg && Array.isArray(msg.errors)
          ? msg.errors.join('; ')
          : 'Unknown error';
        // Include permission denials in error message for visibility
        const denialInfo = denials.length > 0
          ? ` [denied: ${denials.map(d => d.tool_name).join(', ')}]`
          : '';
        controller.enqueue(sseEvent('error', errors + denialInfo));
      }
      break;
    }

    case 'prompt_suggestion': {
      const m = msg as { suggestion?: string };
      if (m.suggestion) {
        controller.enqueue(sseEvent('prompt_suggestion', m.suggestion));
      }
      break;
    }

    case 'system': {
      if (msg.subtype === 'init') {
        controller.enqueue(sseEvent('status', {
          session_id: msg.session_id,
          model: msg.model,
        }));
      } else if (msg.subtype === 'task_started') {
        const m = msg as { description?: string };
        controller.enqueue(sseEvent('agent_started', { description: m.description || 'Agent' }));
      } else if (msg.subtype === 'task_progress') {
        const m = msg as { description?: string; summary?: string; last_tool_name?: string; usage?: { tool_uses: number; duration_ms: number } };
        controller.enqueue(sseEvent('agent_progress', {
          // Prefer AI summary (from agentProgressSummaries) over static description
          description: m.summary || m.description || 'Working...',
          lastTool: m.last_tool_name,
          usage: m.usage,
        }));
      } else if (msg.subtype === 'task_notification') {
        const m = msg as { summary?: string; status?: string };
        controller.enqueue(sseEvent('agent_complete', {
          summary: m.summary || 'Done',
          status: m.status || 'completed',
        }));
      }
      break;
    }

    // Tool-level progress (long-running Bash commands, etc.)
    case 'tool_progress': {
      const m = msg as { tool_name?: string; elapsed_time_seconds?: number; task_id?: string };
      if (m.tool_name && m.elapsed_time_seconds && m.elapsed_time_seconds > 3) {
        controller.enqueue(sseEvent('tool_progress', {
          toolName: m.tool_name,
          elapsed: m.elapsed_time_seconds,
        }));
      }
      break;
    }

    // API retry (rate limits, server errors)
    case 'rate_limit_event': {
      const m = msg as { rate_limit_info?: { status?: string; utilization?: number; resetsAt?: number } };
      const info = m.rate_limit_info;
      if (info?.status === 'rejected' || info?.status === 'allowed_warning') {
        controller.enqueue(sseEvent('rate_limit', {
          status: info.status,
          utilization: info.utilization,
          resetsAt: info.resetsAt,
        }));
      }
      break;
    }
  }
}
