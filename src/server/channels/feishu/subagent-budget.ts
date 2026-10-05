import type { StepUsage } from '../../../shared/canonical/schema.js';
import { stepUsageSuffix } from './step-usage.js';
import {
  type CardObject,
  type FeishuCardBudget,
  fitsFeishuCard,
  measureFeishuCard,
  resolveFeishuCardBudget,
} from './card-budget.js';

/** Chronological semantic ownership, kept outside the Feishu JSON. */
export interface SubagentCardChunk {
  kind: 'thinking' | 'tool' | 'text';
  elementIds: string[];
  toolName?: string;
  status?: string;
  usage?: StepUsage;
}

const CHILD_ARRAYS = ['elements', 'columns', 'actions'] as const;
const WRAPPERS = new Set(['collapsible_panel', 'column_set', 'column', 'action', 'form']);
const TRUNCATED = '[较早内容已截断]\n';
type Failure = 'failed' | 'interrupted';
interface ToolTally { name: string; count: number; failures: number; interruptions: number; running: number; usages: StepUsage[]; }
function tally(name: string, status?: string, usage?: StepUsage): ToolTally {
  const failure = failureOf(status);
  return { name, count: 1, failures: failure === 'failed' ? 1 : 0,
    interruptions: failure === 'interrupted' ? 1 : 0, running: status === 'running' ? 1 : 0, usages: usage ? [{ ...usage }] : [] };
}
function mergedTallies(values: readonly ToolTally[]): ToolTally[] {
  const result = new Map<string, ToolTally>();
  for (const value of values) {
    const existing = result.get(value.name);
    if (!existing) result.set(value.name, { ...value, usages: [...value.usages] });
    else { existing.count += value.count; existing.failures += value.failures;
      existing.interruptions += value.interruptions; existing.running += value.running; existing.usages.push(...value.usages); }
  }
  return [...result.values()];
}
function tallyText(values: readonly ToolTally[]): string {
  return mergedTallies(values).map(value => [
    value.name + (value.count > 1 ? ` ×${value.count}` : ''),
    value.failures ? `❌失败${value.failures}` : '',
    value.interruptions ? `⏹中断${value.interruptions}` : '',
    value.running ? `⏳执行中${value.running}` : '',
  ].filter(Boolean).join(' · ')).join('；');
}

/** A single compact history row, not a tower of bare tool names. */
function toolSummary(values: readonly ToolTally[], id?: string): CardObject {
  const count = values.reduce((total, value) => total + value.count, 0);
  const usage = stepUsageSuffix(values.flatMap((value) => value.usages.map((usage) => ({ usage }))));
  return { tag: 'markdown', content: `**历史工具 · ${count} 次**${usage}\n${literal(tallyText(values))}`,
    ...(id ? { element_id: id } : {}) };
}

function failureOf(status?: string): Failure | undefined {
  if (status && /^(failed|failure|error)$/i.test(status)) return 'failed';
  if (status && /^(interrupted|cancelled|canceled|aborted|stopped)$/i.test(status))
    return 'interrupted';
  return undefined;
}

function failureLabel(failure: Failure): string {
  return failure === 'failed' ? '❌ 失败 (failed)' : '⚠️ 已中断 (interrupted)';
}

