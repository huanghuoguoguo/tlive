import { type CanonicalEvent, canonicalEventSchema } from '../../shared/canonical/schema.js';
import type { CodexAppServerNotification } from './codex-app-server.js';

interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export class CodexAppServerAdapter {
  private sessionId: string | undefined;
  private readonly emittedText = new Map<string, string>();
  private readonly toolOutput = new Map<string, string>();
  private readonly startedTools = new Set<string>();
  private readonly completedTools = new Set<string>();
  private usage: TokenUsage | undefined;
  private terminalEmitted = false;

  constructor(private readonly options: { sessionId?: string; model?: string } = {}) {
    this.sessionId = options.sessionId;
  }

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  setSessionId(sessionId: string): CanonicalEvent {
    this.sessionId = sessionId;
    return canonicalEventSchema.parse({
      kind: 'status',
      sessionId,
      ...(this.options.model ? { model: this.options.model } : {}),
    });
  }

  mapNotification(notification: CodexAppServerNotification): CanonicalEvent[] {
    const params = notification.params ?? {};
    const events: CanonicalEvent[] = [];

    switch (notification.method) {
      case 'item/started':
        this.mapStartedItem(recordField(params, 'item'), events);
        break;
      case 'item/completed':
        this.mapCompletedItem(recordField(params, 'item'), events);
        break;
      case 'item/agentMessage/delta':
        this.appendText(
          stringField(params, 'itemId'),
          stringField(params, 'delta'),
          'text_delta',
          events,
        );
        break;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        this.appendText(
          stringField(params, 'itemId'),
          stringField(params, 'delta'),
          'thinking_delta',
          events,
        );
        break;
      case 'item/commandExecution/outputDelta':
        this.appendCommandOutput(
          stringField(params, 'itemId'),
          stringField(params, 'delta'),
          events,
        );
        break;
      case 'turn/plan/updated':
        events.push({
          kind: 'todo_update',
          todos: arrayField(params, 'plan').map((entry) => {
            const step = asRecord(entry);
            return {
              content: stringField(step, 'step'),
              status: planStatus(step.status),
            };
          }),
        });
        break;
      case 'thread/tokenUsage/updated':
        this.rememberUsage(recordField(recordField(params, 'tokenUsage'), 'last'));
        break;
      case 'warning':
      case 'configWarning':
        // Warnings are advisory and must not terminate the active turn. The canonical event
        // protocol currently has no warning event, so leave them out of the event stream.
        break;
      case 'error': {
        const error = recordField(params, 'error');
        events.push({ kind: 'error', message: stringField(error, 'message') || 'Codex error' });
        break;
      }
      case 'turn/completed':
        events.push(this.mapTurnCompleted(recordField(params, 'turn')));
        this.terminalEmitted = true;
        break;
    }

    return events.map((event) => canonicalEventSchema.parse(event));
  }

  mapError(error: unknown, interrupted = false): CanonicalEvent[] {
    if (this.terminalEmitted) return [];
    this.terminalEmitted = true;
    return [
      canonicalEventSchema.parse(
        this.queryResult(true, interrupted ? 'Interrupted' : errorMessage(error)),
      ),
    ];
  }

  private mapStartedItem(item: Record<string, unknown>, events: CanonicalEvent[]): void {
    if (isToolItem(item)) this.emitToolStart(item, events);
    this.emitCompletedText(item, events);
  }

  private mapCompletedItem(item: Record<string, unknown>, events: CanonicalEvent[]): void {
    if (this.emitCompletedText(item, events)) return;
    if (!isToolItem(item)) return;
    this.emitToolStart(item, events);
    this.emitToolResult(item, events);
  }

  private emitCompletedText(item: Record<string, unknown>, events: CanonicalEvent[]): boolean {
    const id = stringField(item, 'id');
    if (item.type === 'agentMessage') {
      this.emitFullText(id, stringField(item, 'text'), 'text_delta', events);
      return true;
    }
    if (item.type === 'reasoning') {
      const text = [...arrayField(item, 'summary'), ...arrayField(item, 'content')]
        .filter((value): value is string => typeof value === 'string')
        .join('\n');
      this.emitFullText(id, text, 'thinking_delta', events);
      return true;
    }
    return false;
  }

  private appendText(
    itemId: string,
    delta: string,
    kind: 'text_delta' | 'thinking_delta',
    events: CanonicalEvent[],
  ): void {
    if (!itemId || !delta) return;
    this.emittedText.set(itemId, `${this.emittedText.get(itemId) ?? ''}${delta}`);
    events.push({ kind, text: delta });
  }

  private emitFullText(
    itemId: string,
    text: string,
    kind: 'text_delta' | 'thinking_delta',
    events: CanonicalEvent[],
  ): void {
    const previous = this.emittedText.get(itemId) ?? '';
    if (!text || text === previous) return;
    const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
    this.emittedText.set(itemId, text);
    if (delta) events.push({ kind, text: delta });
  }

  private emitToolStart(item: Record<string, unknown>, events: CanonicalEvent[]): void {
    const id = stringField(item, 'id');
    if (!id || this.startedTools.has(id)) return;
    this.startedTools.add(id);
    events.push({ kind: 'tool_start', id, name: toolName(item), input: toolInput(item) });
  }

  private appendCommandOutput(itemId: string, delta: string, events: CanonicalEvent[]): void {
    if (!itemId || !delta) return;
    const output = `${this.toolOutput.get(itemId) ?? ''}${delta}`;
    this.toolOutput.set(itemId, output);
    events.push({
      kind: 'tool_result',
      toolUseId: itemId,
      content: output.trimEnd(),
      isError: false,
      isFinal: false,
    });
  }

  private emitToolResult(item: Record<string, unknown>, events: CanonicalEvent[]): void {
    const id = stringField(item, 'id');
    if (!id || this.completedTools.has(id)) return;
    this.completedTools.add(id);
    events.push({
      kind: 'tool_result',
      toolUseId: id,
      content: toolResultContent(item, this.toolOutput.get(id)),
      isError: toolFailed(item),
      isFinal: true,
    });
  }

  private rememberUsage(usage: Record<string, unknown>): void {
    this.usage = {
      inputTokens: numberField(usage, 'inputTokens'),
      cachedInputTokens: numberField(usage, 'cachedInputTokens'),
      outputTokens: numberField(usage, 'outputTokens'),
      reasoningOutputTokens: numberField(usage, 'reasoningOutputTokens'),
    };
  }

  private mapTurnCompleted(turn: Record<string, unknown>): CanonicalEvent {
    const status = stringField(turn, 'status');
    const failed = status !== 'completed';
    const turnError = recordField(turn, 'error');
    const message =
      stringField(turnError, 'message') || (status === 'interrupted' ? 'Interrupted' : undefined);
    return this.queryResult(failed, message);
  }

  private queryResult(isError: boolean, error?: string): CanonicalEvent {
    return {
      kind: 'query_result',
      sessionId: this.sessionId ?? this.options.sessionId ?? '',
      isError,
      usage: {
        inputTokens: this.usage?.inputTokens ?? 0,
        outputTokens: this.usage?.outputTokens ?? 0,
        ...(this.usage ? { cachedInputTokens: this.usage.cachedInputTokens } : {}),
        ...(this.usage ? { reasoningOutputTokens: this.usage.reasoningOutputTokens } : {}),
      },
      ...(error ? { error } : {}),
    };
  }
}

