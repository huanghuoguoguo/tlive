import type { InboundMessage } from '../types.js';
import { t } from '../../i18n/index.js';
import { feishuInboundScope } from './inbound.js';

const FEISHU_MENU_EVENT_TO_COMMAND: Record<string, string> = {
  tlive_home: '/home',
  tlive_status: '/home',
  tlive_help: '/home',
};

export interface FeishuCardActionResult {
  message?: InboundMessage;
  response: Record<string, unknown>;
  missingAction?: boolean;
}

export function feishuCardActionToInbound(data: unknown): FeishuCardActionResult {
  const event = data as {
    operator?: { user_id?: string; open_id?: string };
    action?: {
      name?: string;
      value?: Record<string, string>;
      form_value?: Record<string, string>;
    };
    context?: {
      chat_id?: string;
      open_chat_id?: string;
      open_message_id?: string;
      thread_id?: string;
    };
  };

  const formValue = event?.action?.form_value;
  if (formValue && Object.keys(formValue).length > 0) {
    const interactionId =
      formValue._interaction_id || event?.action?.name || inferFormInteractionId(formValue);
    return {
      message: {
        ...cardActionBaseMessage(event),
        text: '',
        callbackData: `form:${interactionId}:${JSON.stringify(formValue)}`,
      },
      response: successToast(t('adapter.submitted')),
    };
  }

  const action = event?.action?.value?.action;
  if (!action) {
    return { response: {}, missingAction: true };
  }

  return {
    message: {
      ...cardActionBaseMessage(event),
      text: '',
      callbackData: action,
    },
    response: successToast(t('adapter.processing')),
  };
}

function inferFormInteractionId(formValue: Record<string, string>): string {
  if ('_tlive_command' in formValue || 'tlive_command' in formValue) {
    return 'tlive_command';
  }
  return '';
}

export function feishuMenuEventToInbound(
  data: unknown,
  now = Date.now(),
): InboundMessage | undefined {
  const event = data as {
    event_key?: string;
    operator?: {
      operator_id?: {
        user_id?: string;
        open_id?: string;
      };
    };
  };
  const command = event?.event_key ? FEISHU_MENU_EVENT_TO_COMMAND[event.event_key] : undefined;
  if (!command) return undefined;

  return {
    channelType: 'feishu',
    chatId: '',
    userId: event?.operator?.operator_id?.user_id || event?.operator?.operator_id?.open_id || '',
    text: command,
    messageId: `menu:${event?.event_key ?? 'unknown'}:${now}`,
  };
}

function cardActionBaseMessage(event: {
  operator?: { user_id?: string; open_id?: string };
  context?: {
    chat_id?: string;
    open_chat_id?: string;
    open_message_id?: string;
    thread_id?: string;
  };
}): Omit<InboundMessage, 'text' | 'attachments'> {
  const chatId = event?.context?.chat_id || event?.context?.open_chat_id || '';
  const messageId = event?.context?.open_message_id || '';
  const threadId = event?.context?.thread_id || undefined;
  return {
    channelType: 'feishu',
    chatId,
    scopeId: feishuInboundScope(chatId, threadId),
    threadId,
    replyInThread: !!threadId,
    userId: event?.operator?.user_id || event?.operator?.open_id || '',
    messageId,
    replyTargetMessageId: threadId ? messageId : undefined,
  };
}

function successToast(content: string): Record<string, unknown> {
  return {
    toast: {
      type: 'success',
      content,
    },
  };
}
