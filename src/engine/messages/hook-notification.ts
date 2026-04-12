import { basename } from 'node:path';
import type { BaseChannelAdapter } from '../../channels/base.js';
import type { FeishuRenderedMessage } from '../../platforms/feishu/types.js';
import type { PermissionCoordinator } from '../coordinators/permission.js';
import type { NotificationData } from '../../formatting/message-types.js';
import { truncate } from '../../utils/string.js';

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
    const hookType = hook.tlive_hook_type || '';

    let type: 'stop' | 'idle_prompt' | 'generic';
    let summary: string | undefined;
    let title: string;

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

    const terminalUrl = hook.tlive_session_id
      ? this.options.buildTerminalUrl(hook.tlive_session_id)
      : undefined;

    const data: NotificationData = {
      type,
      title,
      summary,
      terminalUrl,
      sessionId: hook.tlive_session_id,
      cwd: hook.tlive_cwd,
    };

    const msg = adapter.format({ type: 'notification', chatId, data });
    // Only Feishu supports receiveIdType
    if (receiveIdType && adapter.channelType === 'feishu') {
      (msg as FeishuRenderedMessage).receiveIdType = receiveIdType;
    }
    const result = await adapter.send(msg);
    this.options.permissions.trackHookMessage(result.messageId, hook.tlive_session_id || '');
  }
}
