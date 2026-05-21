import type {
  CallbackHandlerContext,
  CallbackHandlerResult,
} from './callback-context.js';
import {
  parseDeferredSkipCallback,
  parseDeferredSubmitCallback,
} from './callback-utils.js';

export function handleDeferredCallback(ctx: CallbackHandlerContext): CallbackHandlerResult {
  const { adapter, msg, deps, callbackData } = ctx;

  const deferredSubmitParsed = parseDeferredSubmitCallback(callbackData);
  if (deferredSubmitParsed) {
    const permId = deferredSubmitParsed.permId;
    const interactionState = deps.sdkEngine.getInteractionState();
    const deferredData = interactionState.getDeferredTool(permId);
    if (deferredData) {
      adapter
        .editCardResolution(msg.chatId, msg.messageId, {
          resolution: 'answered',
          label: '✅ Submitted',
        })
        .catch(() => {});
    }
    deps.permissions.getGateway().resolve(permId, 'allow');
    return true;
  }

  const deferredSkipParsed = parseDeferredSkipCallback(callbackData);
  if (deferredSkipParsed) {
    const permId = deferredSkipParsed.permId;
    deps.permissions.getGateway().resolve(permId, 'deny', 'Skipped');
    deps.sdkEngine.getInteractionState().cleanupDeferredTool(permId);
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

