import type { SubagentSnapshot } from '../../shared/canonical/schema.js';

type TimelineEntry = SubagentSnapshot['timeline'][number];
type ChildStatus = SubagentSnapshot['status'];
type Mode = 'single' | 'parallel' | 'chain';
type RecordValue = Record<string, unknown>;

interface ChildState {
  snapshot: SubagentSnapshot;
  published?: string;
}

interface CallState {
  mode: Mode;
  children: Map<number, ChildState>;
  closed: boolean;
  declared: boolean;
}

/** Each call owns its slots; names, tasks and resumed sessions are never identity keys. */
export class PiSubagentMapper {
  private readonly calls = new Map<string, CallState>();

  start(parentToolUseId: string, args: unknown): SubagentSnapshot[] {
    if (!nonempty(parentToolUseId) || this.calls.has(parentToolUseId)) return [];
    const declaration = parseDeclaration(safeRecord(args));
    if (!declaration) return [];
    const call: CallState = {
      mode: declaration.mode,
      children: new Map(),
      closed: false,
      declared: true,
    };
    this.calls.set(parentToolUseId, call);
    return declaration.tasks.flatMap((task, index) => {
      const child = createChild(parentToolUseId, index, task.agent, task.task);
      call.children.set(index, child);
      return publish(child);
    });
  }

  update(
    parentToolUseId: string,
    args: unknown,
    payload: unknown,
    final = false,
    isError = false,
  ): SubagentSnapshot[] {
    if (!nonempty(parentToolUseId)) return [];
    const events = this.start(parentToolUseId, args);
    const result = safeRecord(payload);
    const details = safeRecord(result?.details);
    const results = Array.isArray(details?.results) ? details.results : [];
    let call = this.calls.get(parentToolUseId);
    if (call?.closed) return events;
    if (!call && isMode(details?.mode)) {
      call = { mode: details.mode, children: new Map(), closed: false, declared: false };
      this.calls.set(parentToolUseId, call);
    }
    if (!call) return events;

    const seen = new Set<number>();
    for (let index = 0; index < results.length; index++) {
      const childResult = safeRecord(results[index]);
      if (!childResult || !hasChildPayload(childResult)) continue;
      let child = call.children.get(index);
      if (!child) {
        // A declared invocation fixes the number of slots; injected extra results are ignored.
        if (call.declared || !nonempty(childResult.agent) || typeof childResult.task !== 'string') {
          continue;
        }
        child = createChild(parentToolUseId, index, childResult.agent, childResult.task);
        call.children.set(index, child);
      }
      seen.add(index);
      const flow = normalizeFlow(childResult.flow, child.snapshot.childId);
      const messages = normalizeMessages(
        childResult.messages,
        child.snapshot.childId,
        childResult.contextWindow,
      );
      // Flow owns live ordering/text. Completed assistant messages own usage; the extension's
      // flow has no model/usage metadata, so join only exact tool IDs, never positions or names.
      if (flow && messages) {
        const usageByTool = new Map(messages.filter((entry) => entry.toolId && entry.usage)
          .map((entry) => [entry.toolId, entry.usage]));
        for (const tool of flow.timeline) {
          const usage = tool.toolId ? usageByTool.get(tool.toolId) : undefined;
          if (usage) tool.usage = { ...usage };
        }
      }
      const timeline = flow?.timeline ?? messages;
      const status = resultStatus(
        childResult,
        flow?.status,
        final,
        isError && call.mode === 'single',
        child.snapshot.status,
      );
      const nextStatus = preserveTerminal(child.snapshot.status, status);
      const nextTimeline = timeline ?? child.snapshot.timeline;
      preserveToolStates(nextTimeline, child.snapshot.timeline);
      settleTools(nextTimeline, nextStatus);
      const error = childError(childResult, nextStatus);
      child.snapshot = {
        ...child.snapshot,
        status: nextStatus,
        timeline: nextTimeline,
        ...(error ? { error } : {}),
      };
      events.push(...publish(child));
    }

    if (final) {
      call.closed = true;
      for (const [index, child] of call.children) {
        if (seen.has(index) || terminal(child.snapshot.status)) continue;
        // Missing chain steps never ran, even when the parent reports an earlier step's failure.
        const status = call.mode === 'chain' || !isError ? 'interrupted' : 'failed';
        child.snapshot = {
          ...child.snapshot,
          status,
          ...(status === 'failed' ? { error: 'Parent subagent call failed' } : {}),
        };
        settleTools(child.snapshot.timeline, status);
        events.push(...publish(child));
      }
    }
    return events;
  }

