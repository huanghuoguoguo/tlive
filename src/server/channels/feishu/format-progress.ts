/** Lossless block-format progress cards; phase-summary formatting remains opt-in legacy. */
import type { Locale } from '../../../shared/i18n/index.js';
import { t } from '../../../shared/i18n/index.js';
import type { ProgressData } from '../../../shared/formatting/message-types.js';
import { stepUsageSuffix } from './step-usage.js';
import { truncate } from '../../../shared/core/string.js';
import { shortPath } from '../../../shared/core/path.js';
import { TODO_MARKERS } from '../../../shared/canonical/plan-signature.js';
import type { FeishuCardElement } from './card-builder.js';
import type { SubagentCardChunk } from './subagent-budget.js';
import { buttonElements, codeBlockElement, collapsiblePanel, markdownElement } from './card-elements.js';
import { redactSensitiveContent } from '../../../shared/utils/content-filter.js';
import { thinkingSegments, thinkingTail, type ThinkingSegment } from './thinking-preview.js';
import {
  buildProgressTimelineElements as buildLegacyTimelineElements,
  buildProgressContentElements as buildLegacyContentElements,
} from './format-progress-legacy.js';
import {
  buildFlowBlocks,
  collectFlowItems,
  isFlowTerminal,
  type FlowOptions,
  type FlowTextBlock,
  type FlowToolBlock,
  type FlowBlock,
} from './flow-blocks.js';
import {
  createDefaultToolDisplayRegistry,
  flowElementId,
  flowStatusLabel,
  isOversizedToolResult,
} from './tool-display.js';
import {
  LIVE_WRITE_BODY_ELEMENT_ID,
  LIVE_WRITE_LINE_ELEMENT_ID,
  PLAN_BOARD_ELEMENT_ID,
  PROGRESS_ELAPSED_ELEMENT_ID,
} from './progress-identity.js';

export { progressHeaderConfig } from './format-progress-legacy.js';
export type { FlowOptions } from './flow-blocks.js';

export interface FormatProgressParams {
  chatId: string;
  data: ProgressData;
  md: (content: string) => FeishuCardElement;
  locale: Locale;
  flowOptions?: FlowOptions;
  /** Register the full semantic block before removing history from the serialized card. */
  registerThinkingDetails?: (block: FlowTextBlock) => string | undefined;
  /** Called after ID-based result updates are merged; receives the complete semantic call. */
  registerToolDetails?: (block: FlowToolBlock) => string | undefined;
  /** A child may reuse a failed tool's full result as errorMessage; do not inline it twice. */
  retainedToolResults?: ReadonlySet<string>;
  subagentChunks?: SubagentCardChunk[];
}

/** The exact semantic text IDs used by the block renderer, including nested thoughts. */
export function progressStreamingElementIds(
  data: ProgressData,
  options: FlowOptions = {},
  bounded = true,
): string[] {
  // Identity does not depend on grouping. Do not invoke an exact tokenizer twice per flush.
  const items = collectFlowItems(data, options.registry ?? createDefaultToolDisplayRegistry());
  if (isFlowTerminal(data) && data.completedTraceOnly) {
    while (items[items.length - 1]?.kind === 'text') items.pop();
  }
  const window = thinkingWindow(
    items.filter((item): item is FlowTextBlock => item.kind === 'thinking'),
    bounded,
  );
  return items.flatMap((item) => {
    if (item.kind === 'tool' || !item.text.trim()) return [];
    const identity = item.id ?? item.kind;
    if (item.kind === 'text') return [flowElementId('text', identity)];
    return (window.segments.get(identity) ?? []).map((segment) =>
      flowElementId('text', `${identity}#${segment.index}`),
    );
  });
}

/**
 * Feishu animates an appended tail and treats any other change as a rewrite: the client wipes the
 * block and retypes it. So a thought on the card is a list of whole segments that only ever gains a
 * new one at the end and loses one at the front — never a re-cut of text already on screen.
 */
const THINKING_VISIBLE_SEGMENTS = 2;

interface ThinkingWindow {
  /** Identity to its published segments, in card order. */
  segments: Map<string, ThinkingSegment[]>;
  /** Identities whose text is not all on the card. */
  truncated: Set<string>;
}

