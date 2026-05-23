/**
 * ClaudeAdapter — maps SDKMessage from @anthropic-ai/claude-agent-sdk
 * to CanonicalEvent[].
 *
 * Stateful: tracks block types for thinking vs text, streamed text
 * for dedup, and hidden tool IDs for filtering.
 */

import { canonicalEventSchema, type CanonicalEvent } from '../../shared/canonical/schema.js';

// SDK types are loose — we define the shapes we actually consume.
export interface SDKMessage {
  type: string;
  subtype?: string;
  [key: string]: unknown;
}

const HIDDEN_TOOLS = new Set([
  'ToolSearch',
  'TodoRead',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TaskStop',
  'TaskOutput',
]);

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface CanonicalUsage extends Record<string, unknown> {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

function mapUsage(usage: ClaudeUsage | undefined, costUsd: unknown): CanonicalUsage {
  const inputTokens = usage?.input_tokens ?? 0;
  const cacheCreationInputTokens = usage?.cache_creation_input_tokens ?? 0;
  const cacheReadInputTokens = usage?.cache_read_input_tokens ?? 0;
  return {
    inputTokens: inputTokens + cacheCreationInputTokens + cacheReadInputTokens,
    outputTokens: usage?.output_tokens ?? 0,
    ...(cacheReadInputTokens > 0 ? { cachedInputTokens: cacheReadInputTokens } : {}),
    ...(typeof costUsd === 'number' ? { costUsd } : {}),
  };
}

export class ClaudeAdapter {
  private currentBlockType: 'text' | 'thinking' | null = null;
  private hasStreamedText = false;
  private hiddenToolUseIds = new Set<string>();
  private streamedToolUseIds = new Set<string>();
  private streamToolBlocks = new Map<
    number,
    {
      id: string;
      name: string;
      inputBuffer: string;
      emitted: boolean;
    }
  >();

  /** Reset state between queries. */
  reset(): void {
    this.currentBlockType = null;
    this.hasStreamedText = false;
    this.hiddenToolUseIds.clear();
    this.streamedToolUseIds.clear();
    this.streamToolBlocks.clear();
  }

  /** Map one SDKMessage to zero or more CanonicalEvents. */
  mapMessage(msg: SDKMessage): CanonicalEvent[] {
    const events: CanonicalEvent[] = [];

    switch (msg.type) {
      case 'stream_event':
        this.handleStreamEvent(msg, events);
        break;

      case 'assistant':
        this.handleAssistant(msg, events);
        break;

      case 'user':
        this.handleUser(msg, events);
        break;

      case 'result':
        this.handleResult(msg, events);
        break;

      case 'system':
        this.handleSystem(msg, events);
        break;

      case 'tool_progress':
        this.handleToolProgress(msg, events);
        break;

      case 'tool_use_summary':
        this.handleToolUseSummary(msg, events);
        break;

      case 'rate_limit_event':
        this.handleRateLimit(msg, events);
        break;

      case 'prompt_suggestion':
        this.handlePromptSuggestion(msg, events);
        break;

      default:
        // Unknown message type — skip
        break;
    }

    // Validate every event through Zod
    return events.map((e) => canonicalEventSchema.parse(e));
  }

  // ── stream_event ──

  private handleStreamEvent(msg: SDKMessage, events: CanonicalEvent[]): void {
    const event = msg.event as Record<string, unknown> | undefined;
    if (!event) return;
    const index = typeof event.index === 'number' ? event.index : undefined;

    if (event.type === 'content_block_start') {
      const block = event.content_block as Record<string, unknown> | undefined;
      if (!block) return;

      if (block.type === 'thinking') {
        this.currentBlockType = 'thinking';
      } else if (block.type === 'text') {
        this.currentBlockType = 'text';
      } else if (block.type === 'tool_use') {
        const name = block.name as string;
        const id = block.id as string;

        if (HIDDEN_TOOLS.has(name)) {
          this.hiddenToolUseIds.add(id);
          return;
        }

        const input = (block.input as Record<string, unknown>) ?? {};
        const hasInput = Object.keys(input).length > 0;

        if (typeof index === 'number') {
          this.streamToolBlocks.set(index, {
            id,
            name,
            inputBuffer: '',
            emitted: false,
          });
        }

        if (hasInput) {
          const ev: CanonicalEvent = {
            kind: 'tool_start',
            id,
            name,
            input,
          };
          events.push(ev);
          this.streamedToolUseIds.add(id);
          const state = typeof index === 'number' ? this.streamToolBlocks.get(index) : undefined;
          if (state) state.emitted = true;
        }
      }
    } else if (event.type === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (!delta) return;

      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        const ev: CanonicalEvent = {
          kind: 'thinking_delta',
          text: delta.thinking,
        };
        events.push(ev);
      } else if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        if (this.currentBlockType === 'thinking') {
          const ev: CanonicalEvent = {
            kind: 'thinking_delta',
            text: delta.text,
          };
          events.push(ev);
        } else {
          this.hasStreamedText = true;
          const ev: CanonicalEvent = {
            kind: 'text_delta',
            text: delta.text,
          };
          events.push(ev);
        }
      } else if (
        delta.type === 'input_json_delta' &&
        typeof delta.partial_json === 'string' &&
        typeof index === 'number'
      ) {
        const state = this.streamToolBlocks.get(index);
        if (state) {
          state.inputBuffer += delta.partial_json;
        }
      }
    } else if (event.type === 'content_block_stop' && typeof index === 'number') {
      const state = this.streamToolBlocks.get(index);
      if (!state) return;
      this.streamToolBlocks.delete(index);
      if (state.emitted) return;

      const input = this.parseToolInput(state.inputBuffer);
      const ev: CanonicalEvent = {
        kind: 'tool_start',
        id: state.id,
        name: state.name,
        input,
      };
      events.push(ev);
      this.streamedToolUseIds.add(state.id);
    }
  }

  // ── assistant ──

  private handleAssistant(msg: SDKMessage, events: CanonicalEvent[]): void {
    const message = msg.message as { content?: unknown[] } | undefined;
    if (!message?.content) return;

    for (const block of message.content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;

      if (b.type === 'tool_use') {
        const name = b.name as string;
        const id = b.id as string;

        if (HIDDEN_TOOLS.has(name)) {
          this.hiddenToolUseIds.add(id);
          continue;
        }

        if (this.streamedToolUseIds.has(id)) {
          continue;
        }

        // Tool use resets the streamed flag — any text after tools is new
        this.hasStreamedText = false;

        const ev: CanonicalEvent = {
          kind: 'tool_start',
          id,
          name,
          input: (b.input as Record<string, unknown>) ?? {},
        };
        events.push(ev);
      } else if (
        b.type === 'text' &&
        typeof b.text === 'string' &&
        b.text &&
        !this.hasStreamedText
      ) {
        this.hasStreamedText = true;
        const ev: CanonicalEvent = {
          kind: 'text_delta',
          text: b.text,
        };
        events.push(ev);
      }
    }
  }

  private parseToolInput(inputBuffer: string): Record<string, unknown> {
    if (!inputBuffer.trim()) return {};
    try {
      const parsed = JSON.parse(inputBuffer);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  // ── user ──

  private handleUser(msg: SDKMessage, events: CanonicalEvent[]): void {
    const message = msg.message as { content?: unknown[] } | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (typeof block !== 'object' || block === null || !('type' in block)) continue;
      const b = block as Record<string, unknown>;

      if (b.type === 'tool_result') {
        const toolUseId = b.tool_use_id as string;

        // Filter results for hidden tools
        if (this.hiddenToolUseIds.has(toolUseId)) continue;

        const rawContent = b.content;
        const contentStr =
          typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent ?? '');

        const ev: CanonicalEvent = {
          kind: 'tool_result',
          toolUseId,
          content: contentStr,
          isError: (b.is_error as boolean) || false,
        };
        events.push(ev);
      }
    }
  }

  // ── result ──

  private handleResult(msg: SDKMessage, events: CanonicalEvent[]): void {
    const usage = msg.usage as ClaudeUsage | undefined;
    const denials = Array.isArray(msg.permission_denials)
      ? (msg.permission_denials as Array<{ tool_name: string; tool_use_id: string }>).map((d) => ({
          toolName: d.tool_name,
          toolUseId: d.tool_use_id,
        }))
      : undefined;

    if (msg.subtype === 'success') {
      const ev: CanonicalEvent = {
        kind: 'query_result',
        sessionId: msg.session_id as string,
        isError: (msg.is_error as boolean) || false,
        usage: mapUsage(usage, msg.total_cost_usd),
        ...(denials && denials.length > 0 ? { permissionDenials: denials } : {}),
      };
      events.push(ev);
    } else {
      // Check if this is a user-initiated interrupt (e.g. /stop command)
      const errors = Array.isArray(msg.errors) ? (msg.errors as string[]) : [];
      const isInterrupt = errors.some(
        (e) => typeof e === 'string' && e.includes('result_type=user'),
      );

      // For errors, emit a single error event with usage data included
      // This prevents double flush (query_result + error both triggering renderer)
      const errorMsg = isInterrupt
        ? 'Interrupted'
        : errors.length > 0
          ? errors.join('; ')
          : 'Unknown error';
      const ev: CanonicalEvent = {
        kind: 'query_result',
        sessionId: msg.session_id as string,
        isError: true,
        usage: mapUsage(usage, msg.total_cost_usd),
        error: errorMsg, // Include error message in query_result
        ...(denials && denials.length > 0 ? { permissionDenials: denials } : {}),
      };
      events.push(ev);
      // Don't emit separate 'error' event - query_result with isError=true handles it
    }
  }

  // ── system ──

  private handleSystem(msg: SDKMessage, events: CanonicalEvent[]): void {
    switch (msg.subtype) {
      case 'init': {
        const apiKeySource = msg.apiKeySource as string | undefined;
        if (apiKeySource) {
          console.log(`[claude-sdk] Active auth source: ${apiKeySource}`);
        }
        // Emit legacy status event (for model tracking)
        const statusEv: CanonicalEvent = {
          kind: 'status',
          sessionId: msg.session_id as string,
          model: msg.model as string,
        };
        events.push(statusEv);

        // Emit enriched session_info event with skills, MCP servers, tools
        const tools = Array.isArray(msg.tools) ? (msg.tools as string[]) : undefined;
        const mcpServers = Array.isArray(msg.mcp_servers)
          ? (msg.mcp_servers as Array<{ name: string; status: string }>)
          : undefined;
        const skills = Array.isArray(msg.skills) ? (msg.skills as string[]) : undefined;
        if (tools?.length || mcpServers?.length || skills?.length) {
          const infoEv: CanonicalEvent = {
            kind: 'session_info',
            sessionId: msg.session_id as string,
            model: msg.model as string,
            ...(tools?.length ? { tools } : {}),
            ...(mcpServers?.length ? { mcpServers } : {}),
            ...(skills?.length ? { skills } : {}),
          };
          events.push(infoEv);
        }
        break;
      }

      case 'api_retry': {
        const ev: CanonicalEvent = {
          kind: 'api_retry',
          attempt: (msg.attempt as number) || 1,
          maxRetries: (msg.max_retries as number) || 3,
          retryDelayMs: (msg.retry_delay_ms as number) || 0,
          ...(msg.error ? { error: msg.error as string } : {}),
        };
        events.push(ev);
        break;
      }

      case 'compact_boundary': {
        const metadata = msg.compact_metadata as
          | { trigger?: string; pre_tokens?: number }
          | undefined;
        const ev: CanonicalEvent = {
          kind: 'compact_boundary',
          trigger: (metadata?.trigger === 'manual' ? 'manual' : 'auto') as 'manual' | 'auto',
          ...(metadata?.pre_tokens != null ? { preTokens: metadata.pre_tokens } : {}),
        };
        events.push(ev);
        break;
      }

      case 'task_started': {
        const ev: CanonicalEvent = {
          kind: 'agent_start',
          description: (msg.description as string) || 'Agent',
          ...(msg.task_id ? { taskId: msg.task_id as string } : {}),
        };
        events.push(ev);
        break;
      }

      case 'task_progress': {
        const summary = msg.summary as string | undefined;
        const description = msg.description as string | undefined;
        const lastTool = msg.last_tool_name as string | undefined;
        const usage = msg.usage as { tool_uses: number; duration_ms: number } | undefined;

        const ev: CanonicalEvent = {
          kind: 'agent_progress',
          description: summary || description || 'Working...',
          ...(lastTool ? { lastTool } : {}),
          ...(usage ? { usage: { toolUses: usage.tool_uses, durationMs: usage.duration_ms } } : {}),
        };
        events.push(ev);
        break;
      }

      case 'task_notification': {
        const ev: CanonicalEvent = {
          kind: 'agent_complete',
          summary: (msg.summary as string) || 'Done',
          status: (msg.status as 'completed' | 'failed' | 'stopped') || 'completed',
        };
        events.push(ev);
        break;
      }
    }
  }

  // ── tool_progress ──

  private handleToolProgress(msg: SDKMessage, events: CanonicalEvent[]): void {
    const toolName = msg.tool_name as string | undefined;
    const elapsed = msg.elapsed_time_seconds as number | undefined;

    if (!toolName || !elapsed || elapsed <= 3) return;

    const ev: CanonicalEvent = {
      kind: 'tool_progress',
      toolName,
      elapsed,
    };
    events.push(ev);
  }

  // ── tool_use_summary ──

  private handleToolUseSummary(msg: SDKMessage, events: CanonicalEvent[]): void {
    const summary = msg.summary as string | undefined;
    if (!summary) return;

    const ev: CanonicalEvent = {
      kind: 'tool_use_summary',
      summary,
    };
    events.push(ev);
  }

  // ── rate_limit_event ──

  private handleRateLimit(msg: SDKMessage, events: CanonicalEvent[]): void {
    const info = msg.rate_limit_info as
      | {
          status?: string;
          utilization?: number;
          resetsAt?: number;
        }
      | undefined;

    if (!info) return;
    if (info.status !== 'rejected' && info.status !== 'allowed_warning') return;

    const ev: CanonicalEvent = {
      kind: 'rate_limit',
      status: info.status,
      ...(info.utilization != null ? { utilization: info.utilization } : {}),
      ...(info.resetsAt != null ? { resetsAt: info.resetsAt } : {}),
    };
    events.push(ev);
  }

  // ── prompt_suggestion ──

  private handlePromptSuggestion(msg: SDKMessage, events: CanonicalEvent[]): void {
    const suggestion = msg.suggestion as string | undefined;
    if (!suggestion) return;

    const ev: CanonicalEvent = {
      kind: 'prompt_suggestion',
      suggestion,
    };
    events.push(ev);
  }
}
