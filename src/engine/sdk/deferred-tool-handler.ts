/**
 * SDK Deferred Tool Handler — handles EnterPlanMode, EnterWorktree, etc.
 * These tools need interactive user input beyond simple permission approval.
 */

import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import type { PermissionCoordinator } from '../coordinators/permission.js';
import type { InteractionState } from '../state/interaction-state.js';
import { truncate } from '../../utils/string.js';
import { generateId } from '../../utils/id.js';
import { DEFAULT_PERMISSION_TIMEOUT_MS } from '../../utils/constants.js';

/** Known deferred tools that need interactive input */
export const DEFERRED_TOOLS = ['EnterPlanMode', 'EnterWorktree'] as const;
export type DeferredToolName = typeof DEFERRED_TOOLS[number];

/** Configuration for each deferred tool's input requirements */
const DEFERRED_TOOL_CONFIG: Record<DeferredToolName, {
  prompt: string;
  inputRequired: boolean;
  inputPlaceholder: string;
  defaultValue?: string;
}> = {
  EnterPlanMode: {
    prompt: 'Claude 想要进入 Plan 模式来规划任务。请输入你的计划内容，或直接确认进入计划模式。',
    inputRequired: false,
    inputPlaceholder: '输入计划内容（可选）...',
    defaultValue: '',
  },
  EnterWorktree: {
    prompt: 'Claude 想要创建一个新的 git worktree 来隔离工作。请输入分支名称（可选）。',
    inputRequired: false,
    inputPlaceholder: '输入分支名称（可选）...',
    defaultValue: '',
  },
};

interface SDKDeferredToolHandlerContext {
  adapter: BaseChannelAdapter;
  msg: InboundMessage;
  binding: { sessionId: string; sdkSessionId?: string };
  permissions: PermissionCoordinator;
  interactionState: InteractionState;
}

export class SDKDeferredToolHandler {
  private context: SDKDeferredToolHandlerContext;
  private cleanedUp = false;

  constructor(context: SDKDeferredToolHandlerContext) {
    this.context = context;
  }

  /** Check if a tool is a deferred tool that needs interactive input */
  static isDeferredTool(toolName: string): boolean {
    return DEFERRED_TOOLS.includes(toolName as DeferredToolName);
  }

  /** Get config for a deferred tool */
  static getToolConfig(toolName: DeferredToolName): typeof DEFERRED_TOOL_CONFIG[DeferredToolName] {
    return DEFERRED_TOOL_CONFIG[toolName];
  }

  /** Cleanup helper — guards against double cleanup */
  private cleanup(permId: string, reason: string): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    this.context.permissions.getGateway().resolve(permId, 'deny', reason);
    this.context.interactionState.cleanupDeferredTool(permId);
  }

  /** Main handler for deferred tool requests */
  async handle(
    toolName: DeferredToolName | string,
    toolInput: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; message?: string }> {
    const { adapter, msg, binding, permissions, interactionState } = this.context;
    const permId = generateId('defer');

    const config = DEFERRED_TOOL_CONFIG[toolName as DeferredToolName] ?? {
      prompt: `工具 ${toolName} 需要用户输入。请提供输入内容。`,
      inputRequired: false,
      inputPlaceholder: '输入内容...',
      defaultValue: '',
    };

    // Track pending deferred tool state (only in InteractionState, not PermissionCoordinator)
    interactionState.beginDeferredTool(permId, toolName, msg.chatId);

    const abortCleanup = () => this.cleanup(permId, 'Cancelled');

    if (signal?.aborted) {
      abortCleanup();
      return { behavior: 'deny', message: 'Cancelled' };
    }
    signal?.addEventListener('abort', abortCleanup, { once: true });

    const waitPromise = permissions.getGateway().waitFor(permId, {
      timeoutMs: DEFAULT_PERMISSION_TIMEOUT_MS,
      onTimeout: () => this.cleanup(permId, 'Timeout'),
    });

    // Send interactive card for user input
    const outMsg = adapter.format({
      type: 'deferredToolInput',
      chatId: msg.chatId,
      data: {
        toolName,
        prompt: config.prompt,
        permId,
        sessionId: binding.sessionId.slice(-4),
        inputRequired: config.inputRequired,
        inputPlaceholder: config.inputPlaceholder,
        defaultValue: config.defaultValue,
      },
    });

    const sendResult = await adapter.send(outMsg);
    permissions.trackPermissionMessage(sendResult.messageId, permId, binding.sessionId, msg.channelType);

    const result = await waitPromise;
    signal?.removeEventListener('abort', abortCleanup);

    if (result.behavior === 'deny') {
      this.cleanup(permId, result.message ?? 'Denied');
      adapter.editCardResolution(msg.chatId, sendResult.messageId, {
        resolution: 'skipped',
        label: '⏭ Skipped',
      }).catch(() => {});
      return { behavior: 'deny', message: 'User skipped' };
    }

    // Get user input from interaction state
    const userInput = interactionState.consumeDeferredToolInput(permId);
    interactionState.cleanupDeferredTool(permId);

    adapter.editCardResolution(msg.chatId, sendResult.messageId, {
      resolution: 'answered',
      label: userInput ? `✅ ${truncate(userInput, 50)}` : '✅ Confirmed',
    }).catch(() => {});

    // Merge user input into tool input based on tool type
    const updatedInput = this.mergeUserInput(toolName, toolInput, userInput);

    return { behavior: 'allow', updatedInput };
  }

  /** Merge user input into the original tool input */
  private mergeUserInput(
    toolName: string,
    originalInput: Record<string, unknown>,
    userInput?: string,
  ): Record<string, unknown> {
    if (!userInput) return originalInput;

    switch (toolName) {
      case 'EnterPlanMode':
        return { ...originalInput, plan: userInput };
      case 'EnterWorktree':
        return { ...originalInput, branch: userInput };
      default:
        return originalInput;
    }
  }
}