import { withInboundReplyContext } from '../../channels/reply-context.js';
import type {
  CallbackHandlerContext,
  CallbackHandlerResult,
} from './callback-context.js';
import {
  parseAskqSkipCallback,
  parseAskqSubmitCallback,
  parseAskqToggleCallback,
} from './callback-utils.js';

export async function submitMultiSelectAnswer(
  ctx: CallbackHandlerContext,
  permId: string,
): Promise<boolean> {
  const { adapter, msg, deps } = ctx;
  const selected = deps.permissions.getToggledSelections(permId);
  if (selected.size === 0) {
    await adapter.send(
      withInboundReplyContext({ chatId: msg.chatId, text: '⚠️ No options selected' }, msg),
    );
    return true;
  }

  const interactionState = deps.sdkEngine.getInteractionState();
  const q = interactionState.getSdkQuestion(permId)?.questions[0];
  if (!q) {
    console.warn(`[bridge] Multi-select submission for unknown question: ${permId}`);
    return true;
  }

  const selectedLabels = [...selected]
    .sort((a, b) => a - b)
    .map((i) => q.options[i]?.label)
    .filter(Boolean);
  if (selectedLabels.length === 0) {
    await adapter.send(
      withInboundReplyContext({ chatId: msg.chatId, text: '⚠️ Invalid selection' }, msg),
    );
    return true;
  }

  interactionState.setSdkQuestionTextAnswer(permId, selectedLabels.join(','));
  adapter
    .editCardResolution(msg.chatId, msg.messageId, {
      resolution: 'answered',
      label: `✅ Selected: ${selectedLabels.join(', ')}`,
    })
    .catch(() => {});
  deps.permissions.cleanupQuestion(permId);
  deps.permissions.getGateway().resolve(permId, 'allow');
  return true;
}

export async function handleQuestionCallback(
  ctx: CallbackHandlerContext,
): Promise<CallbackHandlerResult> {
  const { adapter, msg, deps, callbackData } = ctx;

  const askqToggleParsed = parseAskqToggleCallback(callbackData);
  if (askqToggleParsed) {
    const selected = deps.permissions.toggleMultiSelectOption(
      askqToggleParsed.interactionId,
      askqToggleParsed.optionIndex,
    );
    if (selected === null) return true;

    const qData = deps.permissions.getQuestionData(askqToggleParsed.interactionId);
    if (qData) {
      const q = qData.questions[0];
      const outMsg = adapter.format({
        type: 'multiSelectToggle',
        chatId: msg.chatId,
        data: {
          question: q.question,
          header: q.header,
          options: q.options,
          selectedIndices: selected,
          permId: askqToggleParsed.interactionId,
          sessionId: askqToggleParsed.sessionId,
        },
      });
      await adapter.editMessage(msg.chatId, msg.messageId, outMsg);
    }
    return true;
  }

  const askqSubmitParsed = parseAskqSubmitCallback(callbackData);
  if (askqSubmitParsed) {
    return submitMultiSelectAnswer(ctx, askqSubmitParsed.interactionId);
  }

  const askqSkipParsed = parseAskqSkipCallback(callbackData);
  if (askqSkipParsed) {
    const interactionState = deps.sdkEngine.getInteractionState();
    const permId = askqSkipParsed.interactionId;
    deps.permissions.getGateway().resolve(permId, 'deny', 'Skipped');
    interactionState.cleanupSdkQuestion(permId);
    deps.permissions.cleanupQuestion(permId);
    adapter
      .editCardResolution(msg.chatId, msg.messageId, {
        resolution: 'skipped',
        label: '⏭ Skipped',
      })
      .catch(() => {});
    return true;
  }

  return undefined;
}

export function handleLegacyQuestionCallback(
  ctx: CallbackHandlerContext,
): CallbackHandlerResult {
  const { adapter, msg, deps, callbackData } = ctx;

  if (callbackData.includes(':askq:')) {
    const parts = callbackData.split(':');
    const askqIdx = parts.indexOf('askq');
    if (askqIdx >= 0) {
      const permId = parts.slice(2, askqIdx).join(':');
      const optionIndex = parseInt(parts[askqIdx + 1], 10);
      const interactionState = deps.sdkEngine.getInteractionState();
      const qData = interactionState.getSdkQuestion(permId);
      const selected = qData?.questions?.[0]?.options?.[optionIndex];
      if (!selected) return true;

      interactionState.setSdkQuestionOptionAnswer(permId, optionIndex);
      deps.permissions.getGateway().resolve(permId, 'allow');
      deps.permissions.cleanupQuestion(permId);
      adapter
        .editCardResolution(msg.chatId, msg.messageId, {
          resolution: 'selected',
          label: `✅ ${selected.label}`,
        })
        .catch(() => {});
      return true;
    }
  }

  if (callbackData.includes(':askq_skip')) {
    const parts = callbackData.split(':');
    const skipIdx = parts.indexOf('askq_skip');
    if (skipIdx >= 0) {
      const permId = parts.slice(2, skipIdx).join(':');
      deps.permissions.getGateway().resolve(permId, 'deny', 'Skipped');
      deps.sdkEngine.getInteractionState().cleanupSdkQuestion(permId);
      deps.permissions.cleanupQuestion(permId);
      adapter
        .editCardResolution(msg.chatId, msg.messageId, {
          resolution: 'skipped',
          label: '⏭ Skipped',
        })
        .catch(() => {});
      return true;
    }
  }

  return undefined;
}

