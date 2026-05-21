import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import type {
  CallbackDispatcherDeps,
  CallbackHandlerContext,
  CallbackHandlerResult,
} from './callback-context.js';
import {
  inferThreadContextFromBubble,
} from './callback-context.js';
import { handleCommandCallback } from './command-callbacks.js';
import { handleDeferredCallback } from './deferred-callbacks.js';
import { handleFormCallback } from './form-callbacks.js';
import {
  handleLegacyQuestionCallback,
  handleQuestionCallback,
} from './question-callbacks.js';

type CallbackHandler = (
  ctx: CallbackHandlerContext,
) => CallbackHandlerResult | Promise<CallbackHandlerResult>;

const CALLBACK_HANDLERS: CallbackHandler[] = [
  handleCommandCallback,
  handleQuestionCallback,
  handleDeferredCallback,
  handleFormCallback,
  handleLegacyQuestionCallback,
];

export async function handleCallbackMessage(
  adapter: BaseChannelAdapter,
  rawMsg: InboundMessage,
  deps: CallbackDispatcherDeps,
): Promise<boolean> {
  const msg = inferThreadContextFromBubble(rawMsg, deps);
  if (!msg.callbackData) return false;

  const ctx: CallbackHandlerContext = {
    adapter,
    msg,
    deps,
    callbackData: msg.callbackData,
  };

  for (const handler of CALLBACK_HANDLERS) {
    const handled = await handler(ctx);
    if (handled !== undefined) {
      return handled;
    }
  }

  if (deps.permissions.handlePermissionCallback(msg.callbackData)) {
    return true;
  }

  console.warn(`[bridge] Unknown callback ignored: ${msg.callbackData}`);
  return false;
}
