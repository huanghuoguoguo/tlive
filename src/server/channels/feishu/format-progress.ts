/**
 * Feishu progress/timeline formatting - extracted from main formatter.
 */

import type { Locale } from '../../../shared/i18n/index.js';
import { t } from '../../../shared/i18n/index.js';
import type { FeishuCardElement } from './card-builder.js';
import type { ProgressData } from '../../../shared/formatting/message-types.js';
import { truncate } from '../../../shared/core/string.js';
import { downgradeHeadings } from './markdown.js';
import { collapsiblePanel, dividerElement, markdownElement } from './card-elements.js';

type TimelineToolDisplay = {
  toolName: string;
  toolInput: string;
  toolResult?: string;
  isError?: boolean;
};

type TimelineOperationDisplay = {
  thinkingContent: string;
  textEntries: string[];
  toolEntries: TimelineToolDisplay[];
};

interface TimelineCollectOptions {
  splitTextAfterTool?: boolean;
}

function summarizeOperationText(text: string): string {
  const cleaned = text
    .replace(/[*_`>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';

  const sentence =
    cleaned
      .split(/[。！？.!?\n]/)
      .map((part) => part.trim())
      .find(Boolean) || cleaned;

  return truncate(sentence, 20);
}

function collectTimelineOperations(
  data: ProgressData,
  options: TimelineCollectOptions = {},
): TimelineOperationDisplay[] {
  const operations: TimelineOperationDisplay[] = [];
  let current: TimelineOperationDisplay | undefined;
  let currentToolByKey: Map<string, TimelineToolDisplay> | undefined;

  const ensureCurrent = (): TimelineOperationDisplay => {
    if (!current) {
      current = { thinkingContent: '', textEntries: [], toolEntries: [] };
      currentToolByKey = new Map<string, TimelineToolDisplay>();
    }
    return current;
  };

  const flushCurrent = (): void => {
    if (!current) return;
    if (
      current.thinkingContent.trim() ||
      current.textEntries.length > 0 ||
      current.toolEntries.length > 0
    ) {
      operations.push(current);
    }
    current = undefined;
    currentToolByKey = undefined;
  };

  for (const entry of data.timeline ?? []) {
    if (entry.kind === 'thinking' && entry.text?.trim()) {
      const currentOp = current;
      if (currentOp && (currentOp.toolEntries.length > 0 || currentOp.textEntries.length > 0)) {
        flushCurrent();
      }
      const op = ensureCurrent();
      op.thinkingContent = op.thinkingContent
        ? `${op.thinkingContent}\n\n${entry.text.trim()}`
        : entry.text.trim();
      continue;
    }

    if (entry.kind === 'text' && entry.text?.trim()) {
      if (options.splitTextAfterTool && current?.toolEntries.length) {
        flushCurrent();
      }
      ensureCurrent().textEntries.push(entry.text.trim());
      continue;
    }

    if (entry.kind === 'tool' && entry.toolName) {
      const op = ensureCurrent();
      const toolMap = currentToolByKey ?? new Map<string, TimelineToolDisplay>();
      currentToolByKey = toolMap;
      const toolInput = entry.toolInput || '(no input)';
      const key = `${entry.toolName}\u0000${toolInput}`;
      const existing = toolMap.get(key);
      if (existing) {
        if (entry.toolResult !== undefined) {
          existing.toolResult = entry.toolResult;
        }
        if (entry.isError !== undefined) {
          existing.isError = entry.isError;
        }
        continue;
      }

      const toolEntry: TimelineToolDisplay = {
        toolName: entry.toolName,
        toolInput,
        toolResult: entry.toolResult,
        isError: entry.isError,
      };
      toolMap.set(key, toolEntry);
      op.toolEntries.push(toolEntry);
    }
  }

  flushCurrent();
  return operations;
}

function buildOperationHeader(
  _locale: Locale,
  operation: TimelineOperationDisplay,
  isExpanded: boolean,
): string {
  const summarySource =
    operation.thinkingContent.trim() || operation.textEntries.find((text) => text.trim()) || '';
  const summary = summarizeOperationText(summarySource);
  const toolNames = [...new Set(operation.toolEntries.map((tool) => tool.toolName))];
  const toolSuffix =
    toolNames.length > 0
      ? toolNames.length === 1
        ? `${toolNames[0]}×${operation.toolEntries.length}`
        : `${toolNames.slice(0, 2).join('/')} ${t('progress.andMore')}`
      : '';
  const title = summary
    ? toolSuffix
      ? `${summary} · ${toolSuffix}`
      : summary
    : toolNames.length > 0
      ? toolNames.slice(0, 3).join(' · ')
      : t('progress.phaseThinking');
  const hasPendingTool = operation.toolEntries.some(
    (tool) => tool.toolResult === undefined && !tool.isError,
  );
  const hasError = operation.toolEntries.some((tool) => tool.isError);
  const icon = hasError ? '❌' : hasPendingTool ? '⏳' : isExpanded ? '🔄' : '✅';
  return `${icon} ${title}`;
}

function buildOperationContent(
  operation: TimelineOperationDisplay,
  includeTextEntries: boolean,
): string {
  const sections: string[] = [];

  if (operation.thinkingContent.trim()) {
    sections.push(operation.thinkingContent.trim());
  }

  if (includeTextEntries && operation.textEntries.length > 0) {
    sections.push(operation.textEntries.join('\n\n'));
  }

  if (operation.toolEntries.length > 0) {
    const toolLines = operation.toolEntries.map((tool) => {
      const status = tool.isError ? '❌' : tool.toolResult !== undefined ? '✅' : '⏳';
      const result = tool.toolResult ? truncate(tool.toolResult, 120) : '';
      if (tool.toolName === 'Bash') {
        const line = `${status} **Bash** \`${truncate(tool.toolInput, 120)}\``;
        return result ? `${line}\n> ${result}` : line;
      }
      const inputPreview = truncate(tool.toolInput, 160);
      const line = `${status} **${tool.toolName}**\n${inputPreview}`;
      return result ? `${line}\n> ${result}` : line;
    });
    sections.push(toolLines.join('\n\n'));
  }

  return sections.join('\n\n');
}

