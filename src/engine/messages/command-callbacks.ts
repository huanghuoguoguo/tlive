import { CALLBACK_PREFIXES, parseCommandCallback } from '../../core/callbacks.js';
import type { CallbackHandlerContext, CallbackHandlerResult } from './callback-context.js';
import { buildReplayMessage } from './callback-context.js';

export async function handleCommandCallback(
  ctx: CallbackHandlerContext,
): Promise<CallbackHandlerResult> {
  const { adapter, msg, deps, callbackData } = ctx;

  if (callbackData.startsWith(CALLBACK_PREFIXES.SUGGEST)) {
    const suggestion = callbackData.slice(CALLBACK_PREFIXES.SUGGEST.length);
    return deps.replayMessage(adapter, buildReplayMessage(msg, suggestion));
  }

  const command = parseCommandCallback(callbackData);
  if (command) {
    await deps.replayMessage(
      adapter,
      buildReplayMessage(msg, `/${command}`, { internalCommand: true }),
    );
    return true;
  }

  if (callbackData.startsWith('cd:')) {
    const path = callbackData.slice(3);
    await deps.replayMessage(
      adapter,
      buildReplayMessage(msg, `/cd ${path}`, { internalCommand: true }),
    );
    return true;
  }

  return undefined;
}
