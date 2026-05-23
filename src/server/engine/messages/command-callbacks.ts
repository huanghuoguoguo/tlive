import {
  CALLBACK_PREFIXES,
  parseActionCallback,
  parseCommandCallback,
} from '../../../shared/core/callbacks.js';
import type { CallbackHandlerContext, CallbackHandlerResult } from './callback-context.js';
import { buildActionMessage, buildReplayMessage } from './callback-context.js';

export async function handleCommandCallback(
  ctx: CallbackHandlerContext,
): Promise<CallbackHandlerResult> {
  const { adapter, msg, deps, callbackData } = ctx;

  if (callbackData.startsWith(CALLBACK_PREFIXES.SUGGEST)) {
    const suggestion = callbackData.slice(CALLBACK_PREFIXES.SUGGEST.length);
    return deps.replayMessage(adapter, buildReplayMessage(msg, suggestion));
  }

  const action = parseActionCallback(callbackData);
  if (action) {
    await deps.runAction(adapter, buildActionMessage(msg, action), action);
    return true;
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
