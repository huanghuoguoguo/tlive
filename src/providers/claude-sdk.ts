/**
 * LLM Provider using @anthropic-ai/claude-agent-sdk query() function.
 * Based on the original Claude-to-IM bridge implementation.
 */

import { existsSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAdapter } from './claude-adapter.js';
import type { CanonicalEvent } from '../canonical/schema.js';
import type {
  AgentProvider,
  AgentProviderCapabilities,
  CreateSessionParams,
  StreamChatParams,
  StreamChatResult,
  QueryControls,
  LiveSession,
  PermissionTimeoutCallback,
} from './base.js';
import { DEFAULT_AGENT_SETTING_SOURCES, type AgentSettingSource } from '../config.js';
import { ClaudeLiveSession } from './claude-live-session.js';
import { preparePromptWithImages } from './prompt-media.js';
import {
  buildClaudeQueryOptions,
  createClaudeQueryControls,
  routeAskUserQuestionRequest,
  routeDeferredToolRequest,
  routePermissionRequest,
  type ClaudeCanUseToolOptions,
} from './claude-query-options.js';
import { ClaudeEventLogger } from './claude-event-logger.js';
import { checkClaudeCliVersion, findClaudeCli } from './cli-detection.js';

// Re-export for backward compatibility.
export type { PermissionTimeoutCallback } from './base.js';

// ── Auth error classification ──

const CLI_AUTH_PATTERNS = [/not logged in/i, /please run \/login/i];
const API_AUTH_PATTERNS = [/unauthorized/i, /invalid.*api.?key/i, /401\b/];

const STREAM_CHAT_ALLOW_PERMISSIONS = [
  'Read(*)',
  'Glob(*)',
  'Grep(*)',
  'WebSearch(*)',
  'WebFetch(*)',
  'Agent(*)',
  'Task(*)',
  'TodoRead(*)',
  'ToolSearch(*)',
  'Bash(cat *)',
  'Bash(head *)',
  'Bash(tail *)',
  'Bash(less *)',
  'Bash(wc *)',
  'Bash(ls *)',
  'Bash(tree *)',
  'Bash(find *)',
  'Bash(grep *)',
  'Bash(rg *)',
  'Bash(ag *)',
  'Bash(file *)',
  'Bash(stat *)',
  'Bash(du *)',
  'Bash(df *)',
  'Bash(which *)',
  'Bash(type *)',
  'Bash(whereis *)',
  'Bash(echo *)',
  'Bash(printf *)',
  'Bash(date *)',
  'Bash(pwd)',
  'Bash(whoami)',
  'Bash(uname *)',
  'Bash(env)',
  'Bash(git log *)',
  'Bash(git status *)',
  'Bash(git diff *)',
  'Bash(git show *)',
  'Bash(git blame *)',
  'Bash(git branch *)',
  'Bash(node -v *)',
  'Bash(npm list *)',
  'Bash(npx tsc *)',
  'Bash(go version *)',
  'Bash(go list *)',
] as const;

function classifyAuthError(text: string): 'cli' | 'api' | false {
  if (CLI_AUTH_PATTERNS.some((re) => re.test(text))) return 'cli';
  if (API_AUTH_PATTERNS.some((re) => re.test(text))) return 'api';
  return false;
}

// ── Temp image directory cleanup ──

let lastImageDirCleanup = 0;
const IMAGE_DIR_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

