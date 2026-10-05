import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PiSubagentMapper } from '../../client/providers/pi-subagents.js';
import { subagentSnapshotSchema } from '../../shared/canonical/schema.js';
import {
  encodeRemoteProtocolMessage,
  parseRemoteProtocolMessage,
} from '../../shared/protocol/messages.js';

const args = { agent: 'worker', task: 'usage fixture' };
const usage = { input: 100, output: 20, cacheRead: 300, cacheWrite: 40, totalTokens: 9999 };
const tool = (id: string) => ({
  type: 'toolCall', id, name: 'read', arguments: { path: `/${id}` },
});
const assistant = (ids: string[], counts: unknown = usage, timestamp = 1) => ({
  role: 'assistant', model: 'child-model', timestamp,
  usage: counts, content: ids.map(tool),
});
const payload = (child: Record<string, unknown>) => ({
  // These parent fields and cumulative child totals must never enter per-step accounting.
  model: 'parent-model', contextWindow: 999999,
  usage: { input: 999999, output: 999999 },
  details: { mode: 'single', results: [{
    agent: 'worker', task: args.task, exitCode: -1,
    usage: { input: 888888, output: 888888, turns: 50 }, ...child,
  }] },
});
function mapper() {
  const instance = new PiSubagentMapper();
  instance.start('parent', args);
  return instance;
}

// Load outside src dynamically: rootDir intentionally excludes packaged extension sources.
interface FixtureFlowState {
  flow: { timeline: Array<{ toolResult?: string }> };
}
const { collectSubagentEvent, createSubagentFlow } = await import(
  pathToFileURL(resolve('integrations/pi-subagent/flow.ts')).href
) as {
  createSubagentFlow: () => FixtureFlowState;
  collectSubagentEvent: (state: FixtureFlowState, event: unknown) => FixtureFlowState;
};

// Exercise the shipped read-only extension collector so tool-ID alignment is not a guessed fixture.
function liveFlow(messages: unknown[]) {
  let state = createSubagentFlow();
  for (const message of messages) {
    state = collectSubagentEvent(state, { type: 'message_end', message });
  }
  return state.flow;
}