function isToolItem(item: Record<string, unknown>): boolean {
  return (
    item.type === 'commandExecution' ||
    item.type === 'fileChange' ||
    item.type === 'mcpToolCall' ||
    item.type === 'webSearch'
  );
}

function toolName(item: Record<string, unknown>): string {
  if (item.type === 'commandExecution') return 'Bash';
  if (item.type === 'fileChange') return 'ApplyPatch';
  if (item.type === 'mcpToolCall')
    return `${stringField(item, 'server')}.${stringField(item, 'tool')}`;
  return 'WebSearch';
}

function toolInput(item: Record<string, unknown>): Record<string, unknown> {
  if (item.type === 'commandExecution') return { command: stringField(item, 'command') };
  if (item.type === 'fileChange') {
    const changes = arrayField(item, 'changes');
    return {
      path: changes.map((change) => stringField(asRecord(change), 'path')).join(', '),
      changes,
    };
  }
  if (item.type === 'mcpToolCall') {
    const args = item.arguments;
    return isRecord(args) ? args : { arguments: args };
  }
  return { query: stringField(item, 'query') };
}

function toolResultContent(item: Record<string, unknown>, streamedOutput?: string): string {
  if (item.type === 'commandExecution') {
    const output = stringField(item, 'aggregatedOutput') || streamedOutput || '(no output)';
    const exitCode = item.exitCode;
    return `${output}${typeof exitCode === 'number' ? `\nexit_code=${exitCode}` : ''}`;
  }
  if (item.type === 'fileChange') {
    return (
      arrayField(item, 'changes')
        .map((change) => {
          const record = asRecord(change);
          return `${stringField(record, 'kind')}: ${stringField(record, 'path')}`;
        })
        .join('\n') || stringField(item, 'status')
    );
  }
  if (item.type === 'mcpToolCall') {
    const error = recordField(item, 'error');
    if (Object.keys(error).length) return stringField(error, 'message') || stringifyUnknown(error);
    return stringifyUnknown(item.result ?? {});
  }
  return `query: ${stringField(item, 'query')}`;
}

function toolFailed(item: Record<string, unknown>): boolean {
  if (item.type === 'commandExecution') {
    return item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0);
  }
  if (item.type === 'fileChange' || item.type === 'mcpToolCall') {
    return item.status === 'failed' || item.status === 'declined' || Boolean(item.error);
  }
  return false;
}

function planStatus(value: unknown): 'pending' | 'in_progress' | 'completed' {
  if (value === 'completed') return 'completed';
  if (value === 'inProgress' || value === 'in_progress') return 'in_progress';
  return 'pending';
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return asRecord(value[key]);
}

function arrayField(value: Record<string, unknown>, key: string): unknown[] {
  return Array.isArray(value[key]) ? value[key] : [];
}

function stringField(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === 'string' ? value[key] : '';
}

function numberField(value: Record<string, unknown>, key: string): number {
  return typeof value[key] === 'number' ? value[key] : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringifyUnknown(value: unknown): string {
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