  /** Close active children when the provider aborts without emitting tool_execution_end. */
  finish(status: 'failed' | 'interrupted', error?: string): SubagentSnapshot[] {
    const events: SubagentSnapshot[] = [];
    for (const call of this.calls.values()) {
      if (call.closed) continue;
      call.closed = true;
      for (const child of call.children.values()) {
        if (terminal(child.snapshot.status)) continue;
        child.snapshot = {
          ...child.snapshot,
          status: call.mode === 'chain' && child.snapshot.status === 'queued' ? 'interrupted' : status,
          ...(error ? { error } : {}),
        };
        settleTools(child.snapshot.timeline, child.snapshot.status);
        events.push(...publish(child));
      }
    }
    return events;
  }
}

function parseDeclaration(args: RecordValue | undefined):
  | { mode: Mode; tasks: { agent: string; task: string }[] }
  | undefined {
  if (!args) return undefined;
  const tasks = Array.isArray(args.tasks) && args.tasks.length > 0 ? args.tasks : undefined;
  const chain = Array.isArray(args.chain) && args.chain.length > 0 ? args.chain : undefined;
  const single = nonempty(args.agent) && (nonempty(args.task) || nonempty(args.resume));
  if (Number(Boolean(tasks)) + Number(Boolean(chain)) + Number(single) !== 1) return undefined;
  // Nullable/empty optional fields are common in strict-schema calls; wrong types are not modes.
  if (
    (args.tasks != null && !Array.isArray(args.tasks)) ||
    (args.chain != null && !Array.isArray(args.chain)) ||
    (args.agent != null && typeof args.agent !== 'string') ||
    (args.task != null && typeof args.task !== 'string') ||
    (args.resume != null && typeof args.resume !== 'string')
  ) {
    return undefined;
  }
  const items = tasks ?? chain;
  if (tasks && tasks.length > 8) return undefined; // Match the actual tool before publishing cards.
  if (items) {
    if (nonempty(args.agent) || nonempty(args.task) || nonempty(args.resume)) return undefined;
    const declarations: { agent: string; task: string }[] = [];
    for (const item of items) {
      const typed = safeRecord(item);
      if (!typed || !nonempty(typed.agent) || !nonempty(typed.task)) return undefined;
      declarations.push({ agent: typed.agent, task: typed.task });
    }
    return { mode: chain ? 'chain' : 'parallel', tasks: declarations };
  }
  if (!nonempty(args.agent)) return undefined;
  return {
    mode: 'single',
    tasks: [{ agent: args.agent, task: nonempty(args.task) ? args.task : 'continue the previous task' }],
  };
}

function createChild(parentToolUseId: string, index: number, agent: string, task: string): ChildState {
  return {
    snapshot: {
      kind: 'subagent_snapshot',
      parentToolUseId,
      childId: `${parentToolUseId}:subagent:${index}`,
      agentName: agent,
      task,
      status: 'queued',
      timeline: [],
    },
  };
}

function publish(child: ChildState): SubagentSnapshot[] {
  const encoded = JSON.stringify(child.snapshot);
  if (child.published === encoded) return [];
  child.published = encoded;
  // Consumers can mutate their copy without changing a later snapshot or our comparison state.
  return [JSON.parse(encoded) as SubagentSnapshot];
}

