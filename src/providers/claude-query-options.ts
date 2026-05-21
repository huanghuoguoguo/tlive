import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { AgentSettingSource } from '../config.js';
import type { EffortLevel } from '../utils/types.js';
import { buildSubprocessEnv, SAFE_PERMISSIONS } from './claude-shared.js';
import type {
  AskUserQuestionHandler,
  DeferredToolHandler,
  PermissionRequestHandler,
  QueryControls,
} from './base.js';
import { isDeferredToolName } from './deferred-tools.js';

export interface ClaudeCanUseToolOptions {
  decisionReason?: string;
  title?: string;
  suggestions?: unknown[];
  signal?: AbortSignal;
  blockedPath?: string;
  toolUseID?: string;
  agentID?: string;
}

export type ClaudeCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options?: ClaudeCanUseToolOptions,
) => Promise<PermissionResult>;

export interface ClaudeQueryOptionsParams {
  cwd: string;
  model?: string;
  resume?: string;
  permissionMode?: 'acceptEdits' | 'plan' | 'default';
  effort?: EffortLevel;
  settingSources: AgentSettingSource[];
  appendSystemPrompt?: string;
  cliPath?: string;
  stderr?: (data: string) => void;
  abortSignal?: AbortSignal;
  canUseTool: ClaudeCanUseTool;
  allowPermissions?: readonly string[];
  toolConfig?: Record<string, unknown>;
}

function controllerFromSignal(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort(signal.reason);
    return controller;
  }
  signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  return controller;
}

export function buildClaudeQueryOptions(params: ClaudeQueryOptionsParams): Record<string, unknown> {
  const options: Record<string, unknown> = {
    cwd: params.cwd,
    model: params.model || undefined,
    resume: params.resume || undefined,
    ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
    effort: params.effort || undefined,
    includePartialMessages: true,
    agentProgressSummaries: true,
    promptSuggestions: true,
    settingSources: params.settingSources,
    settings: {
      permissions: {
        allow: params.allowPermissions ?? SAFE_PERMISSIONS,
      },
    },
    env: buildSubprocessEnv(),
    ...(params.toolConfig ? { toolConfig: params.toolConfig } : {}),
    ...(params.appendSystemPrompt
      ? {
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: params.appendSystemPrompt,
          },
        }
      : {}),
    ...(params.stderr ? { stderr: params.stderr } : {}),
    ...(params.abortSignal ? { abortController: controllerFromSignal(params.abortSignal) } : {}),
    ...(params.cliPath ? { pathToClaudeCodeExecutable: params.cliPath } : {}),
    canUseTool: params.canUseTool,
  };

  return options;
}

export function createClaudeQueryControls(queryLike: unknown): QueryControls {
  const q = queryLike as {
    interrupt?: () => Promise<void>;
    stopTask?: (taskId: string) => Promise<void>;
  };
  return {
    interrupt: async () => {
      await q.interrupt?.();
    },
    stopTask: async (taskId: string) => {
      await q.stopTask?.(taskId);
    },
  };
}

export async function routeDeferredToolRequest(
  toolName: string,
  input: Record<string, unknown>,
  options: ClaudeCanUseToolOptions,
  handler?: DeferredToolHandler,
): Promise<PermissionResult | undefined> {
  if (!isDeferredToolName(toolName) || !handler) return undefined;

  try {
    const result = await handler(toolName, input, options.signal);
    if (result.behavior === 'allow') {
      return {
        behavior: 'allow' as const,
        updatedInput: result.updatedInput ?? input,
        toolUseID: options.toolUseID,
      };
    }
    return {
      behavior: 'deny' as const,
      message: result.message ?? 'User denied',
      toolUseID: options.toolUseID,
    };
  } catch {
    return { behavior: 'deny' as const, message: 'User cancelled' };
  }
}

export async function routeAskUserQuestionRequest(
  toolName: string,
  input: Record<string, unknown>,
  options: ClaudeCanUseToolOptions,
  handler?: AskUserQuestionHandler,
): Promise<PermissionResult | undefined> {
  if (toolName !== 'AskUserQuestion' || !handler) return undefined;

  const questions =
    ((input as Record<string, unknown>).questions as Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description?: string; preview?: string }>;
      multiSelect: boolean;
    }>) ?? [];
  if (questions.length === 0) return undefined;

  try {
    const answers = await handler(questions, options.signal);
    return {
      behavior: 'allow' as const,
      updatedInput: { questions: (input as Record<string, unknown>).questions, answers },
    };
  } catch {
    return { behavior: 'deny' as const, message: 'User did not answer' };
  }
}

export async function routePermissionRequest(params: {
  logPrefix: string;
  toolName: string;
  input: Record<string, unknown>;
  options: ClaudeCanUseToolOptions;
  handler?: PermissionRequestHandler;
  includeBlockedPath?: boolean;
}): Promise<PermissionResult> {
  const { logPrefix, toolName, input, options, handler } = params;
  if (!handler) {
    return { behavior: 'allow' as const, updatedInput: input };
  }
  if (options.signal?.aborted) {
    return { behavior: 'deny' as const, message: 'Cancelled by SDK' };
  }

  const reason =
    params.includeBlockedPath && options.blockedPath
      ? `${options.decisionReason || toolName} (${options.blockedPath})`
      : options.decisionReason || options.title || toolName;
  console.log(`[${logPrefix}] canUseTool: ${toolName} → asking user (${reason})`);

  const decision = await handler(toolName, input, reason, options.signal);
  if (decision === 'allow') {
    return {
      behavior: 'allow' as const,
      updatedInput: input,
      toolUseID: options.toolUseID,
    };
  }
  if (decision === 'allow_always') {
    return {
      behavior: 'allow' as const,
      updatedInput: input,
      toolUseID: options.toolUseID,
      ...(options.suggestions ? { updatedPermissions: options.suggestions } : {}),
    } as PermissionResult;
  }
  return {
    behavior: 'deny' as const,
    message: 'Denied by user via IM',
    toolUseID: options.toolUseID,
  };
}