function extractCompletedBody(data: ProgressData): string {
  const timelineBody = extractCompletedBodyFromTimeline(data);
  if (timelineBody && (!data.renderedText || data.renderedText.includes(timelineBody))) {
    return timelineBody;
  }

  let body = data.renderedText.trim();

  if (data.footerLine && body.endsWith(data.footerLine)) {
    body = body.slice(0, -data.footerLine.length).trimEnd();
  }
  if (data.toolSummary && body.endsWith(data.toolSummary)) {
    body = body.slice(0, -data.toolSummary.length).trimEnd();
  }
  if (body.endsWith('───────────────')) {
    body = body.slice(0, -'───────────────'.length).trimEnd();
  }

  return body;
}

function extractCompletedBodyFromTimeline(data: ProgressData): string {
  const operations = collectTimelineOperations(data, { splitTextAfterTool: true });
  const textChunks: string[] = [];
  for (let i = operations.length - 1; i >= 0; i--) {
    const operation = operations[i];
    if (operation.thinkingContent.trim() || operation.toolEntries.length > 0) break;
    if (operation.textEntries.length > 0) {
      textChunks.unshift(operation.textEntries.join('\n\n'));
    }
  }
  return textChunks.join('\n\n').trim();
}

function operationBudget(data: ProgressData, isDone: boolean): number {
  const renderedBytes = Buffer.byteLength(data.renderedText || '', 'utf8');
  const footerBytes = Buffer.byteLength(data.footerLine || '', 'utf8');
  const available = Math.max(4500, 20_000 - renderedBytes - footerBytes);
  return Math.min(isDone ? 9000 : 12_000, available);
}

export interface FormatProgressParams {
  chatId: string;
  data: ProgressData;
  md: (content: string) => FeishuCardElement;
  locale: Locale;
}

export function buildProgressTimelineElements(params: FormatProgressParams): FeishuCardElement[] {
  const { data, locale } = params;
  const elements: FeishuCardElement[] = [];
  const isDone = data.phase === 'completed' || data.phase === 'failed';
  const operations = collectTimelineOperations(data, { splitTextAfterTool: isDone });
  const visibleOperations = isDone
    ? operations.filter(
        (operation) => operation.thinkingContent.trim() || operation.toolEntries.length > 0,
      )
    : operations;

  if (visibleOperations.length > 0) {
    let budget = operationBudget(data, isDone);
    const picked: Array<{ operation: TimelineOperationDisplay; content: string }> = [];

    for (let i = visibleOperations.length - 1; i >= 0; i--) {
      if (budget <= 0 && picked.length > 0) break;
      const operation = visibleOperations[i];
      const isLatest = picked.length === 0;
      const maxPerOperation = isLatest ? (isDone ? 1800 : 2800) : isDone ? 1200 : 1800;
      const reservedBudget = isLatest && !isDone ? Math.max(budget, 1800) : budget;
      const content = truncate(
        downgradeHeadings(buildOperationContent(operation, true)),
        Math.min(reservedBudget, maxPerOperation),
      );
      picked.push({ operation, content });
      budget -= content.length;
    }

    picked.reverse();
    const expandedIndex = isDone ? -1 : picked.length - 1;
    for (let i = 0; i < picked.length; i++) {
      if (i > 0) elements.push(dividerElement());
      const { operation, content } = picked[i];
      const isExpanded = i === expandedIndex;
      elements.push(
        collapsiblePanel(
          buildOperationHeader(locale, operation, isExpanded),
          [markdownElement(content)],
          { expanded: isExpanded },
        ),
      );
    }
  } else {
    // Legacy fallback: separate thinking + tool panels
    if (data.thinkingText?.trim()) {
      elements.push(
        collapsiblePanel(t('progress.labelThinkingProcess'), [
          markdownElement(truncate(data.thinkingText.trim(), 1500)),
        ]),
      );
    }
    if (data.toolLogs?.length) {
      const logLines = data.toolLogs.map((log) => {
        const icon = log.isError ? '❌' : '✅';
        const status = log.result !== undefined ? icon : '⏳';
        const resultLine = log.result ? `\n   → ${truncate(log.result, 120)}` : '';
        return `${status} **${log.name}**: ${truncate(log.input || '(no input)', 100)}${resultLine}`;
      });
      elements.push(
        collapsiblePanel(
          `${t('progress.labelToolCalls')} (${data.toolLogs.length})`,
          [markdownElement(truncate(logLines.join('\n'), 2000))],
          { expanded: !isDone },
        ),
      );
    }
  }

  return elements;
}