function thinkingWindow(thoughts: readonly FlowTextBlock[], bounded: boolean): ThinkingWindow {
  const segments = new Map<string, ThinkingSegment[]>();
  const truncated = new Set<string>();
  const all: Array<{ identity: string; segment: ThinkingSegment }> = [];
  const totals = new Map<string, number>();
  for (const block of thoughts) {
    const identity = block.id ?? block.kind;
    // Redact before cutting: a segment boundary through a credential must not defeat redaction.
    const cut = bounded
      ? thinkingSegments(redactSensitiveContent(block.text))
      : [{ index: 0, text: block.text }];
    totals.set(identity, (totals.get(identity) ?? 0) + cut.length);
    for (const segment of cut) all.push({ identity, segment });
  }
  for (const entry of bounded ? all.slice(Math.max(0, all.length - THINKING_VISIBLE_SEGMENTS)) : all) {
    const held = segments.get(entry.identity);
    if (held) held.push(entry.segment);
    else segments.set(entry.identity, [entry.segment]);
  }
  for (const [identity, total] of totals) {
    if ((segments.get(identity)?.length ?? 0) < total) truncated.add(identity);
  }
  return { segments, truncated };
}

/**
 * A thought may shed text only while the full block is still reachable through its detail panel;
 * with nowhere else to go the card keeps publishing all of it. The renderer and the streaming ID
 * list must reach the same answer, so `retained` asks whether a store is wired up at all — one that
 * later refuses a block costs that thought its button, not the card's stability.
 */
export function thinkingIsBounded(data: ProgressData, retained: boolean): boolean {
  return retained && Boolean(data.turnId);
}

/** Thoughts in card order. Nesting moves a thought into a group but never reorders it. */
function thoughtBlocks(blocks: readonly FlowBlock[]): FlowTextBlock[] {
  return blocks.flatMap((block) =>
    block.kind === 'tool_group'
      ? block.children.filter((child): child is FlowTextBlock => child.kind === 'thinking')
      : block.kind === 'thinking'
        ? [block]
        : [],
  );
}

function thinkingDetailIds(
  thoughts: readonly FlowTextBlock[],
  params: FormatProgressParams,
): Map<FlowTextBlock, string> {
  const detailIds = new Map<FlowTextBlock, string>();
  for (const block of thoughts) {
    const id = params.registerThinkingDetails?.(block);
    if (id) detailIds.set(block, id);
  }
  return detailIds;
}

function textElements(
  block: FlowTextBlock,
  params: FormatProgressParams,
  details: Map<FlowTextBlock, string>,
  window: ThinkingWindow,
): FeishuCardElement[] {
  if (!block.text.trim()) return [];
  const identity = block.id ?? block.kind;
  if (block.kind === 'text') {
    // Model prose is never capped: params.md only redacts and downgrades headings.
    const element = { ...params.md(block.text), element_id: flowElementId('text', identity) };
    params.subagentChunks?.push({ kind: 'text', elementIds: [element.element_id as string] });
    return [element];
  }
  const children: FeishuCardElement[] = (window.segments.get(identity) ?? []).map((segment) => ({
    ...params.md(segment.text),
    element_id: flowElementId('text', `${identity}#${segment.index}`),
  }));
  const detailId = details.get(block);
  if (detailId && window.truncated.has(identity)) {
    children.push(...buttonElements([{
      label: params.locale === 'zh' ? '查看完整思考' : 'View full thinking',
      callbackData: `flow_detail:open:${detailId}`,
    }]));
  }
  // A starved thought with no reachable history has nothing left to show.
  if (!children.length) return [];
  params.subagentChunks?.push({ kind: 'thinking', elementIds: [flowElementId('thinking', identity)] });
  return [{
    ...collapsiblePanel(
      `${flowStatusLabel(block.status, params.locale)} · ${t('progress.labelThinkingProcess', params.locale)}`,
      children,
      { expanded: block.status === 'running' },
    ),
    element_id: flowElementId('thinking', identity),
  }];
}

