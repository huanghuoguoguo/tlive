/**
 * SDK Deferred Tool Handler — handles EnterPlanMode, EnterWorktree, etc.
 * These tools need interactive user input beyond simple permission approval.
 */

import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import type { PermissionCoordinator } from '../coordinators/permission.js';
import type { InteractionState } from '../state/interaction-state.js';
import type { Locale, TranslationKey } from '../../../shared/i18n/index.js';
import { truncate } from '../../../shared/core/string.js';
import { generateId } from '../../../shared/core/id.js';
import { DEFAULT_PERMISSION_TIMEOUT_MS } from '../../../shared/core/timing.js';
import { conversationScopeId } from '../../channels/conversation-context.js';
import { withInboundReplyContext } from '../../channels/reply-context.js';
import { isDeferredToolName, type DeferredToolName } from '../../../client/providers/deferred-tools.js';
import { t } from '../../../shared/i18n/index.js';

/** Translation keys for deferred tool prompts */
const DEFERRED_TOOL_PROMPT_KEYS: Record<DeferredToolName, { prompt: TranslationKey; placeholder: TranslationKey }> = {
  EnterPlanMode: {
    prompt: 'deferredTool.planModePrompt',
    placeholder: 'deferredTool.planModePlaceholder',
  },
  EnterWorktree: {
    prompt: 'deferredTool.worktreePrompt',
    placeholder: 'deferredTool.worktreePlaceholder',
  },
};

interface SDKDeferredToolHandlerContext {
  adapter: BaseChannelAdapter;
  msg: InboundMessage;
  binding: { sessionId: string; sdkSessionId?: string };
  permissions: PermissionCoordinator;
  interactionState: InteractionState;
  locale: Locale;
}

export class SDKDeferredToolHandler {
  private context: SDKDeferredToolHandlerContext;
  private cleanedUp = false;

  constructor(context: SDKDeferredToolHandlerContext) {
    this.context = context;
  }

  /** Check if a tool is a deferred tool that needs interactive input */
  static isDeferredTool(toolName: string): boolean {
    return isDeferredToolName(toolName);
  }

  /** Get prompt and placeholder for a deferred tool */
  static getToolPrompt(toolName: DeferredToolName, _locale: Locale): { prompt: string; placeholder: string } {
    const keys = DEFERRED_TOOL_PROMPT_KEYS[toolName];
    return {
      prompt: t(keys.prompt),
      placeholder: t(keys.placeholder),
    };
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
  ): Promise<{
    behavior: 'allow' | 'deny';
    updatedInput?: Record<string, unknown>;
    message?: string;
  }> {
    const { adapter, msg, binding, permissions, interactionState, locale } = this.context;
    const permId = generateId('defer');

    let prompt: string;
    let inputPlaceholder: string;

    if (isDeferredToolName(toolName)) {
      const toolPrompt = SDKDeferredToolHandler.getToolPrompt(toolName, locale);
      prompt = toolPrompt.prompt;
      inputPlaceholder = toolPrompt.placeholder;
    } else {
      prompt = t('deferredTool.toolInputPrompt').replace('{toolName}', toolName);
      inputPlaceholder = t('deferredTool.toolInputPlaceholder');
    }

    // Track pending deferred tool state (only in InteractionState, not PermissionCoordinator)
    interactionState.beginDeferredTool(permId, toolName, conversationScopeId(msg));

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
        prompt,
        permId,
        sessionId: binding.sessionId.slice(-4),
        inputRequired: false,
        inputPlaceholder,
        defaultValue: '',
      },
    });

    const sendResult = await adapter.send(withInboundReplyContext(outMsg, msg));
    permissions.trackPermissionMessage(
      sendResult.messageId,
      permId,
      binding.sessionId,
      msg.channelType,
    );

    const result = await waitPromise;
    signal?.removeEventListener('abort', abortCleanup);

    if (result.behavior === 'deny') {
      this.cleanup(permId, result.message ?? 'Denied');
      adapter
        .editCardResolution(msg.chatId, sendResult.messageId, {
          resolution: 'skipped',
          label: '⏭ Skipped',
        })
        .catch(() => {});
      return { behavior: 'deny', message: 'User skipped' };
    }

    // Get user input from interaction state
    const userInput = interactionState.consumeDeferredToolInput(permId);
    interactionState.cleanupDeferredTool(permId);

    adapter
      .editCardResolution(msg.chatId, sendResult.messageId, {
        resolution: 'answered',
        label: userInput ? `✅ ${truncate(userInput, 50)}` : '✅ Confirmed',
      })
      .catch(() => {});

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
