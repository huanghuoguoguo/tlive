import type { BaseChannelAdapter } from '../../channels/base.js';
import type { InboundMessage } from '../../channels/types.js';
import {
  parseActionCallback,
  parseCommandCallback,
  type ActionCallback,
} from '../../core/callbacks.js';
import { THREAD_SCOPE_SEPARATOR, threadIdFromScope } from '../../core/key.js';
import type { PermissionCoordinator } from '../coordinators/permission.js';
import type { SDKEngine } from '../sdk/engine.js';

export interface CallbackDispatcherDeps {
  permissions: PermissionCoordinator;
  sdkEngine: SDKEngine;
  replayMessage: (adapter: BaseChannelAdapter, msg: InboundMessage) => Promise<boolean>;
  runAction: (
    adapter: BaseChannelAdapter,
    msg: InboundMessage,
    action: ActionCallback,
  ) => Promise<boolean>;
}

export interface CallbackHandlerContext {
  adapter: BaseChannelAdapter;
  msg: InboundMessage;
  deps: CallbackDispatcherDeps;
  callbackData: string;
}

export type CallbackHandlerResult = boolean | undefined;

function inheritInboundContext(
  msg: InboundMessage,
): Pick<
  InboundMessage,
  'scopeId' | 'threadId' | 'replyInThread' | 'replyTargetMessageId' | 'replyToMessageId'
> {
  return {
    scopeId: msg.scopeId,
    threadId: msg.threadId,
    replyInThread: msg.replyInThread,
    replyTargetMessageId: msg.replyTargetMessageId,
    replyToMessageId: msg.replyToMessageId,
  };
}

export function buildReplayMessage(
  msg: InboundMessage,
  text: string,
  opts: { internalCommand?: boolean } = {},
): InboundMessage {
  return {
    channelType: msg.channelType,
    chatId: msg.chatId,
    ...inheritInboundContext(msg),
    text,
    userId: msg.userId,
    messageId: msg.messageId,
    internalCommand: opts.internalCommand,
  };
}

export function buildActionMessage(msg: InboundMessage, action: ActionCallback): InboundMessage {
  if (!action.route) return msg;
  const replyTargetMessageId =
    action.route.replyTargetMessageId ??
    msg.replyTargetMessageId ??
    (action.route.threadId ? msg.messageId : undefined);

  return {
    ...msg,
    scopeId: action.route.scopeId ?? msg.scopeId,
    threadId: action.route.threadId ?? msg.threadId,
    replyInThread: action.route.replyInThread ?? msg.replyInThread,
    replyTargetMessageId,
    replyToMessageId: msg.replyToMessageId,
  };
}

function explicitSessionKeyFromCallback(callbackData?: string): string | undefined {
  const action = parseActionCallback(callbackData);
  if (action?.name === 'stop') return action.args[0]?.trim() || undefined;
  const command = parseCommandCallback(callbackData);
  if (!command?.startsWith('stop ')) return undefined;
  return command.slice('stop '.length).trim() || undefined;
}

export function inferThreadContextFromBubble(
  msg: InboundMessage,
  deps: CallbackDispatcherDeps,
): InboundMessage {
  if (msg.threadId || msg.scopeId?.includes(THREAD_SCOPE_SEPARATOR)) return msg;

  const sessionKey =
    explicitSessionKeyFromCallback(msg.callbackData) ??
    (msg.messageId ? deps.sdkEngine.getSessionForBubble(msg.messageId) : undefined);
  const managed = sessionKey ? deps.sdkEngine.getSessionContext(sessionKey) : undefined;
  const threadId = managed ? threadIdFromScope(msg.chatId, managed.chatId) : undefined;
  if (!managed || !threadId) return msg;

  return {
    ...msg,
    scopeId: managed.chatId,
    threadId,
    replyInThread: true,
    replyTargetMessageId: msg.messageId,
  };
}