export function buildProgressContentElements(params: FormatProgressParams): FeishuCardElement[] {
  const { data, md } = params;
  const elements: FeishuCardElement[] = [];
  const isDone = data.phase === 'completed' || data.phase === 'failed';
  const operations = collectTimelineOperations(data, { splitTextAfterTool: isDone });

  if (isDone) {
    if (!data.completedTraceOnly) {
      const completedBody = extractCompletedBody(data);
      if (completedBody) {
        elements.push(md(downgradeHeadings(truncate(completedBody, 3000))));
      }
    }
  } else if (data.phase === 'waiting_permission' && data.permission) {
    const extraQueue =
      data.permission.queueLength > 1
        ? `\n${t('progress.labelPendingApprovals')}: ${data.permission.queueLength}`
        : '';
    elements.push(
      md(
        `**${t('progress.labelCurrentWait')}**\n${data.permission.toolName}\n\`\`\`\n${truncate(data.permission.input, 260)}\n\`\`\`${extraQueue}`,
      ),
    );
    elements.push(md(`**${t('progress.labelElapsedTime')}** ${data.elapsedSeconds}s`));
  } else if (!operations.length) {
    if (data.currentTool?.input) {
      const currentElapsed = data.currentTool.elapsed > 0 ? ` · ${data.currentTool.elapsed}s` : '';
      elements.push(
        md(
          `**${t('progress.labelRecentAction')}**\n${data.currentTool.name}: ${truncate(data.currentTool.input, 140)}${currentElapsed}`,
        ),
      );
    }
    elements.push(md(`**${t('progress.labelElapsedTime')}** ${data.elapsedSeconds}s`));
  }

  // Status line for in-progress cards with timeline
  if (!isDone && operations.length > 0) {
    const statusParts: string[] = [];
    if (data.totalTools > 0) statusParts.push(`${data.totalTools} tools`);
    statusParts.push(`${data.elapsedSeconds}s`);
    elements.push(md(`⏳ ${statusParts.join(' · ')}`));
  }

  // API retry indicator
  if (data.apiRetry) {
    elements.push(
      md(
        `${t('progress.apiRetry')} (${data.apiRetry.attempt}/${data.apiRetry.maxRetries})${data.apiRetry.error ? ` — ${data.apiRetry.error}` : ''}`,
      ),
    );
  }

  // Context compaction indicator
  if (data.compacting) {
    elements.push(md(t('progress.compacting')));
  }

  // Tool use summary
  if (data.toolUseSummaryText && isDone) {
    elements.push(
      collapsiblePanel(t('progress.labelToolSummary'), [
        markdownElement(truncate(data.toolUseSummaryText, 1000)),
      ]),
    );
  }

  // Todo progress
  if (data.todoItems.length > 0) {
    const done = data.todoItems.filter((item) => item.status === 'completed').length;
    const todoLines = data.todoItems.slice(0, 5).map((item) => {
      const icon = item.status === 'completed' ? '✅' : item.status === 'in_progress' ? '🔧' : '⬜';
      return `${icon} ${item.content}`;
    });
    elements.push(
      md(
        `**${t('progress.labelWorkProgress')}** (${done}/${data.todoItems.length})\n${todoLines.join('\n')}`,
      ),
    );
  }

  return elements;
}

export function progressHeaderConfig(
  _locale: Locale,
  data: ProgressData,
): { template: string; title: string } {
  return data.phase === 'completed'
    ? { template: 'green' as const, title: t('progress.titleCompleted') }
    : data.phase === 'failed'
      ? { template: 'red' as const, title: t('progress.titleStopped') }
      : data.phase === 'waiting_permission'
        ? { template: 'orange' as const, title: t('progress.titleWaitingPerm') }
        : data.isContinuation
          ? {
              template: 'blue' as const,
              title: `${t('progress.titleContinue')} (${data.totalTools} ${t('progress.labelStepsCompleted')})`,
            }
          : {
              template: 'blue' as const,
              title:
                data.phase === 'starting'
                  ? t('progress.titleStarting')
                  : t('progress.titleRunning'),
            };
}