/** Escape literal previews, including table pipes, fences, links and Feishu inline tags. */
function literal(text: string): string {
  return text.replace(/[\\`*_{}[\]()<>#!|~+\-.]/g, '\\$&');
}

function textElement(content: string, id?: string): CardObject {
  return { tag: 'markdown', content: literal(content), ...(id ? { element_id: id } : {}) };
}

function bodyElements(card: CardObject): CardObject[] {
  return card.body?.elements ?? card.elements ?? [];
}

function setBodyElements(card: CardObject, elements: CardObject[]): void {
  if (card.body) card.body.elements = elements;
  else card.elements = elements;
}

function arrays(node: CardObject): Array<{ owner: CardObject; key: string; nodes: CardObject[] }> {
  const result: Array<{ owner: CardObject; key: string; nodes: CardObject[] }> = [];
  for (const key of CHILD_ARRAYS) {
    if (Array.isArray(node[key])) result.push({ owner: node, key, nodes: node[key] });
  }
  if (node.body && Array.isArray(node.body.elements))
    result.push({ owner: node.body, key: 'elements', nodes: node.body.elements });
  return result;
}

function matches(node: CardObject, ids: ReadonlySet<string>): boolean {
  // A div's text/title IDs denote the owning semantic component, not a dangling text object.
  return (
    ids.has(node.element_id) ||
    ids.has(node.text?.element_id) ||
    ids.has(node.header?.title?.element_id)
  );
}

function selectedNodes(card: CardObject, ids: ReadonlySet<string>): CardObject[] {
  const result: CardObject[] = [];
  const visit = (nodes: CardObject[]): void => {
    for (const node of nodes) {
      if (matches(node, ids)) result.push(node);
      else for (const child of arrays(node)) visit(child.nodes);
    }
  };
  visit(bodyElements(card));
  return result;
}

/** Only display text: never callbacks, button labels, wrapper titles or hidden payloads. */
function displayText(node: CardObject): string {
  if (node.tag === 'button') return '';
  const own =
    typeof node.content === 'string'
      ? node.content
      : typeof node.text?.content === 'string'
        ? node.text.content
        : '';
  return [own, ...arrays(node).flatMap((child) => child.nodes.map(displayText))]
    .filter(Boolean)
    .join('\n');
}

function replaceNodes(
  card: CardObject,
  ids: ReadonlySet<string>,
  replacement?: CardObject,
): boolean {
  let found = false;
  const visit = (nodes: CardObject[]): CardObject[] =>
    nodes.flatMap((node) => {
      if (matches(node, ids)) {
        const first = !found;
        found = true;
        return first && replacement ? [replacement] : [];
      }
      for (const child of arrays(node)) child.owner[child.key] = visit(child.nodes);
      return [node];
    });
  setBodyElements(card, visit(bodyElements(card)));
  return found;
}

/** Empty groups disappear; all-reduced groups need neither a title nor a folded wrapper. */
function clean(
  card: CardObject,
  reduced: Map<CardObject, 'tool' | 'text'>,
  failed: Set<CardObject>,
  tallies: Map<CardObject, ToolTally[]>,
): void {
  const visit = (nodes: CardObject[]): CardObject[] => {
    const result: CardObject[] = [];
    for (const node of nodes) {
      for (const child of arrays(node)) child.owner[child.key] = visit(child.nodes);
      const children = arrays(node).flatMap((child) => child.nodes);
      if (WRAPPERS.has(node.tag)) {
        if (!children.length) continue;
        if (children.every((child) => reduced.has(child))) {
          result.push(...children);
          continue;
        }
      }
      // Failure summaries must remain visible even in a partly retained tool group.
      if (node.tag === 'collapsible_panel' && children.some(hasFailure)) node.expanded = true;
      result.push(node);
    }
    // Count same names inside adjacent simplified regions, keeping first-seen order.
    const merged: CardObject[] = [];
    for (const node of result) {
      const previous = merged.at(-1);
      if (previous && reduced.get(previous) === 'tool' && reduced.get(node) === 'tool') {
        const counts = mergedTallies([...(tallies.get(previous) ?? []), ...(tallies.get(node) ?? [])]);
        tallies.set(previous, counts);
        previous.content = toolSummary(counts).content;
        if (failed.has(node)) failed.add(previous);
      } else merged.push(node);
    }
    return merged;
  };
  const hasFailure = (node: CardObject): boolean =>
    failed.has(node) || arrays(node).some((child) => child.nodes.some(hasFailure));
  setBodyElements(card, visit(bodyElements(card)));
}

function toolName(chunk: SubagentCardChunk, nodes: CardObject[]): string {
  if (chunk.toolName !== undefined) return chunk.toolName;
  for (const node of nodes) {
    const heading = displayText(node).split('\n')[0] ?? '';
    const boldName = heading.match(/\*\*([^\n]+?)\*\*/)?.[1];
    if (boldName) return boldName;
  }
  // Missing metadata is not permission to invent a name or retain tool parameters.
  return '工具（名称未提供）';
}

function suffix(text: string, length: number): string {
  let start = Math.max(0, text.length - length);
  if (
    start > 0 &&
    /[\uDC00-\uDFFF]/.test(text[start] ?? '') &&
    /[\uD800-\uDBFF]/.test(text[start - 1])
  )
    start++;
  return text.slice(start);
}

/** Finite binary search on literal text: bytes increase monotonically, tables stay at zero. */
function fitTail(
  node: CardObject,
  source: string,
  prefix: string,
  fits: () => boolean,
): boolean {
  node.content = literal(prefix);
  if (!fits()) return false;
  let low = 0;
  let high = source.length;
  while (low < high) {
    const middle = low + Math.ceil((high - low) / 2);
    node.content = literal(prefix + suffix(source, middle));
    if (fits()) low = middle;
    else high = middle - 1;
  }
  node.content = literal(prefix + suffix(source, low));
  return fits();
}

interface SourceChunk {
  chunk: SubagentCardChunk;
  text: string;
  name: string;
  failure?: Failure;
  present: boolean;
}

/** Minimal JSON envelope, not a stash of the original card in config/extra properties. */
function envelope(card: CardObject, element: CardObject, keepConfig: boolean): CardObject {
  const result: CardObject = {};
  if (card.schema !== undefined) result.schema = card.schema;
  if (card.header !== undefined) result.header = structuredClone(card.header);
  if (keepConfig && card.config) {
    const config: CardObject = {};
    for (const key of ['update_multi', 'wide_screen_mode', 'streaming_mode']) {
      if (typeof card.config[key] === 'boolean') config[key] = card.config[key];
    }
    if (Object.keys(config).length) result.config = config;
  }
  if (card.body) result.body = { elements: [element] };
  else result.elements = [element];
  return result;
}

/**
 * Lossy DISPLAY reducer for a single subagent progress card, never the main-card planner.
 * Source model data and detail snapshots are owned by the caller. No SDK calls, pagination,
 * unknown Feishu metadata, or full-text payloads hidden in the returned JSON.
 */
export function compactSubagentCard(
  card: CardObject,
  chunks: readonly SubagentCardChunk[],
  budget: FeishuCardBudget,
): CardObject {
  budget = resolveFeishuCardBudget(budget);
  const output: CardObject = structuredClone(card);
  const fits = (): boolean => fitsFeishuCard(output, budget);
  if (fits()) return output;

  const owned = new Set(chunks.flatMap((chunk) => chunk.elementIds));
  const sources: SourceChunk[] = chunks.map((chunk) => {
    const nodes = selectedNodes(card, new Set(chunk.elementIds));
    return {
      chunk,
      present: nodes.length > 0,
      text: nodes.map(displayText).filter(Boolean).join('\n'),
      name: chunk.kind === 'tool' ? toolName(chunk, nodes) : '',
      failure: failureOf(chunk.status),
    };
  });
  const reduced = new Map<CardObject, 'tool' | 'text'>();
  const tallies = new Map<CardObject, ToolTally[]>();
  const failed = new Set<CardObject>();

  // A tool that cannot fit even by itself must be reduced before we sacrifice unrelated
  // history. Otherwise a giant last stdout first erases every earlier thought/text/tool.
  for (const source of sources) {
    if (source.chunk.kind !== 'tool' || !source.present) continue;
    const ids = new Set(source.chunk.elementIds);
    const nodes = selectedNodes(output, ids);
    const isolated = envelope(card, { tag: 'column', elements: nodes }, false);
    if (fitsFeishuCard(isolated, budget)) continue;
    const counts = [tally(source.name, source.chunk.status, source.chunk.usage)];
    const replacement = toolSummary(counts, nodes[0]?.element_id);
    reduced.set(replacement, 'tool');
    tallies.set(replacement, counts);
    if (source.failure) failed.add(replacement);
    replaceNodes(output, ids, replacement);
  }
  clean(output, reduced, failed, tallies);
  if (fits()) return output;

  // One pass, oldest first. Each committed semantic downgrade checks the exact final JSON.
  for (const source of sources) {
    const { chunk, failure } = source;
    const ids = new Set(chunk.elementIds);
    const nodes = selectedNodes(output, ids);
    if (!nodes.length || nodes.every((node) => reduced.get(node) === 'tool')) continue;
    const id = nodes[0].element_id;
    let replacement: CardObject | undefined;
    if (chunk.kind === 'tool') {
      const counts = [tally(source.name, chunk.status, chunk.usage)];
      replacement = toolSummary(counts, id);
      tallies.set(replacement, counts);
      reduced.set(replacement, 'tool');
    } else if (chunk.kind === 'text') {
      replacement = textElement(TRUNCATED, id);
      reduced.set(replacement, 'text');
    } else if (failure) {
      // Remove the thought and its buttons, but not the only indication of a terminal failure.
      replacement = textElement(failureLabel(failure), id);
      reduced.set(replacement, 'text');
    }
    if (failure && replacement) failed.add(replacement);
    replaceNodes(output, ids, replacement);
    clean(output, reduced, failed, tallies);
    if (chunk.kind === 'text' && replacement) {
      const status = failure ? `${failureLabel(failure)}\n` : '';
      // Table/fence-heavy blocks can fit intact after literalization; don't falsely claim a cut.
      replacement.content = literal(`${status}[纯文本预览]\n${source.text}`);
      if (fits()) return output;
      if (fitTail(replacement, source.text, status + TRUNCATED, fits)) return output;
      // No tail could survive. Do not retain repeated empty truncation blocks between tools;
      // these are display-only omissions, and the model timeline stays untouched.
      if (!failure) replaceNodes(output, ids);
      clean(output, reduced, failed, tallies);
    }
    if (fits()) return output;
  }

  // Extreme pressure: a single literal preview removes per-chunk/wrapper overhead. Restore
  // text ONLY in local memory so a new giant block still gets the longest possible suffix.
  const supplemental = structuredClone(card);
  replaceNodes(supplemental, owned);
  const extra = bodyElements(supplemental).map(displayText).filter(Boolean).join('\n');
  const present = sources.filter((source) => source.present);
  const toolCount = present.filter((source) => source.chunk.kind === 'tool').length;
  let failures = present.filter((source) => source.failure === 'failed').length;
  let interruptions = present.filter((source) => source.failure === 'interrupted').length;
  if (!failures && /❌|失败|\b(?:failed|failure|error)\b/i.test(extra)) failures = 1;
  if (!interruptions && /中断|已停止|\b(?:interrupted|cancelled|canceled|stopped)\b/i.test(extra))
    interruptions = 1;
  const state = [
    failures ? `失败 ${failures}` : '',
    interruptions ? `中断 ${interruptions}` : '',
  ].filter(Boolean).join(' · ');
  const minimalState = [failures ? '失败' : '', interruptions ? '中断' : '']
    .filter(Boolean).join('/');
  const previewParts: string[] = [];
  let pendingTools: ToolTally[] = [];
  const flushTools = (): void => {
    if (pendingTools.length) previewParts.push(tallyText(pendingTools));
    pendingTools = [];
  };
  for (const source of present) {
    if (source.chunk.kind === 'thinking') continue;
    if (source.chunk.kind === 'tool') pendingTools.push(tally(source.name, source.chunk.status, source.chunk.usage));
    else { flushTools(); previewParts.push(source.text); }
  }
  flushTools();
  previewParts.push(extra);
  const preview = previewParts.filter(Boolean).join('\n');
  const prefixes = [
    `[较早内容已截断/省略${toolCount ? `；工具 ${toolCount} 次` : ''}]\n${state ? `${state}\n` : ''}`,
    `[省略]${minimalState ? ` ${minimalState}` : ''}\n`,
  ];
  let smallest: CardObject | undefined;
  for (const keepConfig of [true, false]) {
    for (const prefix of prefixes) {
      const element = textElement(prefix);
      const candidate = envelope(card, element, keepConfig);
      smallest = candidate;
      if (fitTail(element, preview, prefix, () => fitsFeishuCard(candidate, budget)))
        return candidate;
    }
  }
  throw new Error(
    `Subagent card minimum legal envelope cannot fit budget: ${JSON.stringify({
      budget,
      measurement: measureFeishuCard(smallest),
    })}`,
  );
}
