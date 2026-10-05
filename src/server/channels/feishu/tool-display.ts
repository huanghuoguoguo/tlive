import { createHash } from 'node:crypto';
import type { Locale } from '../../../shared/i18n/index.js';
import { truncate } from '../../../shared/core/string.js';
import type { FeishuCardElement } from './card-builder.js';
import { buttonElements, collapsiblePanel, markdownElement } from './card-elements.js';
import type { PlanTodo } from '../../../shared/canonical/plan-signature.js';
import { redactSensitiveContent } from '../../../shared/utils/content-filter.js';

export const TOOL_RESULT_DETAIL_BYTES = 10_000;

/** Measure the original single result, before redaction or any display truncation. */
export function isOversizedToolResult(result: unknown): boolean {
  try {
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    return text !== undefined && Buffer.byteLength(text, 'utf8') > TOOL_RESULT_DETAIL_BYTES;
  } catch {
    return false; // Unserializable results cannot safely become a detail snapshot.
  }
}

function validDetailId(id: string | undefined): id is string {
  return !!id && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
}

export type ToolDisplayCategory = 'exploration' | 'execution' | 'editing' | 'generic';
export type FlowStatus = 'running' | 'completed' | 'failed' | 'interrupted';

export interface ToolDisplayCall {
  /** Stable call identity, never a name/input hash. */
  id: string;
  toolName: string;
  toolInput: string;
  inputData?: Record<string, unknown>;
  toolResult?: string;
  status: FlowStatus;
  detailId?: string;
  /** A retained full input/result snapshot, distinct from the short edit-diff entry point. */
  resultDetailId?: string;
  /** Set when the input is a task list; the board renders it, the timeline never repeats it. */
  plan?: PlanTodo[];
}

export interface ToolDisplayResult {
  elements: FeishuCardElement[];
  /** Render outside the parent panel so a collapsed group cannot hide a failure. */
  failureSummary?: string;
}

export interface ToolDisplayDefinition {
  category: ToolDisplayCategory;
  detailKind?: 'added' | 'changed';
  render?: (call: ToolDisplayCall, locale: Locale) => ToolDisplayResult;
}

/** Identity only: content, status and sibling positions never enter this hash. */
export function flowElementId(role: string, identity: string): string {
  return `f${createHash('sha256')
    .update(JSON.stringify([role, identity]))
    .digest('hex')
    .slice(0, 19)}`;
}

function identifyElements(elements: FeishuCardElement[], identity: string, role = 'tool'): void {
  elements.forEach((element, index) => {
    const key = `${role}:${index}`;
    element.element_id = flowElementId(key, identity);
    for (const property of ['elements', 'columns', 'actions']) {
      const children = element[property];
      if (Array.isArray(children))
        identifyElements(children as FeishuCardElement[], identity, `${key}:${property}`);
    }
  });
}

/** Exact-name registry: aliases are explicit and never rewrite the source tool name. */
export class ToolDisplayRegistry {
  private readonly definitions = new Map<string, ToolDisplayDefinition>();

  register(
    names: string | readonly string[],
    definition: ToolDisplayCategory | ToolDisplayDefinition,
  ): this {
    const resolved = typeof definition === 'string' ? { category: definition } : definition;
    for (const name of typeof names === 'string' ? [names] : names) {
      this.definitions.set(name, resolved);
    }
    return this;
  }

  resolve(name: string): ToolDisplayDefinition {
    return this.definitions.get(name) ?? { category: 'generic' };
  }

  category(name: string): ToolDisplayCategory {
    return this.resolve(name).category;
  }

  display(call: ToolDisplayCall, locale: Locale): ToolDisplayResult {
    const definition = this.resolve(call.toolName);
    // Apply the size policy outside category/custom renderers: none may leak a huge result,
    // nor silently omit it when retention fails (including exploration success and plans).
    const result = isOversizedToolResult(call.toolResult)
      ? displayOversizedTool(call, definition, locale)
      : definition.render
        ? definition.render(call, locale)
        : displayTool(call, definition, locale);
    identifyElements(result.elements, call.id);
    // Custom renderers cannot accidentally hide the call's failure inside a folded group.
    return { ...result, failureSummary: failureSummary(call, locale) ?? result.failureSummary };
  }
}

export function createDefaultToolDisplayRegistry(): ToolDisplayRegistry {
  return new ToolDisplayRegistry()
    .register(
      ['read', 'grab', 'Read', 'Grep', 'Glob', 'Search', 'grep', 'glob', 'search'],
      'exploration',
    )
    .register(['bash', 'Bash'], 'execution')
    .register(['write', 'Write'], { category: 'editing', detailKind: 'added' })
    .register(['replace', 'edit', 'Edit', 'MultiEdit', 'apply_patch'], {
      category: 'editing',
      detailKind: 'changed',
    });
}

