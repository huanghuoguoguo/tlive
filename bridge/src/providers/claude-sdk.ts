/**
 * LLM Provider using @anthropic-ai/claude-agent-sdk query() function.
 * Based on Claude-to-IM-skill's implementation.
 */

import { execSync } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { sseEvent } from './sse-utils.js';
import type { LLMProvider, StreamChatParams } from './base.js';
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

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const pendingPerms = this.pendingPerms;
    const cliPath = this.cliPath;
    const onPermissionTimeout = this.onPermissionTimeout;

    return new ReadableStream({
      start(controller) {
        (async () => {
          const state: StreamState = {
            hasReceivedResult: false,
            hasStreamedText: false,
            lastAssistantText: '',
          };

          let stderrBuf = '';

          try {
            const queryOptions: Record<string, unknown> = {
              cwd: params.workingDirectory,
              model: params.model || undefined,
              resume: params.sessionId || undefined,
              permissionMode: params.permissionMode || undefined,
              env: buildSubprocessEnv(),
              stderr: (data: string) => {
                stderrBuf += data;
                if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
              },
              abortController: params.abortSignal
                ? Object.assign(new AbortController(), { signal: params.abortSignal })
                : undefined,
              // Auto-allow all tools at SDK level.
              // Permissions are handled by Claude Code's hook system:
              //   PermissionRequest hook → Go Core → IM (Telegram/Discord/Feishu)
              // If no hook is installed, Claude Code's built-in permission dialog handles it.
              canUseTool: async (
                _toolName: string,
                input: Record<string, unknown>,
              ): Promise<PermissionResult> => {
                return { behavior: 'allow' as const, updatedInput: input };
              },
            };

            if (cliPath) {
              queryOptions.pathToClaudeCodeExecutable = cliPath;
            }

            const q = query({
              prompt: params.prompt as Parameters<typeof query>[0]['prompt'],
              options: queryOptions as Parameters<typeof query>[0]['options'],
            });

            for await (const msg of q) {
              handleMessage(msg, controller, state);
            }

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
      if (msg.subtype === 'success') {
        controller.enqueue(sseEvent('result', {
          session_id: msg.session_id,
          is_error: msg.is_error,
          usage: {
            input_tokens: msg.usage.input_tokens,
            output_tokens: msg.usage.output_tokens,
            cost_usd: msg.total_cost_usd,
          },
        }));
      } else {
        const errors = 'errors' in msg && Array.isArray(msg.errors)
          ? msg.errors.join('; ')
          : 'Unknown error';
        controller.enqueue(sseEvent('error', errors));
      }
      break;
    }

    case 'system': {
      if (msg.subtype === 'init') {
        controller.enqueue(sseEvent('status', {
          session_id: msg.session_id,
          model: msg.model,
        }));
      }
      break;
    }
  }
}