function normalizeFlow(
  value: unknown,
  childId: string,
): { status: ChildStatus; timeline: TimelineEntry[] } | undefined {
  const flow = safeRecord(value);
  if (flow?.version !== 1 || !isStatus(flow.status) || !Array.isArray(flow.timeline)) {
    return undefined;
  }
  const timeline: TimelineEntry[] = [];
  const blocks = new Set<string>();
  const tools = new Map<string, TimelineEntry>();
  for (let index = 0; index < flow.timeline.length; index++) {
    const entry = safeRecord(flow.timeline[index]);
    if (!entry) continue;
    if (entry.kind === 'text' || entry.kind === 'thinking') {
      if (typeof entry.text !== 'string') continue;
      const blockId = identity(childId, 'flow', nonempty(entry.blockId) ? entry.blockId : `block:${index}`);
      if (blocks.has(blockId)) continue;
      blocks.add(blockId);
      timeline.push({ kind: entry.kind, blockId, text: entry.text });
    } else if (entry.kind === 'tool') {
      if (!nonempty(entry.toolName) && !nonempty(entry.toolId)) continue;
      const sourceId = nonempty(entry.toolId)
        ? `id:${entry.toolId}`
        : nonempty(entry.blockId)
          ? `block:${entry.blockId}`
          : `anonymous:flow:${index}`;
      const toolId = identity(childId, 'tool', sourceId);
      const existing = tools.get(toolId);
      const inputData = safeRecord(entry.inputData);
      const tool: TimelineEntry = {
        kind: 'tool',
        blockId: identity(childId, 'tool-block', sourceId),
        toolId,
        toolName: typeof entry.toolName === 'string' ? entry.toolName : '',
        ...(inputData ? { inputData } : {}),
        ...(typeof entry.toolInput === 'string'
          ? { toolInput: entry.toolInput }
          : inputData
            ? { toolInput: JSON.stringify(inputData) }
            : {}),
        ...(typeof entry.toolResult === 'string' ? { toolResult: entry.toolResult } : {}),
        status: isToolStatus(entry.status) ? entry.status : 'running',
      };
      if (existing) {
        // A repeated tool ID is the same call, not another child or another attempt.
        const status = preserveTerminal(existing.status ?? 'running', tool.status ?? 'running');
        Object.assign(existing, tool, { status });
      } else {
        tools.set(toolId, tool);
        timeline.push(tool);
      }
    }
  }
  return { status: flow.status, timeline };
}

function normalizeMessages(
  value: unknown,
  childId: string,
  contextWindow: unknown,
): TimelineEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const timeline: TimelineEntry[] = [];
  const tools = new Map<string, TimelineEntry>();
  let step = 0;
  for (let messageIndex = 0; messageIndex < value.length; messageIndex++) {
    let message = safeRecord(value[messageIndex]);
    if (message?.type === 'message_end' || message?.type === 'tool_result_end') {
      message = safeRecord(message.message);
    }
    if (!message) continue;
    // Replay the cumulative child history rather than incrementing mapper state on refresh.
    // Every assistant gets a step (even without tools/usage); parallel calls share that step.
    if (message.role === 'assistant') step++;
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      const usage = messageUsage(message.usage, step, contextWindow);
      for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
        const block = safeRecord(message.content[blockIndex]);
        if (!block) continue;
        const position = `message:${messageIndex}:block:${blockIndex}`;
        if (block.type === 'thinking' && typeof block.thinking === 'string') {
          timeline.push({ kind: 'thinking', blockId: identity(childId, 'legacy', position), text: block.thinking });
        } else if (block.type === 'text' && typeof block.text === 'string') {
          timeline.push({ kind: 'text', blockId: identity(childId, 'legacy', position), text: block.text });
        } else if (block.type === 'toolCall' && nonempty(block.name)) {
          const sourceId = nonempty(block.id) ? `id:${block.id}` : `anonymous:${position}`;
          const tool = getTool(sourceId, childId, timeline, tools);
          tool.toolName = block.name;
          if (usage) tool.usage = { ...usage };
          const inputData = safeRecord(block.arguments);
          if (inputData) {
            tool.inputData = inputData;
            tool.toolInput = JSON.stringify(inputData);
          }
        }
      }
    } else if (message.role === 'toolResult') {
      const sourceId = nonempty(message.toolCallId)
        ? `id:${message.toolCallId}`
        : `anonymous:result:${messageIndex}`;
      const tool = getTool(sourceId, childId, timeline, tools);
      if (!tool.toolName && typeof message.toolName === 'string') tool.toolName = message.toolName;
      tool.toolResult = contentText(message.content);
      tool.status = preserveTerminal(
        tool.status ?? 'running',
        message.isError === true ? 'failed' : 'completed',
      ) as TimelineEntry['status'];
    }
  }
  return timeline;
}

