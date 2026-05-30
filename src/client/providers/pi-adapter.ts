import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { canonicalEventSchema, type CanonicalEvent } from '../../shared/canonical/schema.js';

interface PiAdapterState {
  sessionId?: string;
  model?: string;
  reasoningEffort?: string;
  startedTools: Set<string>;
  terminalEmitted: boolean;
}

export class PiAdapter {
  private state: PiAdapterState = {
    startedTools: new Set(),
    terminalEmitted: false,
  };

  constructor(options: { sessionId?: string; model?: string; reasoningEffort?: string } = {}) {
    this.state.sessionId = options.sessionId;
    this.state.model = options.model;
    this.state.reasoningEffort = options.reasoningEffort;
  }

  updateRuntime(options: { sessionId?: string; model?: string; reasoningEffort?: string }): void {
    this.state.sessionId = options.sessionId ?? this.state.sessionId;
    this.state.model = options.model ?? this.state.model;
    this.state.reasoningEffort = options.reasoningEffort ?? this.state.reasoningEffort;
  }

  mapEvent(event: AgentSessionEvent): CanonicalEvent[] {
    const events: CanonicalEvent[] = [];

    switch (event.type) {
      case 'message_update':
        this.mapAssistantUpdate(event.assistantMessageEvent, events);
        break;
      case 'tool_execution_start':
        events.push({
          kind: 'tool_start',
          id: event.toolCallId,
          name: event.toolName,
          input: normalizeToolInput(event.args),
        });
        this.state.startedTools.add(event.toolCallId);
        break;
      case 'tool_execution_update':
        if (!this.state.startedTools.has(event.toolCallId)) {
          events.push({
            kind: 'tool_start',
            id: event.toolCallId,
            name: event.toolName,
            input: normalizeToolInput(event.args),
          });
          this.state.startedTools.add(event.toolCallId);
        }
        events.push({
          kind: 'tool_result',
          toolUseId: event.toolCallId,
          content: toolResultContent(event.partialResult),
          isError: false,
          isFinal: false,
        });
        break;
      case 'tool_execution_end':
        if (!this.state.startedTools.has(event.toolCallId)) {
          events.push({
            kind: 'tool_start',
            id: event.toolCallId,
            name: event.toolName,
            input: normalizeToolInput({}),
          });
          this.state.startedTools.add(event.toolCallId);
        }
        events.push({
          kind: 'tool_result',
          toolUseId: event.toolCallId,
          content: toolResultContent(event.result),
          isError: event.isError,
          isFinal: true,
        });
        break;
      case 'agent_end':
        if (!event.willRetry) {
          events.push(this.queryResult(event.messages, false));
          this.state.terminalEmitted = true;
        }
        break;
      case 'auto_retry_start':
        events.push({
          kind: 'api_retry',
          attempt: event.attempt,
          maxRetries: event.maxAttempts,
          retryDelayMs: event.delayMs,
          error: event.errorMessage,
        });
        break;
      case 'compaction_start':
        events.push({
          kind: 'compact_boundary',
          trigger: event.reason === 'manual' ? 'manual' : 'auto',
        });
        break;
    }

    return events.map((e) => canonicalEventSchema.parse(e));
  }

  mapComplete(messages: unknown[] = []): CanonicalEvent[] {
    if (this.state.terminalEmitted) return [];
    this.state.terminalEmitted = true;
    return [canonicalEventSchema.parse(this.queryResult(messages, false))];
  }

  mapError(error: unknown, interrupted = false): CanonicalEvent[] {
    if (this.state.terminalEmitted) return [];
    this.state.terminalEmitted = true;
    return [
      canonicalEventSchema.parse(
        this.queryResult([], true, interrupted ? 'Interrupted' : errorMessage(error)),
      ),
    ];
  }

  private mapAssistantUpdate(
    event: AgentSessionEvent extends infer E
      ? E extends { type: 'message_update'; assistantMessageEvent: infer U }
        ? U
        : never
      : never,
    events: CanonicalEvent[],
  ): void {
    if (event.type === 'text_delta') {
      events.push({ kind: 'text_delta', text: event.delta });
    } else if (event.type === 'thinking_delta') {
      events.push({ kind: 'thinking_delta', text: event.delta });
    }
  }

  private queryResult(messages: unknown[], isError: boolean, error?: string): CanonicalEvent {
    const usage = usageFromMessages(messages);
    const latestError = error ?? latestAssistantError(messages);
    return {
      kind: 'query_result',
      sessionId: this.state.sessionId ?? '',
      isError: isError || Boolean(latestError),
      usage,
      ...(latestError ? { error: latestError } : {}),
    };
  }
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return { input };
}

function toolResultContent(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content;
    const text = messageContentText(content);
    if (text) return text;
  }
  return stringifyUnknown(result);
}

function usageFromMessages(messages: unknown[]): {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costUsd?: number;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let costUsd = 0;

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const typed = message as {
      role?: unknown;
      usage?: {
        input?: unknown;
        output?: unknown;
        cacheRead?: unknown;
        cacheWrite?: unknown;
        cost?: { total?: unknown };
      };
    };
    if (typed.role !== 'assistant' || !typed.usage) continue;
    inputTokens += numberValue(typed.usage.input);
    outputTokens += numberValue(typed.usage.output);
    cachedInputTokens += numberValue(typed.usage.cacheRead) + numberValue(typed.usage.cacheWrite);
    costUsd += numberValue(typed.usage.cost?.total);
  }

  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens ? { cachedInputTokens } : {}),
    ...(costUsd ? { costUsd } : {}),
  };
}

function latestAssistantError(messages: unknown[]): string | undefined {
  for (const message of [...messages].reverse()) {
    if (!message || typeof message !== 'object') continue;
    const typed = message as { role?: unknown; errorMessage?: unknown; stopReason?: unknown };
    if (typed.role !== 'assistant') continue;
    if (typeof typed.errorMessage === 'string' && typed.errorMessage.trim()) {
      return typed.errorMessage;
    }
    if (typed.stopReason === 'error') return 'Pi provider returned an error';
    if (typed.stopReason === 'aborted') return 'Interrupted';
  }
  return undefined;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function messageContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (!block || typeof block !== 'object') return '';
      const typed = block as { type?: unknown; text?: unknown; data?: unknown };
      if (typed.type === 'text' && typeof typed.text === 'string') return typed.text;
      if (typed.type === 'image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function stringifyUnknown(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