export function buildProgressTimelineElements(params: FormatProgressParams): FeishuCardElement[] {
  if (params.flowOptions?.mode === 'legacy') return buildLegacyTimelineElements(params);
  const registry = params.flowOptions?.registry ?? createDefaultToolDisplayRegistry();
  const blocks = buildFlowBlocks(params.data, { ...params.flowOptions, registry });
  const thoughts = thoughtBlocks(blocks);
  const details = thinkingDetailIds(thoughts, params);
  const window = thinkingWindow(
    thoughts,
    thinkingIsBounded(params.data, params.registerThinkingDetails !== undefined),
  );
  const elements: FeishuCardElement[] = [];
  for (const block of blocks) {
    if (block.kind !== 'tool_group') {
      elements.push(...textElements(block, params, details, window));
      continue;
    }
    const children: FeishuCardElement[] = [];
    const failures: Array<{ id: string; text: string }> = [];
    const tools = block.children.filter((child) => child.kind === 'tool');
    for (const child of block.children) {
      if (child.kind === 'tool') {
        const oversized = isOversizedToolResult(child.toolResult);
        const needsDetail = oversized || child.category === 'editing';
        let detailId = oversized ? undefined : child.detailId;
        if (needsDetail && params.registerToolDetails) {
          try {
            detailId = params.registerToolDetails(child);
          } catch {
            detailId = undefined;
          }
        }
        const display = registry.display(
          {
            ...child,
            detailId: oversized ? undefined : detailId,
            // Only a successful registration permits removing the full result from the card.
            resultDetailId: oversized ? detailId : undefined,
          },
          params.locale,
        );
        children.push(...display.elements);
        params.subagentChunks?.push({
          kind: 'tool',
          elementIds: display.elements.map((node) => node.element_id as string),
          toolName: child.toolName,
          status: child.status,
          usage: child.usage,
        });
        if (display.failureSummary) failures.push({ id: child.id, text: display.failureSummary });
      } else {
        children.push(...textElements(child, params, details, window));
      }
    }
    const status = block.children.some((child) => child.status === 'failed')
      ? 'failed'
      : block.children.some((child) => child.status === 'interrupted')
        ? 'interrupted'
        : block.expanded
          ? 'running'
          : 'completed';
    const names = [...new Set(tools.map((tool) => tool.toolName))].join(' / ');
    const count = tools.length > 1 ? ` (${tools.length})` : '';
    elements.push({
      ...collapsiblePanel(
        `${flowStatusLabel(status, params.locale)} · ${names}${count}${stepUsageSuffix(tools)}`,
        children,
        { expanded: block.expanded },
      ),
      element_id: flowElementId('group', block.id),
    });
    // These are siblings, not descendants of the group. Folding never hides failures.
    for (const failure of failures) {
      const id = flowElementId('failure', failure.id);
      elements.push({ ...params.md(failure.text), element_id: id });
      params.subagentChunks?.push({ kind: 'text', elementIds: [id] });
    }
  }
  return elements;
}

/**
 * The file a model is still writing. It exists only while the call has no timeline block of its
 * own, so nothing here needs a terminal-state counterpart: the write's own card takes over.
 */
function liveWriteElements(params: FormatProgressParams): FeishuCardElement[] {
  const live = params.data.liveWrite;
  if (!live) return [];
  const line = {
    ...params.md(
      t('progress.writingFile', params.locale)
        .replace('{target}', shortPath(live.path ?? live.name))
        .replace('{lines}', String(live.contentLines))
        .replace('{chars}', String(live.contentChars)),
    ),
    element_id: LIVE_WRITE_LINE_ELEMENT_ID,
  };
  // Redact before slicing: a tail cut through a credential must not defeat redaction.
  const preview = thinkingTail(redactSensitiveContent(live.contentTail));
  if (!preview.text) return [line];
  return [
    line,
    { ...codeBlockElement(preview.text), element_id: LIVE_WRITE_BODY_ELEMENT_ID },
  ];
}