export function flowStatusLabel(status: FlowStatus, locale: Locale): string {
  const labels =
    locale === 'zh'
      ? { running: '⏳ 进行中', completed: '✅ 完成', failed: '❌ 失败', interrupted: '⚠️ 已中断' }
      : {
          running: '⏳ Running',
          completed: '✅ Completed',
          failed: '❌ Failed',
          interrupted: '⚠️ Interrupted',
        };
  return labels[status];
}

function failureSummary(call: ToolDisplayCall, locale: Locale): string | undefined {
  if (call.status !== 'failed' && call.status !== 'interrupted') return undefined;
  const result = validDetailId(call.resultDetailId)
    ? ` — ${locale === 'zh' ? '完整结果见详情' : 'Full result in details'}`
    : call.toolResult
      ? ` — ${truncate(redactSensitiveContent(call.toolResult), 180)}`
      : '';
  return `${flowStatusLabel(call.status, locale)} · ${call.toolName}${result}`;
}

function filePaths(call: ToolDisplayCall): string[] {
  const paths: string[] = [];
  const addRecord = (data: Record<string, unknown>): void => {
    for (const key of ['path', 'file_path', 'filePath', 'target_path']) {
      if (typeof data[key] === 'string' && data[key]) paths.push(data[key] as string);
    }
  };
  if (call.inputData) {
    addRecord(call.inputData);
    for (const key of ['files', 'edits']) {
      const entries = call.inputData[key];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (typeof entry === 'string') paths.push(entry);
        else if (entry && typeof entry === 'object') addRecord(entry as Record<string, unknown>);
      }
    }
  }
  // Old payloads may carry JSON input rather than the structured snapshot.
  if (!paths.length && call.toolInput) {
    try {
      const input: unknown = JSON.parse(call.toolInput);
      if (input && typeof input === 'object' && !Array.isArray(input)) {
        addRecord(input as Record<string, unknown>);
      }
    } catch {
      // A legacy plain path/summary is still useful, but never becomes a path URL.
    }
  }
  return [...new Set(paths)];
}

function displayOversizedTool(
  call: ToolDisplayCall,
  definition: ToolDisplayDefinition,
  locale: Locale,
): ToolDisplayResult {
  // Render the ordinary call header/input, but never the result or its preview.
  const result = displayTool(
    { ...call, toolResult: undefined, detailId: undefined },
    definition,
    locale,
  );
  if (validDetailId(call.resultDetailId)) {
    result.elements.push(
      ...buttonElements([
        {
          label: locale === 'zh' ? '查看详情' : 'View details',
          callbackData: `flow_detail:open:${call.resultDetailId}`,
        },
      ]),
    );
  } else {
    // No store / exhausted cache / invalid or expired registration: the entire redacted
    // result remains inline. No category may silently discard the only reachable copy.
    result.elements.push(
      collapsiblePanel(locale === 'zh' ? '完整结果' : 'Full result', [
        markdownElement(redactSensitiveContent(call.toolResult!)),
      ]),
    );
  }
  return result;
}

function displayTool(
  call: ToolDisplayCall,
  definition: ToolDisplayDefinition,
  locale: Locale,
): ToolDisplayResult {
  const heading = `${flowStatusLabel(call.status, locale)} · **${call.toolName}**`;
  const elements: FeishuCardElement[] = [];
  if (call.plan) {
    // The list is already on the card's persistent board; dumping its JSON here is noise.
    elements.push(markdownElement(heading));
    return { elements, failureSummary: failureSummary(call, locale) };
  }
  if (definition.category === 'editing') {
    const paths = filePaths(call);
    const entries = paths.length
      ? paths
      : [call.toolInput || (locale === 'zh' ? '(无文件条目)' : '(no file entry)')];
    elements.push(markdownElement(`${heading}\n${entries.map((path) => `• ${path}`).join('\n')}`));
    // No snapshot ID means no callback; this renderer never reads files or creates snapshots.
    if (validDetailId(call.detailId)) {
      elements.push(
        ...buttonElements([
          {
            label:
              locale === 'zh'
                ? definition.detailKind === 'added'
                  ? '查看新增内容'
                  : '查看改动'
                : definition.detailKind === 'added'
                  ? 'View added content'
                  : 'View changes',
            callbackData: `flow_detail:open:${call.detailId}`,
          },
        ]),
      );
    }
  } else {
    const data = call.inputData;
    const input =
      typeof data?.command === 'string'
        ? data.command
        : data
          ? JSON.stringify(data, null, 2)
          : call.toolInput || '(no input)';
    const summary =
      definition.category !== 'exploration' && call.toolResult
        ? `\n> ${truncate(call.toolResult, 120)}`
        : '';
    elements.push(markdownElement(`${heading}\n${input}${summary}`));
    // Exploration success output is deliberately absent from *all* card JSON, not merely folded.
    if (
      (definition.category !== 'exploration' ||
        call.status === 'failed' ||
        call.status === 'interrupted') &&
      call.toolResult !== undefined
    ) {
      elements.push(
        collapsiblePanel(locale === 'zh' ? '完整结果' : 'Full result', [
          markdownElement(call.toolResult),
        ]),
      );
    }
  }
  return { elements, failureSummary: failureSummary(call, locale) };
}