function cleanupImageDir(): void {
  const now = Date.now();
  if (now - lastImageDirCleanup < IMAGE_DIR_CLEANUP_INTERVAL) return;
  lastImageDirCleanup = now;

  try {
    const imgDir = join(tmpdir(), 'tlive-images');
    if (!existsSync(imgDir)) return;
    const maxAge = 60 * 60 * 1000; // 1 hour
    for (const file of readdirSync(imgDir)) {
      const filePath = join(imgDir, file);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > maxAge) {
          unlinkSync(filePath);
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore cleanup errors */
  }
}

// ── StreamState ──

interface StreamState {
  hasReceivedResult: boolean;
  hasStreamedText: boolean;
  lastAssistantText: string;
}

export class ClaudeSDKProvider implements AgentProvider {
  readonly kind = 'claude' as const;
  readonly displayName = 'Claude Code';
  readonly capabilities = {
    runtimeMode: 'interactive',
    nativeSteer: true,
    nativeQueue: true,
    interactivePermissions: true,
    askUserQuestion: true,
    deferredTools: true,
    settingSources: true,
    sessionResume: true,
    imageInputs: true,
  } satisfies AgentProviderCapabilities;

  private cliPath: string | undefined;
  private defaultSettingSources: AgentSettingSource[];

  /** Called when a permission request times out — set by main.ts to send IM notifications */
  onPermissionTimeout?: PermissionTimeoutCallback;

  constructor(settingSources?: AgentSettingSource[]) {
    this.defaultSettingSources = settingSources?.length
      ? [...settingSources]
      : [...DEFAULT_AGENT_SETTING_SOURCES];

    // Preflight check
    this.cliPath = findClaudeCli();
    if (this.cliPath) {
      const check = checkClaudeCliVersion(this.cliPath);
      if (!check.available) {
        console.warn(`[claude-sdk] CLI preflight warning: ${check.reason}`);
      } else {
        console.log(`[claude-sdk] Using Claude CLI ${check.version} at ${this.cliPath}`);
      }
    } else {
      console.warn('[claude-sdk] Claude CLI not found — SDK will use default resolution');
    }

    const srcLabel =
      this.defaultSettingSources.length > 0
        ? this.defaultSettingSources.join(', ')
        : 'none (isolation mode)';
    console.log(`[claude-sdk] Settings sources: ${srcLabel}`);
  }

  getDefaultSettingSources(): AgentSettingSource[] {
    return [...this.defaultSettingSources];
  }

  createSession(params: CreateSessionParams): LiveSession {
    return new ClaudeLiveSession({
      workingDirectory: params.workingDirectory,
      sessionId: params.sessionId,
      cliPath: this.cliPath,
      settingSources: params.settingSources ?? this.defaultSettingSources,
      effort: params.effort,
      model: params.model,
      appendSystemPrompt: params.appendSystemPrompt,
    });
  }

  streamChat(params: StreamChatParams): StreamChatResult {
    const cliPath = this.cliPath;
    const settingSources = params.settingSources ?? this.defaultSettingSources;

    // Query controls exposed for interrupt/stopTask
    let controls: QueryControls | undefined;

    const stream = new ReadableStream<CanonicalEvent>({
      start(controller) {
        (async () => {
          const state: StreamState = {
            hasReceivedResult: false,
            hasStreamedText: false,
            lastAssistantText: '',
          };

          let stderrBuf = '';
          let imagePaths: string[] = [];
          const eventLogger = new ClaudeEventLogger('claude-sdk');

          try {
            const prepared = preparePromptWithImages(
              params.prompt,
              params.attachments,
              join(tmpdir(), 'tlive-images'),
            );
            const prompt = prepared.prompt;
            imagePaths = prepared.imagePaths;

            const queryOptions = buildClaudeQueryOptions({
              cwd: params.workingDirectory,
              model: params.model,
              resume: params.sessionId,
              permissionMode: params.permissionMode,
              effort: params.effort,
              settingSources,
              cliPath,
              abortSignal: params.abortSignal,
              allowPermissions: STREAM_CHAT_ALLOW_PERMISSIONS,
              stderr: (data: string) => {
                stderrBuf += data;
                if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
              },
              canUseTool: async (
                toolName: string,
                input: Record<string, unknown>,
                options: ClaudeCanUseToolOptions = {},
              ) => {
                const deferred = await routeDeferredToolRequest(
                  toolName,
                  input,
                  options,
                  params.onDeferredTool,
                );
                if (deferred) return deferred;

                const answer = await routeAskUserQuestionRequest(
                  toolName,
                  input,
                  options,
                  params.onAskUserQuestion,
                );
                if (answer) return answer;

                return routePermissionRequest({
                  logPrefix: 'claude-sdk',
                  toolName,
                  input,
                  options,
                  handler: params.onPermissionRequest,
                });
              },
            });

            const q = query({
              prompt: prompt as Parameters<typeof query>[0]['prompt'],
              options: queryOptions as Parameters<typeof query>[0]['options'],
            });

            // Expose query controls for interrupt/stopTask
            controls = createClaudeQueryControls(q);

            const adapter = new ClaudeAdapter();

            for await (const msg of q) {
              eventLogger.logSdkMessage(
                msg as { type: string; subtype?: string; num_turns?: unknown },
              );

              const events = adapter.mapMessage(msg as any);
              eventLogger.logMappedEvents(events);
              for (const event of events) {
                controller.enqueue(event);
              }

              // Track state for error handling
              if (msg.type === 'result') state.hasReceivedResult = true;
              if (events.some((e) => e.kind === 'text_delta')) state.hasStreamedText = true;
              for (const event of events) {
                if (event.kind === 'text_delta') state.lastAssistantText += event.text;
              }
            }

            eventLogger.flush();
            console.log(
              `[claude-sdk] query ended. streamed=${state.hasStreamedText} text_len=${state.lastAssistantText.length}`,
            );
            controller.close();
          } catch (err) {
            eventLogger.flush();
            const message = err instanceof Error ? err.message : String(err);

            // Check for auth errors first
            const authType =
              classifyAuthError(message) || (stderrBuf ? classifyAuthError(stderrBuf) : false);
            if (authType === 'cli') {
              console.error(
                '[claude-sdk] Auth error: not logged in. Run `claude /login` to authenticate.',
              );
              controller.enqueue({
                kind: 'error',
                message: 'Not logged in. Run `claude /login` to authenticate.',
              } as CanonicalEvent);
              controller.close();
              return;
            }
            if (authType === 'api') {
              console.error('[claude-sdk] Auth error: invalid API key or unauthorized.');
              controller.enqueue({
                kind: 'error',
                message: 'Invalid API key or unauthorized. Check your credentials.',
              } as CanonicalEvent);
              controller.close();
              return;
            }

            // If result was already received, skip sending additional error event
            // (the result event already includes the error information)
            if (state.hasReceivedResult) {
              controller.close();
              return;
            }

            const diagInfo = stderrBuf ? ` [stderr: ${stderrBuf.slice(-200)}]` : '';
            console.error(`[claude-sdk] query error: ${message}${diagInfo}`);

            controller.enqueue({ kind: 'error', message } as CanonicalEvent);
            controller.close();
          } finally {
            // Clean up this query's temp image files
            for (const path of imagePaths) {
              try {
                unlinkSync(path);
              } catch {
                /* ignore */
              }
            }
            // Periodically clean up old files in tlive-images dir
            cleanupImageDir();
          }
        })();
      },
    });

    return { stream, controls };
  }
}
