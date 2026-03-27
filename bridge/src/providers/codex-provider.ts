/**
 * LLM Provider using @openai/codex-sdk.
 * Gracefully degrades if the SDK is not installed (platform-specific binaries).
 */

import type { LLMProvider, StreamChatParams, StreamChatResult, QueryControls } from './base.js';
import type { CanonicalEvent } from '../messages/schema.js';
import { CodexAdapter } from '../messages/codex-adapter.js';

export class CodexProvider implements LLMProvider {
  private Codex: any;
  private available = false;

  constructor() {
    // Lazy import — Codex SDK is optional
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('@openai/codex-sdk');
      this.Codex = mod.Codex || mod.default?.Codex;
      this.available = !!this.Codex;
      if (this.available) {
        console.log('[codex] Codex SDK available');
      }
    } catch {
      console.warn('[codex] @openai/codex-sdk not installed — Codex provider unavailable');
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  streamChat(params: StreamChatParams): StreamChatResult {
    if (!this.available) {
      const stream = new ReadableStream<CanonicalEvent>({
        start(controller) {
          controller.enqueue({
            kind: 'error',
            message: 'Codex SDK not installed. Run: npm install @openai/codex-sdk',
          } as CanonicalEvent);
          controller.close();
        },
      });
      return { stream };
    }

    const adapter = new CodexAdapter();
    let abortController: AbortController | undefined;

    const stream = new ReadableStream<CanonicalEvent>({
      start: (controller) => {
        (async () => {
          try {
            const codex = new this.Codex({
              apiKey: process.env.OPENAI_API_KEY,
            });

            // Map permission mode to approval policy
            const approvalPolicy = params.onPermissionRequest
              ? 'untrusted'   // Will need approval
              : 'on-failure'; // Auto-approve most things

            const threadOptions: Record<string, unknown> = {
              model: params.model || process.env.CODEX_MODEL || undefined,
              workingDirectory: params.workingDirectory,
              approvalPolicy,
              sandboxMode: 'workspace-write',
            };

            let thread: any;
            if (params.sessionId) {
              thread = codex.resumeThread(params.sessionId, threadOptions);
            } else {
              thread = codex.startThread(threadOptions);
            }

            abortController = new AbortController();
            const { events } = await thread.runStreamed(params.prompt, {
              signal: abortController.signal,
            });

            for await (const event of events) {
              console.log(`[codex] event: ${event.type}${event.item ? `.${event.item.type}` : ''}`);
              const canonicalEvents = adapter.adapt(event);
              for (const ce of canonicalEvents) {
                controller.enqueue(ce);
              }
            }

            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[codex] Error: ${message}`);
            controller.enqueue({ kind: 'error', message } as CanonicalEvent);
            controller.close();
          }
        })();
      },
    });

    const controls: QueryControls = {
      interrupt: async () => { abortController?.abort(); },
      stopTask: async () => { abortController?.abort(); },
    };

    return { stream, controls };
  }
}
