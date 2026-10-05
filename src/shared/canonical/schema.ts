import { z } from 'zod';

const textDeltaSchema = z.object({
  kind: z.literal('text_delta'),
  text: z.string(),
});

const thinkingDeltaSchema = z.object({
  kind: z.literal('thinking_delta'),
  text: z.string(),
});

/**
 * What one model round-trip cost. A provider reports this per assistant message, never per tool,
 * so `step` names the round-trip: several parallel calls share one number and a folded group must
 * count it once. `inputTokens` excludes cached reads. Optional on `tool_start` because providers
 * that cannot attribute a call to a step omit it, and an older reader strips the key.
 */
export const stepUsageSchema = z.object({
  step: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  contextTokens: z.number(),
  contextWindow: z.number().positive().optional(),
});
export type StepUsage = z.infer<typeof stepUsageSchema>;

const toolStartSchema = z.object({
  kind: z.literal('tool_start'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
  usage: stepUsageSchema.optional(),
});

const toolResultSchema = z.object({
  kind: z.literal('tool_result'),
  toolUseId: z.string(),
  content: z.string(),
  isError: z.boolean(),
  isFinal: z.boolean().optional(),
});

const subagentTimelineEntrySchema = z.object({
  kind: z.enum(['thinking', 'text', 'tool']),
  blockId: z.string(),
  text: z.string().optional(),
  toolId: z.string().optional(),
  toolName: z.string().optional(),
  toolInput: z.string().optional(),
  inputData: z.record(z.string(), z.unknown()).optional(),
  toolResult: z.string().optional(),
  status: z.enum(['running', 'completed', 'failed', 'interrupted']).optional(),
  usage: stepUsageSchema.optional(),
});

export const subagentSnapshotSchema = z.object({
  kind: z.literal('subagent_snapshot'),
  parentToolUseId: z.string().min(1),
  childId: z.string().min(1),
  agentName: z.string(),
  task: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'interrupted']),
  timeline: z.array(subagentTimelineEntrySchema),
  error: z.string().optional(),
});
export type SubagentSnapshot = z.infer<typeof subagentSnapshotSchema>;

const toolProgressSchema = z.object({
  kind: z.literal('tool_progress'),
  toolName: z.string(),
  elapsed: z.number(),
  /**
   * A write call whose arguments are still being streamed. The tool block does not exist yet —
   * pi only emits tool_execution_start once the arguments are complete — so this is the only way
   * to show the file while the model is producing it. Optional so an older producer keeps meaning
   * "elapsed time" alone, and an older reader strips these keys instead of rejecting the event.
   */
  path: z.string().optional(),
  contentTail: z.string().optional(),
  contentChars: z.number().optional(),
  contentLines: z.number().optional(),
});

const agentUsageSchema = z.object({
  toolUses: z.number(),
  durationMs: z.number(),
});

const agentStartSchema = z.object({
  kind: z.literal('agent_start'),
  description: z.string(),
  taskId: z.string().optional(),
});

const agentProgressSchema = z.object({
  kind: z.literal('agent_progress'),
  description: z.string(),
  lastTool: z.string().optional(),
  usage: agentUsageSchema.optional(),
});

const agentCompleteSchema = z.object({
  kind: z.literal('agent_complete'),
  summary: z.string(),
  status: z.enum(['completed', 'failed', 'stopped']),
});

const usageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cachedInputTokens: z.number().optional(),
  reasoningOutputTokens: z.number().optional(),
  contextTokens: z.number().optional(),
  costUsd: z.number().optional(),
});

const permissionDenialSchema = z.object({
  toolName: z.string(),
  toolUseId: z.string(),
});

const queryResultSchema = z.object({
  kind: z.literal('query_result'),
  sessionId: z.string(),
  isError: z.boolean(),
  usage: usageSchema,
  permissionDenials: z.array(permissionDenialSchema).optional(),
  error: z.string().optional(), // Error message for isError=true cases
});

const errorSchema = z.object({
  kind: z.literal('error'),
  message: z.string(),
});

const warningSchema = z.object({
  kind: z.literal('warning'),
  message: z.string(),
});

const statusSchema = z.object({
  kind: z.literal('status'),
  sessionId: z.string(),
  model: z.string().optional(),
});

const sessionInfoSchema = z.object({
  kind: z.literal('session_info'),
  sessionId: z.string(),
  model: z.string(),
  tools: z.array(z.string()).optional(),
  mcpServers: z
    .array(
      z.object({
        name: z.string(),
        status: z.string(),
      }),
    )
    .optional(),
  skills: z.array(z.string()).optional(),
});

const toolUseSummarySchema = z.object({
  kind: z.literal('tool_use_summary'),
  summary: z.string(),
});

const apiRetrySchema = z.object({
  kind: z.literal('api_retry'),
  attempt: z.number(),
  maxRetries: z.number(),
  retryDelayMs: z.number(),
  error: z.string().optional(),
});

const compactBoundarySchema = z.object({
  kind: z.literal('compact_boundary'),
  trigger: z.enum(['manual', 'auto']),
  /** 'start' when a compaction run begins, 'end' when it finishes (success, abort or failure). */
  phase: z.enum(['start', 'end']).optional(),
  /** Context size before compaction; only known once the summary exists. */
  preTokens: z.number().optional(),
  /** Set on phase='end' when the compaction run failed. */
  errorMessage: z.string().optional(),
});

const promptSuggestionSchema = z.object({
  kind: z.literal('prompt_suggestion'),
  suggestion: z.string(),
});

const rateLimitSchema = z.object({
  kind: z.literal('rate_limit'),
  status: z.string(),
  utilization: z.number().optional(),
  resetsAt: z.number().optional(),
});

const contextUsageSchema = z.object({
  kind: z.literal('context_usage'),
  tokens: z.number().nullable(),
  contextWindow: z.number(),
  percent: z.number().nullable(),
});

// 'cancelled' carries dropped work (cancelled/skipped); 'blocked' carries stalled work. Neither
// may collapse into pending, or a plan that stopped would look like one that has not started.
export const todoStatusSchema = z.enum([
  'pending',
  'in_progress',
  'completed',
  'cancelled',
  'blocked',
]);

const todoUpdateSchema = z.object({
  kind: z.literal('todo_update'),
  todos: z.array(
    z.object({
      content: z.string(),
      status: todoStatusSchema,
    }),
  ),
});

export const canonicalEventSchema = z.discriminatedUnion('kind', [
  textDeltaSchema,
  thinkingDeltaSchema,
  toolStartSchema,
  toolResultSchema,
  toolProgressSchema,
  subagentSnapshotSchema,
  agentStartSchema,
  agentProgressSchema,
  agentCompleteSchema,
  queryResultSchema,
  errorSchema,
  warningSchema,
  statusSchema,
  sessionInfoSchema,
  toolUseSummarySchema,
  apiRetrySchema,
  compactBoundarySchema,
  promptSuggestionSchema,
  rateLimitSchema,
  contextUsageSchema,
  todoUpdateSchema,
]);

export type CanonicalEvent = z.infer<typeof canonicalEventSchema>;
export type TodoStatus = z.infer<typeof todoStatusSchema>;
