import type { ThreadEvent, ThreadItem, Usage } from '@openai/codex-sdk';
import { canonicalEventSchema, type CanonicalEvent } from '../canonical/schema.js';

interface CodexAdapterState {
  threadId?: string;
  model?: string;
  emittedTextByItem: Map<string, string>;
  emittedToolOutputByItem: Map<string, string>;
  startedTools: Set<string>;
  completedTools: Set<string>;
  terminalEmitted: boolean;
}

export class CodexAdapter {
  private state: CodexAdapterState = {
    emittedTextByItem: new Map(),
    emittedToolOutputByItem: new Map(),
    startedTools: new Set(),
    completedTools: new Set(),
    terminalEmitted: false,
  };

  constructor(private readonly options: { sessionId?: string; model?: string } = {}) {
    this.state.threadId = options.sessionId;
    this.state.model = options.model;
  }

  reset(): void {
    const { threadId, model } = this.state;
    this.state = {
      threadId,
      model,
      emittedTextByItem: new Map(),
      emittedToolOutputByItem: new Map(),
      startedTools: new Set(),
      completedTools: new Set(),
      terminalEmitted: false,
    };
  }

  get sessionId(): string | undefined {
    return this.state.threadId;
  }

  mapEvent(event: ThreadEvent): CanonicalEvent[] {
    const events: CanonicalEvent[] = [];

    switch (event.type) {
      case 'thread.started':
        this.state.threadId = event.thread_id;
        events.push({
          kind: 'status',
          sessionId: event.thread_id,
          ...(this.state.model ? { model: this.state.model } : {}),
        });
        break;
      case 'turn.started':
        break;
      case 'item.started':
        this.mapStartedItem(event.item, events);
        break;
      case 'item.updated':
        this.mapUpdatedItem(event.item, events);
        break;
      case 'item.completed':
        this.mapCompletedItem(event.item, events);
        break;
      case 'turn.completed':
        events.push(this.queryResult(event.usage, false));
        this.state.terminalEmitted = true;
        break;
      case 'turn.failed':
        events.push(this.queryResult(undefined, true, event.error.message));
        this.state.terminalEmitted = true;
        break;
      case 'error':
        events.push({ kind: 'error', message: event.message });
        break;
    }

    return events.map((e) => canonicalEventSchema.parse(e));
  }

  mapError(error: unknown, interrupted = false): CanonicalEvent[] {
    if (this.state.terminalEmitted) return [];
    const message = interrupted ? 'Interrupted' : errorMessage(error);
    this.state.terminalEmitted = true;
    return [canonicalEventSchema.parse(this.queryResult(undefined, true, message))];
  }

  private mapStartedItem(item: ThreadItem, events: CanonicalEvent[]): void {
    if (this.isToolItem(item)) {
      this.emitToolStart(item, events);
    }
    if (item.type === 'todo_list') {
      this.emitTodoUpdate(item, events);
    }
  }

  private mapUpdatedItem(item: ThreadItem, events: CanonicalEvent[]): void {
    if (this.emitLiveItemUpdate(item, events)) return;
    if (item.type === 'command_execution') {
      this.emitToolStart(item, events);
      this.emitCommandOutputUpdate(item, events);
    }
  }

  private mapCompletedItem(item: ThreadItem, events: CanonicalEvent[]): void {
    if (this.emitLiveItemUpdate(item, events)) {
      return;
    }
    if (item.type === 'error') {
      events.push({ kind: 'error', message: item.message });
      return;
    }
    if (this.isToolItem(item)) {
      this.emitToolStart(item, events);
      this.emitToolResult(item, events, true);
    }
  }

  private emitLiveItemUpdate(item: ThreadItem, events: CanonicalEvent[]): boolean {
    if (this.emitTextItem(item, events)) return true;
    if (item.type !== 'todo_list') return false;
    this.emitTodoUpdate(item, events);
    return true;
  }

  private emitTextItem(item: ThreadItem, events: CanonicalEvent[]): boolean {
    if (item.type === 'agent_message') {
      this.emitTextDelta(item.id, item.text, 'text_delta', events);
      return true;
    }
    if (item.type === 'reasoning') {
      this.emitTextDelta(item.id, item.text, 'thinking_delta', events);
      return true;
    }
    return false;
  }

  private emitTextDelta(
    itemId: string,
    nextText: string,
    kind: 'text_delta' | 'thinking_delta',
    events: CanonicalEvent[],
  ): void {
    const previous = this.state.emittedTextByItem.get(itemId) ?? '';
    if (!nextText || nextText === previous) return;
    const delta = nextText.startsWith(previous) ? nextText.slice(previous.length) : nextText;
    this.state.emittedTextByItem.set(itemId, nextText);
    if (!delta) return;
    events.push({ kind, text: delta });
  }

