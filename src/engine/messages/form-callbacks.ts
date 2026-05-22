import { withInboundReplyContext } from '../../channels/reply-context.js';
import { truncate } from '../../core/string.js';
import type { CallbackHandlerContext, CallbackHandlerResult } from './callback-context.js';
import { parseFormCallback } from './callback-utils.js';
import { submitMultiSelectAnswer } from './question-callbacks.js';

export async function handleFormCallback(
  ctx: CallbackHandlerContext,
): Promise<CallbackHandlerResult> {
  const { adapter, msg, deps, callbackData } = ctx;
  const formParsed = parseFormCallback(callbackData);
  if (!formParsed) return undefined;

  const { interactionId, formData } = formParsed;
  const permId = interactionId;
  const interactionState = deps.sdkEngine.getInteractionState();

  if (interactionId === 'tlive_command') {
    const commandInput = (formData._tlive_command || formData.tlive_command || '').trim();

    if (!commandInput) {
      await adapter.send(
        withInboundReplyContext(
          {
            chatId: msg.chatId,
            text: '⚠️ 请输入 TLive 命令。',
          },
          msg,
        ),
      );
      return true;
    }

    const [rawName = '', ...args] = commandInput.replace(/^\//, '').split(/\s+/);
    await deps.runAction(adapter, msg, { name: rawName, args });
    return true;
  }

  const deferredData = interactionState.getDeferredTool(permId);
  if (deferredData) {
    const deferredInput = (formData._deferred_input || formData.deferred_input || '').trim();
    if (deferredInput) {
      interactionState.setDeferredToolInput(permId, deferredInput);
      adapter
        .editCardResolution(msg.chatId, msg.messageId, {
          resolution: 'answered',
          label: `✅ Input: ${truncate(deferredInput, 50)}`,
        })
        .catch(() => {});
      deps.permissions.getGateway().resolve(permId, 'allow');
      return true;
    }

    deps.permissions.getGateway().resolve(permId, 'allow');
    return true;
  }

  const qData = interactionState.getSdkQuestion(permId);
  if (!qData) {
    console.warn(`[bridge] Form submission for unknown question: ${permId}`);
    return true;
  }

  const q = qData.questions[0];
  const textAnswer = (formData._text_answer || formData.text || '').trim();
  if (textAnswer) {
    interactionState.setSdkQuestionTextAnswer(permId, textAnswer);
    adapter
      .editCardResolution(msg.chatId, msg.messageId, {
        resolution: 'answered',
        label: `✅ Answer: ${truncate(textAnswer, 50)}`,
      })
      .catch(() => {});
    deps.permissions.cleanupQuestion(permId);
    deps.permissions.getGateway().resolve(permId, 'allow');
    return true;
  }

  const selectValue = (formData._select || '').trim();
  if (selectValue) {
    const optionIndex = q.options.findIndex((opt) => opt.label === selectValue);
    if (optionIndex >= 0) {
      interactionState.setSdkQuestionOptionAnswer(permId, optionIndex);
      adapter
        .editCardResolution(msg.chatId, msg.messageId, {
          resolution: 'selected',
          label: `✅ ${selectValue}`,
        })
        .catch(() => {});
      deps.permissions.cleanupQuestion(permId);
      deps.permissions.getGateway().resolve(permId, 'allow');
      return true;
    }

    if (msg.chatId) {
      await adapter.send(
        withInboundReplyContext(
          {
            chatId: msg.chatId,
            text: '⚠️ Invalid selection, please try again.',
          },
          msg,
        ),
      );
    }
    return true;
  }

  if (q.multiSelect) {
    return submitMultiSelectAnswer(ctx, permId);
  }

  if (msg.chatId) {
    await adapter.send(
      withInboundReplyContext(
        {
          chatId: msg.chatId,
          text: '⚠️ Please enter an answer or choose an option before submitting.',
        },
        msg,
      ),
    );
  }
  return true;
}
