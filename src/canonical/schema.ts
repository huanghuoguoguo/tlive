import { z } from 'zod';

const textDeltaSchema = z.object({
  kind: z.literal('text_delta'),
  text: z.string(),
});

const thinkingDeltaSchema = z.object({
  kind: z.literal('thinking_delta'),
  text: z.string(),
});

const toolStartSchema = z.object({
  kind: z.literal('tool_start'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});

const toolResultSchema = z.object({
  kind: z.literal('tool_result'),
  toolUseId: z.string(),
  content: z.string(),
  isError: z.boolean(),
  isFinal: z.boolean().optional(),
});

const toolProgressSchema = z.object({
  kind: z.literal('tool_progress'),
  toolName: z.string(),
  elapsed: z.number(),
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
  mcpServers: z.array(z.object({
    name: z.string(),
    status: z.string(),
  })).optional(),
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
  preTokens: z.number().optional(),
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

const todoUpdateSchema = z.object({
  kind: z.literal('todo_update'),
  todos: z.array(z.object({
    content: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed']),
  })),
});

export const canonicalEventSchema = z.discriminatedUnion('kind', [
  textDeltaSchema,
  thinkingDeltaSchema,
  toolStartSchema,
  toolResultSchema,
  toolProgressSchema,
  agentStartSchema,
  agentProgressSchema,
  agentCompleteSchema,
  queryResultSchema,
  errorSchema,
  statusSchema,
  sessionInfoSchema,
  toolUseSummarySchema,
  apiRetrySchema,
  compactBoundarySchema,
  promptSuggestionSchema,
  rateLimitSchema,
  todoUpdateSchema,
]);

export type CanonicalEvent = z.infer<typeof canonicalEventSchema>;