/** Only supplemental state, never a second copy of the timeline's model output. */
export function buildProgressContentElements(params: FormatProgressParams): FeishuCardElement[] {
  if (params.flowOptions?.mode === 'legacy') return buildLegacyContentElements(params);
  const { data, md, locale } = params;
  const elements: FeishuCardElement[] = [];
  const isDone = isFlowTerminal(data);
  const hasTrace = !!(data.timeline?.length || data.thinkingText?.trim() || data.toolLogs?.length);
  if (data.phase === 'waiting_permission' && data.permission) {
    const extraQueue =
      data.permission.queueLength > 1
        ? `\n${t('progress.labelPendingApprovals', locale)}: ${data.permission.queueLength}`
        : '';
    elements.push(
      md(
        `**${t('progress.labelCurrentWait', locale)}**\n${data.permission.toolName}\n\`\`\`\n${data.permission.input}\n\`\`\`${extraQueue}`,
      ),
    );
    elements.push(
      { ...md(`**${t('progress.labelElapsedTime', locale)}** ${data.elapsedSeconds}s`),
        element_id: PROGRESS_ELAPSED_ELEMENT_ID },
    );
  } else if (!isDone && !hasTrace) {
    if (data.currentTool?.input) {
      const elapsed = data.currentTool.elapsed > 0 ? ` · ${data.currentTool.elapsed}s` : '';
      elements.push(
        md(
          `**${t('progress.labelRecentAction', locale)}**\n${data.currentTool.name}: ${truncate(data.currentTool.input, 140)}${elapsed}`,
        ),
      );
    }
    elements.push(
      { ...md(`**${t('progress.labelElapsedTime', locale)}** ${data.elapsedSeconds}s`),
        element_id: PROGRESS_ELAPSED_ELEMENT_ID },
    );
    elements.push(...liveWriteElements(params));
  } else if (!isDone) {
    const status = [
      data.totalTools > 0 ? `${data.totalTools} tools` : '',
      `${data.elapsedSeconds}s`,
    ].filter(Boolean);
    elements.push({
      ...md(`⏳ ${status.join(' · ')}`),
      element_id: PROGRESS_ELAPSED_ELEMENT_ID,
    });
    elements.push(...liveWriteElements(params));
  }

  // With a timeline, renderedText is no longer used as an error carrier. Provider failures
  // must still remain visible, including in a trace-only completion bubble.
  if (
    data.phase === 'failed' &&
    data.errorMessage &&
    !params.retainedToolResults?.has(data.errorMessage)
  ) {
    // Intermediate text may sit inside a folded group, so only top-level text is visible.
    const visibleText = buildFlowBlocks(data, params.flowOptions)
      .filter((block): block is FlowTextBlock => block.kind === 'text')
      .map((block) => block.text)
      .join('');
    const errorAlreadyVisible = visibleText.includes(data.errorMessage);
    if (!errorAlreadyVisible)
      elements.push(
        md(
          data.errorMessage === 'Interrupted'
            ? t('progress.titleStopped', locale)
            : `❌ ${data.errorMessage}`,
        ),
      );
  }
  if (data.apiRetry) {
    elements.push(
      md(
        `${t('progress.apiRetry', locale)} (${data.apiRetry.attempt}${data.apiRetry.maxRetries > 0 ? `/${data.apiRetry.maxRetries}` : ''})${data.apiRetry.error ? ` — ${data.apiRetry.error}` : ''}`,
      ),
    );
  }
  if (data.compacting) elements.push(md(t('progress.compacting', locale)));
  if (data.toolUseSummaryText && isDone) {
    elements.push(
      collapsiblePanel(t('progress.labelToolSummary', locale), [
        markdownElement(data.toolUseSummaryText),
      ]),
    );
  }
  if (data.todoItems.length > 0) {
    const done = data.todoItems.filter((item) => item.status === 'completed').length;
    const todoLines = data.todoItems.map((item) => `${TODO_MARKERS[item.status]} ${item.content}`);
    // One stable identity per conversation: the board is the same block on every card refresh.
    elements.push({
      ...collapsiblePanel(
        `📋 ${t('progress.labelWorkProgress', locale)} (${done}/${data.todoItems.length})`,
        [markdownElement(todoLines.join('\n'))],
        { expanded: true },
      ),
      element_id: PLAN_BOARD_ELEMENT_ID,
    });
  }
  return elements;
}