/** Pi input excludes cached reads; cache writes are newly processed (uncached) input. */
function messageUsage(
  value: unknown,
  step: number,
  contextWindow: unknown,
): TimelineEntry['usage'] {
  const usage = safeRecord(value);
  if (!usage || !tokenCount(usage.input) || !tokenCount(usage.output)) return undefined;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  if (!tokenCount(cacheRead) || !tokenCount(cacheWrite)) return undefined;
  const inputTokens = usage.input + cacheWrite;
  const contextTokens = inputTokens + usage.output + cacheRead;
  if (!Number.isFinite(inputTokens) || !Number.isFinite(contextTokens)) return undefined;
  return {
    step,
    inputTokens,
    outputTokens: usage.output,
    contextTokens,
    // Only explicit child-result metadata is eligible. A model string alone cannot establish
    // its context limit, and the current extension does not publish a contextWindow at all.
    ...(tokenCount(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
  };
}

function tokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function getTool(
  sourceId: string,
  childId: string,
  timeline: TimelineEntry[],
  tools: Map<string, TimelineEntry>,
): TimelineEntry {
  const toolId = identity(childId, 'tool', sourceId);
  const existing = tools.get(toolId);
  if (existing) return existing;
  const tool: TimelineEntry = {
    kind: 'tool',
    blockId: identity(childId, 'tool-block', sourceId),
    toolId,
    toolName: '',
    status: 'running',
  };
  tools.set(toolId, tool);
  timeline.push(tool);
  return tool;
}

function resultStatus(
  result: RecordValue,
  flowStatus: ChildStatus | undefined,
  final: boolean,
  parentError: boolean,
  previous: ChildStatus,
): ChildStatus {
  if (flowStatus && terminal(flowStatus)) return flowStatus;
  if (!final) {
    if (flowStatus) return flowStatus;
    if (result.exitCode === -1 && Array.isArray(result.messages) && result.messages.length === 0) {
      return previous === 'queued' ? 'queued' : 'running';
    }
    // Old single mode initializes exitCode=0 while running. Only end/flow can finish a child.
    return 'running';
  }
  const reason = result.stopReason ?? latestStopReason(result.messages);
  if (reason === 'aborted' || reason === 'interrupted') return 'interrupted';
  if (
    reason === 'error' ||
    reason === 'timeout' ||
    nonempty(result.errorMessage) ||
    (typeof result.exitCode === 'number' && result.exitCode !== 0 && result.exitCode !== -1)
  ) {
    return 'failed';
  }
  if (result.exitCode === -1 || flowStatus === 'queued') return 'interrupted';
  if (parentError) return 'failed';
  return 'completed';
}

function childError(result: RecordValue, status: ChildStatus): string | undefined {
  if (status !== 'failed' && status !== 'interrupted') return undefined;
  if (nonempty(result.errorMessage)) return result.errorMessage;
  if (nonempty(result.stderr)) return result.stderr;
  if (Array.isArray(result.messages)) {
    for (const value of [...result.messages].reverse()) {
      const message = safeRecord(value);
      if (message?.role === 'assistant' && nonempty(message.errorMessage)) return message.errorMessage;
    }
  }
  return undefined;
}

function latestStopReason(messages: unknown): unknown {
  if (!Array.isArray(messages)) return undefined;
  for (const value of [...messages].reverse()) {
    const message = safeRecord(value);
    if (message?.role === 'assistant' && typeof message.stopReason === 'string') return message.stopReason;
  }
  return undefined;
}

function preserveToolStates(timeline: TimelineEntry[], previous: TimelineEntry[]): void {
  const oldTools = new Map(previous.filter((entry) => entry.toolId).map((entry) => [entry.toolId, entry]));
  for (const tool of timeline) {
    const old = tool.toolId ? oldTools.get(tool.toolId) : undefined;
    if (!old) continue;
    if (old.status && tool.status) {
      tool.status = preserveTerminal(old.status, tool.status) as TimelineEntry['status'];
    }
    if (tool.toolResult === undefined && old.toolResult !== undefined) tool.toolResult = old.toolResult;
    if (tool.usage === undefined && old.usage !== undefined) tool.usage = { ...old.usage };
  }
}

function settleTools(timeline: TimelineEntry[], status: ChildStatus): void {
  if (!terminal(status)) return;
  for (const entry of timeline) {
    if (entry.kind === 'tool' && entry.status === 'running') {
      entry.status = status === 'failed' ? 'failed' : 'interrupted';
    }
  }
}

function preserveTerminal(previous: ChildStatus, next: ChildStatus): ChildStatus {
  if (previous === 'failed' || previous === 'interrupted') return previous;
  if (previous === 'completed' && !terminal(next)) return previous;
  return next;
}

function terminal(status: ChildStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'interrupted';
}

function isStatus(value: unknown): value is ChildStatus {
  return value === 'queued' || value === 'running' || value === 'completed' || value === 'failed' || value === 'interrupted';
}

function isToolStatus(value: unknown): value is NonNullable<TimelineEntry['status']> {
  return isStatus(value) && value !== 'queued';
}

function isMode(value: unknown): value is Mode {
  return value === 'single' || value === 'parallel' || value === 'chain';
}

function hasChildPayload(result: RecordValue): boolean {
  return Array.isArray(result.messages) || safeRecord(result.flow)?.version === 1 || typeof result.exitCode === 'number' || typeof result.stopReason === 'string';
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function identity(childId: string, channel: string, sourceId: string): string {
  return `${childId}:${channel}:${JSON.stringify(sourceId)}`;
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.flatMap((block) => {
    if (typeof block === 'string') return [block];
    const typed = safeRecord(block);
    if (typed?.type === 'text' && typeof typed.text === 'string') return [typed.text];
    if (typed?.type === 'image') return ['[image]'];
    return [];
  }).join('\n');
}

/** Copy only JSON data: no getters, prototypes, circular references or mutable provider aliases. */
function safeRecord(value: unknown): RecordValue | undefined {
  const copy = jsonData(value, new Set(), 0);
  return copy && typeof copy === 'object' && !Array.isArray(copy) ? copy as RecordValue : undefined;
}

function jsonData(value: unknown, ancestors: Set<object>, depth: number): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (!value || typeof value !== 'object' || depth > 32 || ancestors.has(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return undefined;
    ancestors.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      const copy: unknown[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[index];
        copy.push(descriptor && 'value' in descriptor ? jsonData(descriptor.value, ancestors, depth + 1) ?? null : null);
      }
      return copy;
    }
    const copy: RecordValue = {};
    for (const key of Object.keys(descriptors).sort()) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !('value' in descriptor)) continue;
      const item = jsonData(descriptor.value, ancestors, depth + 1);
      if (item !== undefined) copy[key] = item;
    }
    return copy;
  } catch {
    return undefined;
  } finally {
    ancestors.delete(value);
  }
}
