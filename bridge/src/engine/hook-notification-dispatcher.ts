import { basename } from 'node:path';
import type { BaseChannelAdapter } from '../channels/base.js';
import type { OutboundMessage } from '../channels/types.js';
import type { PermissionCoordinator } from './permission-coordinator.js';
import { truncate } from '../utils/string.js';

/** Data shape for hook notifications (stop, idle_prompt, etc.) from Go Core */
export interface HookNotificationData {
  tlive_hook_type?: string;
  tlive_session_id?: string;
  tlive_cwd?: string;
  notification_type?: string;
  message?: string;
  last_assistant_message?: string;
  last_output?: string;
  [key: string]: unknown;
}

interface HookNotificationDispatcherOptions {
  permissions: PermissionCoordinator;
  isCoreAvailable: () => boolean;
  buildTerminalUrl: (sessionId: string) => string;
}

/**
 * Formats and dispatches hook notifications to IM adapters, while tracking the
 * resulting IM message for later reply routing.
 */
export class HookNotificationDispatcher {
  constructor(private options: HookNotificationDispatcherOptions) {}

  async send(
    adapter: BaseChannelAdapter,
    chatId: string,
    hook: HookNotificationData,
    receiveIdType?: string,
  ): Promise<void> {
    const { formatNotification } = await import('../formatting/index.js');
    const hookType = hook.tlive_hook_type || '';

    let title: string;
    let type: 'stop' | 'idle_prompt' | 'generic';
    let summary: string | undefined;

    const contextParts: string[] = [];
    if (hook.tlive_cwd) {
      const projectName = basename(hook.tlive_cwd || '') || '';
      if (projectName) contextParts.push(projectName);
    }
    if (hook.tlive_session_id) {
      contextParts.push(`#${hook.tlive_session_id.slice(-6)}`);
    }
    const contextSuffix = contextParts.length > 0 ? ` · ${contextParts.join(' · ')}` : '';

    if (hookType === 'stop') {
      type = 'stop';
      const raw = (hook.last_assistant_message || hook.last_output || '').trim();
      summary = raw ? truncate(raw, 3000) : undefined;
      title = `Terminal${contextSuffix}`;
    } else if (hook.notification_type === 'idle_prompt') {
      title = `Terminal${contextSuffix} · ${hook.message || 'Waiting for input...'}`;
      type = 'idle_prompt';
    } else {
      title = hook.message || 'Notification';
      type = 'generic';
    }

    const terminalUrl = this.options.isCoreAvailable() && hook.tlive_session_id
      ? this.options.buildTerminalUrl(hook.tlive_session_id)
      : undefined;

    const formatted = formatNotification({ type, title, summary, terminalUrl }, adapter.channelType as any);

    const outMsg: OutboundMessage = {
      chatId,
      text: formatted.text,
      html: formatted.html,
      embed: formatted.embed,
      buttons: (formatted as any).buttons,
      feishuHeader: formatted.feishuHeader,
      feishuElements: (formatted as any).feishuElements,
      receiveIdType,
    };
    const result = await adapter.send(outMsg);
    this.options.permissions.trackHookMessage(result.messageId, hook.tlive_session_id || '');
  }
}
