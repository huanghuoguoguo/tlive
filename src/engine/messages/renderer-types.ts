/**
 * Shared types for message rendering — extracted to avoid circular dependency.
 */

import type { Button } from '../../ui/types.js';
import type { TodoStatus } from '../../utils/types.js';

/** Tool call log entry for detailed display */
export interface ToolLogEntry {
  name: string;
  input: string;
  result?: string;
  isError?: boolean;
}

/** Ordered timeline entry — interleaves text output with tool calls */
export interface TimelineEntry {
  kind: 'thinking' | 'text' | 'tool';
  /** For thinking/text entries */
  text?: string;
  /** For tool entries */
  toolName?: string;
  toolInput?: string;
  toolResult?: string;
  isError?: boolean;
}

/** Current tool execution state for progress display */
export interface CurrentTool {
  name: string;
  input: string;  // Brief description of what's being done
  elapsed: number; // Seconds
}

/** Renderer state snapshot for progress display */
export interface MessageRendererState {
  phase: 'starting' | 'executing' | 'waiting_permission' | 'completed' | 'failed';
  renderedText: string;
  responseText: string;
  elapsedSeconds: number;
  totalTools: number;
  toolSummary: string;
  footerLine?: string;
  errorMessage?: string;
  permissionRequests: number;
  currentTool: CurrentTool | null;
  todoItems: Array<{ content: string; status: TodoStatus }>;
  thinkingText: string;
  toolLogs: ToolLogEntry[];
  /** Ordered interleaved timeline of text + tool calls */
  timeline: TimelineEntry[];
  permission?: {
    toolName: string;
    input: string;
    queueLength: number;
  };
  /** True after bubble split — continuation of previous task */
  isContinuation?: boolean;
  /** Session info from SDK init event */
  sessionInfo?: {
    tools?: string[];
    mcpServers?: Array<{ name: string; status: string }>;
    skills?: string[];
  };
  /** AI-generated summary of preceding tool calls */
  toolUseSummaryText?: string;
  /** API retry state */
  apiRetry?: {
    attempt: number;
    maxRetries: number;
    retryDelayMs: number;
    error?: string;
  };
  /** Context compaction indicator */
  compacting?: boolean;
}