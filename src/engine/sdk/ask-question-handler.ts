/**
 * SDK AskUserQuestion Handler — handles AskUserQuestion tool during query execution.
 * Extracted from QueryOrchestrator for cleaner architecture.
 */

import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import type { PermissionCoordinator } from '../coordinators/permission.js';
import type { InteractionState } from '../state/interaction-state.js';
import { truncate } from '../../core/string.js';
import { generateId } from '../../core/id.js';
import { DEFAULT_PERMISSION_TIMEOUT_MS } from '../../engine/constants.js';

interface SDKAskQuestionHandlerContext {
  adapter: BaseChannelAdapter;
  msg: InboundMessage;
  binding: { sessionId: string; sdkSessionId?: string };
  permissions: PermissionCoordinator;
  interactionState: InteractionState;
}

export class SDKAskQuestionHandler {
  private context: SDKAskQuestionHandlerContext;
  /** Callback to set askQuestionApproved on permission handler */
  private onApproved?: () => void;

  constructor(context: SDKAskQuestionHandlerContext) {
    this.context = context;
  }

  /** Set callback to notify permission handler when question is approved */
  setOnApproved(callback: () => void): void {
    this.onApproved = callback;
  }

  /** Main handler for SDK AskUserQuestion requests */
  async handle(
    questions: Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect: boolean;
    }>,
    signal?: AbortSignal,
  ): Promise<Record<string, string>> {
    if (!questions.length) return {};
    const answers: Record<string, string> = {};
    const { adapter, msg, binding, permissions, interactionState } = this.context;

    for (const q of questions) {
      const permId = generateId('askq');
      const isMulti = q.multiSelect;
      interactionState.beginSdkQuestion(permId, [q], msg.chatId);
      if (isMulti) {
        permissions.storeQuestionData(permId, [q]);
      }

      const abortCleanup = () => {
        permissions.getGateway().resolve(permId, 'deny', 'Cancelled');
        interactionState.cleanupSdkQuestion(permId);
        permissions.cleanupQuestion(permId);
      };
      if (signal?.aborted) {
        abortCleanup();
        throw new Error('Cancelled');
      }
      signal?.addEventListener('abort', abortCleanup, { once: true });

      const waitPromise = permissions.getGateway().waitFor(permId, {
        timeoutMs: DEFAULT_PERMISSION_TIMEOUT_MS,
        onTimeout: () => {
          interactionState.cleanupSdkQuestion(permId);
          permissions.cleanupQuestion(permId);
        },
      });

      const outMsg = adapter.format({
        type: 'question',
        chatId: msg.chatId,
        data: {
          question: q.question,
          header: q.header,
          options: q.options,
          multiSelect: isMulti,
          permId,
          sessionId: 'sdk',
        },
      });
      const sendResult = await adapter.send(outMsg);
      permissions.trackPermissionMessage(sendResult.messageId, permId, binding.sessionId, msg.channelType);

      const result = await waitPromise;
      signal?.removeEventListener('abort', abortCleanup);

      if (result.behavior === 'deny') {
        interactionState.cleanupSdkQuestion(permId);
        permissions.cleanupQuestion(permId);
        adapter.editCardResolution(msg.chatId, sendResult.messageId, {
          resolution: 'skipped', label: '⏭ Skipped',
        }).catch(() => {});
        throw new Error('User skipped question');
      }

      const { textAnswer, optionIndex } = interactionState.consumeSdkQuestionAnswer(permId);
      interactionState.cleanupSdkQuestion(permId);
      permissions.cleanupQuestion(permId);

      if (textAnswer !== undefined) {
        adapter.editCardResolution(msg.chatId, sendResult.messageId, {
          resolution: 'answered', label: `✅ Answer: ${truncate(textAnswer, 50)}`,
        }).catch(() => {});
        answers[q.question] = textAnswer;
        continue;
      }

      const selected = optionIndex !== undefined ? q.options[optionIndex] : undefined;
      const answerLabel = selected?.label ?? '';

      if (!selected) {
        adapter.editCardResolution(msg.chatId, sendResult.messageId, {
          resolution: 'answered', label: '✅ Answered',
        }).catch(() => {});
      }

      answers[q.question] = answerLabel;
    }

    // Notify permission handler to auto-allow next tool
    this.onApproved?.();
    return answers;
  }
}