  private emitToolStart(item: ToolThreadItem, events: CanonicalEvent[]): void {
    if (this.state.startedTools.has(item.id)) return;
    this.state.startedTools.add(item.id);
    events.push({
      kind: 'tool_start',
      id: item.id,
      name: toolName(item),
      input: toolInput(item),
    });
  }

  private emitCommandOutputUpdate(
    item: Extract<ToolThreadItem, { type: 'command_execution' }>,
    events: CanonicalEvent[],
  ): void {
    const output = item.aggregated_output.trimEnd();
    if (!output) return;
    const previous = this.state.emittedToolOutputByItem.get(item.id) ?? '';
    if (output === previous) return;
    this.state.emittedToolOutputByItem.set(item.id, output);
    events.push({
      kind: 'tool_result',
      toolUseId: item.id,
      content: output,
      isError: false,
      isFinal: false,
    });
  }

  private emitToolResult(item: ToolThreadItem, events: CanonicalEvent[], isFinal: boolean): void {
    if (this.state.completedTools.has(item.id)) return;
    this.state.completedTools.add(item.id);
    events.push({
      kind: 'tool_result',
      toolUseId: item.id,
      content: toolResultContent(item),
      isError: toolFailed(item),
      isFinal,
    });
  }

  private emitTodoUpdate(
    item: Extract<ThreadItem, { type: 'todo_list' }>,
    events: CanonicalEvent[],
  ): void {
    events.push({
      kind: 'todo_update',
      todos: item.items.map((todo) => ({
        content: todo.text,
        status: todo.completed ? 'completed' : 'pending',
      })),
    });
  }

  private isToolItem(item: ThreadItem): item is ToolThreadItem {
    return (
      item.type === 'command_execution' ||
      item.type === 'file_change' ||
      item.type === 'mcp_tool_call' ||
      item.type === 'web_search'
    );
  }

  private queryResult(usage: Usage | undefined, isError: boolean, error?: string): CanonicalEvent {
    return {
      kind: 'query_result',
      sessionId: this.state.threadId ?? this.options.sessionId ?? '',
      isError,
      usage: {
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        ...(usage?.cached_input_tokens !== undefined
          ? { cachedInputTokens: usage.cached_input_tokens }
          : {}),
        ...(usage?.reasoning_output_tokens !== undefined
          ? { reasoningOutputTokens: usage.reasoning_output_tokens }
          : {}),
      },
      ...(error ? { error } : {}),
    };
  }
}

type ToolThreadItem = Extract<
  ThreadItem,
  { type: 'command_execution' | 'file_change' | 'mcp_tool_call' | 'web_search' }
>;

function toolName(item: ToolThreadItem): string {
  switch (item.type) {
    case 'command_execution':
      return 'Bash';
    case 'file_change':
      return 'ApplyPatch';
    case 'mcp_tool_call':
      return `${item.server}.${item.tool}`;
    case 'web_search':
      return 'WebSearch';
  }
}

function toolInput(item: ToolThreadItem): Record<string, unknown> {
  switch (item.type) {
    case 'command_execution':
      return { command: item.command };
    case 'file_change':
      return {
        path: item.changes.map((change) => change.path).join(', '),
        changes: item.changes,
      };
    case 'mcp_tool_call':
      return isRecord(item.arguments) ? item.arguments : { arguments: item.arguments };
    case 'web_search':
      return { query: item.query };
  }
}

function toolResultContent(item: ToolThreadItem): string {
  switch (item.type) {
    case 'command_execution': {
      const exit = item.exit_code === undefined ? '' : `\nexit_code=${item.exit_code}`;
      return `${item.aggregated_output || '(no output)'}${exit}`;
    }
    case 'file_change':
      return (
        item.changes.map((change) => `${change.kind}: ${change.path}`).join('\n') || item.status
      );
    case 'mcp_tool_call':
      if (item.error) return item.error.message;
      return stringifyMcpResult(item.result);
    case 'web_search':
      return `query: ${item.query}`;
  }
}

function toolFailed(item: ToolThreadItem): boolean {
  switch (item.type) {
    case 'command_execution':
      return item.status === 'failed' || (item.exit_code !== undefined && item.exit_code !== 0);
    case 'file_change':
      return item.status === 'failed';
    case 'mcp_tool_call':
      return item.status === 'failed' || !!item.error;
    case 'web_search':
      return false;
  }
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stringifyMcpResult(value: unknown): string {
  if (!isRecord(value)) return stringifyUnknown(value ?? {});
  const content = value.content;
  if (Array.isArray(content)) {
    const text = content
      .map((block) => {
        if (!isRecord(block)) return '';
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
        return stringifyUnknown(block);
      })
      .filter(Boolean)
      .join('\n');
    if (text.trim()) return text;
  }
  if ('structured_content' in value) return stringifyUnknown(value.structured_content);
  return stringifyUnknown(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