describe('Pi child per-assistant tool usage', () => {
  it('aligns live flow by tool ID, shares parallel steps, excludes cached reads and round-trips schema', () => {
    const instance = mapper();
    const messages = [
      assistant(['a', 'b']),
      { role: 'toolResult', toolCallId: 'a', toolName: 'read', content: [] },
      assistant(['c'], { input: 10, output: 5, cacheRead: 6, cacheWrite: 7 }, 2),
    ];
    const flow = liveFlow(messages);
    // Ordering is owned by flow; usage is owned by messages, not corresponding array indexes.
    flow.timeline.reverse();
    const source = payload({ messages, flow, model: 'provider/child-model', contextWindow: 1000 });
    const original = structuredClone(source);
    const event = instance.update('parent', args, source)[0];
    const tools = event.timeline.filter((entry) => entry.kind === 'tool');
    expect(tools.map((entry) => entry.usage)).toEqual([
      { step: 2, inputTokens: 17, outputTokens: 5, contextTokens: 28, contextWindow: 1000 },
      { step: 1, inputTokens: 140, outputTokens: 20, contextTokens: 460, contextWindow: 1000 },
      { step: 1, inputTokens: 140, outputTokens: 20, contextTokens: 460, contextWindow: 1000 },
    ]);
    expect(source).toEqual(original);
    expect(instance.update('parent', args, source)).toEqual([]);
    expect(subagentSnapshotSchema.parse(event)).toEqual(event);
    const wire = encodeRemoteProtocolMessage({ type: 'turn.event', turnId: 'turn', event });
    expect(parseRemoteProtocolMessage(JSON.parse(wire))).toEqual({
      type: 'turn.event', turnId: 'turn', event,
    });
    tools[0].usage!.inputTokens = 123456;
    expect(source).toEqual(original);
    expect(instance.update('parent', args, source)).toEqual([]);
  });

  it('supports legacy messages and wrappers with the same stable assistant steps on refresh', () => {
    const instance = mapper();
    const firstMessage = assistant(['a', 'b']);
    const messages: unknown[] = [
      { role: 'user', content: 'Task' },
      { type: 'message_end', message: assistant([], undefined) },
      { type: 'message_end', message: firstMessage },
      { type: 'tool_result_end', message: {
        role: 'toolResult', toolCallId: 'a', toolName: 'read', content: [],
      } },
    ];
    const first = instance.update('parent', args, payload({ messages }))[0];
    expect(first.timeline.map((entry) => entry.usage)).toEqual([
      { step: 2, inputTokens: 140, outputTokens: 20, contextTokens: 460 },
      { step: 2, inputTokens: 140, outputTokens: 20, contextTokens: 460 },
    ]);
    expect(instance.update('parent', args, payload({ messages }))).toEqual([]);
    messages.push(assistant(['c'], { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, 3));
    const next = instance.update('parent', args, payload({ messages }))[0];
    expect(next.timeline.slice(0, 2)).toEqual(first.timeline);
    expect(next.timeline[2].usage).toEqual({
      step: 3, inputTokens: 5, outputTokens: 2, contextTokens: 10,
    });
  });

  it('backfills usage after live tools appear without guessing from flow, totals or parent metadata', () => {
    const instance = mapper();
    const message = assistant(['a', 'b']);
    const flow = liveFlow([message]);
    const first = instance.update('parent', args, payload({ messages: [], flow }))[0];
    expect(first.timeline.every((entry) => entry.usage === undefined)).toBe(true);
    const next = instance.update('parent', args, payload({ messages: [message], flow }))[0];
    expect(next.timeline.map((entry) => entry.blockId)).toEqual(first.timeline.map((entry) => entry.blockId));
    expect(next.timeline.map((entry) => entry.usage)).toEqual([
      { step: 1, inputTokens: 140, outputTokens: 20, contextTokens: 460 },
      { step: 1, inputTokens: 140, outputTokens: 20, contextTokens: 460 },
    ]);
    expect(first.timeline.every((entry) => entry.usage === undefined)).toBe(true);
    // A flow-only update may omit history; it must not lose already attributable usage.
    flow.timeline[0].toolResult = 'late result';
    const late = instance.update('parent', args, payload({ flow }))[0];
    expect(late.timeline[0].usage).toEqual(next.timeline[0].usage);
  });

  it('does not transfer usage by tool name, position or across children', () => {
    const instance = new PiSubagentMapper();
    const parallel = { tasks: [args, args] };
    instance.start('parallel', parallel);
    const snapshots = instance.update('parallel', parallel, {
      details: { mode: 'parallel', results: [
        { messages: [assistant(['a'])], flow: liveFlow([assistant(['unmatched'])]) },
        { messages: [assistant(['a'], { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 })] },
      ] },
    });
    expect(snapshots[0].timeline[0].usage).toBeUndefined();
    expect(snapshots[1].timeline[0].usage).toEqual({
      step: 1, inputTokens: 1, outputTokens: 2, contextTokens: 3,
    });
    expect(snapshots[0].timeline[0].toolId).not.toBe(snapshots[1].timeline[0].toolId);
  });

  it.each([null, {}, { input: 1 }, { input: -1, output: 2 }, { input: '1', output: 2 }])(
    'omits incomplete/invalid usage %j instead of inventing values', (counts) => {
      const event = mapper().update('parent', args, payload({ messages: [assistant(['a'], counts)] }))[0];
      expect(event.timeline[0].usage).toBeUndefined();
    },
  );

  it.each([undefined, 0, -1, '1000', { contextWindow: 1000 }])(
    'does not infer a child window from a model string or invalid contextWindow %j', (contextWindow) => {
      const event = mapper().update('parent', args, payload({
        messages: [assistant(['a'])], model: 'parent-or-child-model', contextWindow,
      }))[0];
      expect(event.timeline[0].usage).toEqual({
        step: 1, inputTokens: 140, outputTokens: 20, contextTokens: 460,
      });
    },
  );

  it('retains real all-zero usage instead of mistaking it for missing metadata', () => {
    const event = mapper().update('parent', args, payload({ messages: [assistant(['a'], {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    })] }))[0];
    expect(event.timeline[0].usage).toEqual({ step: 1, inputTokens: 0, outputTokens: 0, contextTokens: 0 });
  });
});
