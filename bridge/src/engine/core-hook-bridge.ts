import { basename } from 'node:path';
import type { OutboundMessage } from '../channels/types.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { safeParseObject } from '../utils/json.js';
import { shortPath, truncate } from '../utils/index.js';
import { CHANNEL_TYPES } from '../utils/constants.js';
import type { BridgeStore } from '../store/interface.js';
import type { HookNotificationData } from './hook-notification-dispatcher.js';
import type { BridgeManager } from './bridge-manager.js';

interface CoreHookBridgeOptions {
  config: Config;
  logger: Logger;
  manager: BridgeManager;
  store: BridgeStore;
  isCoreAvailable: () => boolean;
}

interface HookTarget {
  chatId: string;
  receiveIdType?: string;
}

type PendingHookPermission = {
  id: string;
  tool_name: string;
  input: unknown;
  session_id?: string;
  permission_suggestions?: unknown[];
  created_at: string;
};

type PendingHookNotification = {
  id: string;
  message: string;
  timestamp?: string;
  [key: string]: unknown;
};

/** Bridges Go Core PTY hooks into IM-facing cards and notifications. */
export class CoreHookBridge {
  private sentPermissionIds = new Map<string, number>();
  private sentNotificationIds = new Map<string, number>();
  private sessionCwdCache = new Map<string, string>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private permissionPollTimer: ReturnType<typeof setInterval> | null = null;
  private notificationPollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly bridgeStartTime = new Date();

  constructor(private options: CoreHookBridgeOptions) {}

  async prefetchSessionCwds(): Promise<void> {
    try {
      const sessions = await this.fetchSessions();
      for (const session of sessions) {
        if (session.cwd) {
          this.sessionCwdCache.set(session.id, session.cwd);
        }
      }
      this.options.logger.info(`[bridge] Prefetched ${this.sessionCwdCache.size} session CWDs`);
    } catch {
      // Non-fatal.
    }
  }

  start(): void {
    this.stop();
    this.cleanupTimer = setInterval(() => this.cleanupStaleEntries(), 5 * 60 * 1000);
    this.permissionPollTimer = setInterval(() => {
      void this.pollPendingPermissions();
    }, 2000);
    this.notificationPollTimer = setInterval(() => {
      void this.pollNotifications();
    }, 2000);
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.permissionPollTimer) {
      clearInterval(this.permissionPollTimer);
      this.permissionPollTimer = null;
    }
    if (this.notificationPollTimer) {
      clearInterval(this.notificationPollTimer);
      this.notificationPollTimer = null;
    }
  }

  async broadcastText(text: string): Promise<void> {
    for (const adapter of this.options.manager.getAdapters()) {
      const target = this.getHookTarget(adapter.channelType);
      if (!target.chatId) {
        continue;
      }
      await adapter.send({
        chatId: target.chatId,
        receiveIdType: target.receiveIdType,
        text,
      });
    }
  }

  private cleanupStaleEntries(): void {
    const now = Date.now();
    const maxAge = 10 * 60 * 1000;
    for (const [id, timestamp] of this.sentPermissionIds) {
      if (now - timestamp > maxAge) {
        this.sentPermissionIds.delete(id);
      }
    }
    for (const [id, timestamp] of this.sentNotificationIds) {
      if (now - timestamp > maxAge) {
        this.sentNotificationIds.delete(id);
      }
    }
  }

  private getHookTarget(channelType: string): HookTarget {
    const { config, manager } = this.options;
    if (channelType === CHANNEL_TYPES.TELEGRAM) {
      return { chatId: config.telegram.chatId };
    }
    if (channelType === CHANNEL_TYPES.DISCORD) {
      return { chatId: config.discord.allowedChannels[0] || '' };
    }
    const userId = config.feishu.allowedUsers[0];
    if (userId) {
      return {
        chatId: userId,
        receiveIdType: userId.startsWith('ou_') ? 'open_id' : 'user_id',
      };
    }
    return { chatId: manager.getLastChatId(channelType) };
  }

  private async pollPendingPermissions(): Promise<void> {
    if (!this.options.isCoreAvailable()) {
      return;
    }

    try {
      const resp = await fetch(`${this.options.config.coreUrl}/api/hooks/pending`, {
        headers: { Authorization: `Bearer ${this.options.config.token}` },
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) {
        return;
      }

      const pending = await resp.json() as PendingHookPermission[];
      if (pending.length === 0) {
        return;
      }

      await this.primeUnknownSessionCwds(pending);

      for (const permission of pending) {
        if (this.sentPermissionIds.has(permission.id)) {
          continue;
        }
        this.sentPermissionIds.set(permission.id, Date.now());

        if (permission.tool_name === 'AskUserQuestion' && await this.sendAskQuestion(permission)) {
          continue;
        }

        await this.sendPermissionRequest(permission);
      }
    } catch {
      // Polling failure is non-fatal.
    }
  }

  private async pollNotifications(): Promise<void> {
    if (!this.options.isCoreAvailable()) {
      return;
    }

    try {
      const resp = await fetch(`${this.options.config.coreUrl}/api/hooks/notifications`, {
        headers: { Authorization: `Bearer ${this.options.config.token}` },
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) {
        return;
      }

      const notifications = await resp.json() as PendingHookNotification[];
      for (const notification of notifications) {
        if (this.sentNotificationIds.has(notification.id)) {
          continue;
        }
        this.sentNotificationIds.set(notification.id, Date.now());

        if (notification.timestamp && new Date(notification.timestamp) < this.bridgeStartTime) {
          continue;
        }

        let hookData: HookNotificationData = notification as unknown as HookNotificationData;
        try {
          hookData = JSON.parse(notification.message) as HookNotificationData;
        } catch {
          // Keep raw payload fallback.
        }

        if (!hookData.tlive_hook_type) {
          continue;
        }

        const sessionId = hookData.tlive_session_id;
        if (!sessionId) {
          continue;
        }

        const binding = await this.options.store.getBindingBySessionId(sessionId);
        if (!binding) {
          continue;
        }

        const adapter = this.options.manager.getAdapter(binding.channelType);
        if (!adapter) {
          continue;
        }

        try {
          await this.options.manager.sendHookNotification(adapter, binding.chatId, hookData);
        } catch (err) {
          this.options.logger.warn(`Failed to send notification to ${binding.channelType}: ${err}`);
        }
      }
    } catch {
      // Non-fatal.
    }
  }

  private async primeUnknownSessionCwds(pending: PendingHookPermission[]): Promise<void> {
    const unknownSessionIds = [...new Set(
      pending
        .map(permission => permission.session_id)
        .filter((sessionId): sessionId is string => !!sessionId && !this.sessionCwdCache.has(sessionId)),
    )];
    if (unknownSessionIds.length === 0) {
      return;
    }

    try {
      const sessions = await this.fetchSessions();
      for (const session of sessions) {
        if (session.cwd) {
          this.sessionCwdCache.set(session.id, session.cwd);
        }
      }
    } catch {
      // Non-fatal.
    }
  }

  private async fetchSessions(): Promise<Array<{ id: string; cwd?: string }>> {
    const resp = await fetch(`${this.options.config.coreUrl}/api/sessions`, {
      headers: { Authorization: `Bearer ${this.options.config.token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      return [];
    }
    return await resp.json() as Array<{ id: string; cwd?: string }>;
  }

  private async sendAskQuestion(permission: PendingHookPermission): Promise<boolean> {
    const inputData = safeParseObject(permission.input as Record<string, unknown>);
    const questions = (inputData?.questions ?? []) as Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect: boolean;
    }>;
    if (questions.length === 0) {
      return false;
    }

    const sessionId = permission.session_id || '';
    const q = questions[0];
    const contextSuffix = this.buildContextSuffix(permission.session_id);
    const header = q.header ? `📋 **${q.header}**\n\n` : '';
    const optionsList = q.options
      .map((option, index) => `${index + 1}. **${option.label}**${option.description ? ` — ${option.description}` : ''}`)
      .join('\n');
    const questionText = `${header}${q.question}\n\n${optionsList}`;
    const buttons: Array<{ label: string; callbackData: string; style: 'primary' | 'danger'; row?: number }> = q.multiSelect
      ? [
          ...q.options.map((option, index) => ({
            label: `☐ ${option.label}`,
            callbackData: `askq_toggle:${permission.id}:${index}:${sessionId}`,
            style: 'primary' as const,
            row: index,
          })),
          { label: '✅ Submit', callbackData: `askq_submit:${permission.id}:${sessionId}`, style: 'primary' as const, row: q.options.length },
          { label: '❌ Skip', callbackData: `askq_skip:${permission.id}:${sessionId}`, style: 'danger' as const, row: q.options.length },
        ]
      : [
          ...q.options.map((option, index) => ({
            label: `${index + 1}. ${option.label}`,
            callbackData: `askq:${permission.id}:${index}:${sessionId}`,
            style: 'primary' as const,
          })),
          { label: '❌ Skip', callbackData: `askq_skip:${permission.id}:${sessionId}`, style: 'danger' as const },
        ];

    this.options.manager.storeQuestionData(permission.id, questions, contextSuffix);

    for (const adapter of this.options.manager.getAdapters()) {
      const target = this.getHookTarget(adapter.channelType);
      if (!target.chatId) {
        continue;
      }

      try {
        const hint = this.askQuestionHint(adapter.channelType, q.multiSelect);
        const contextHeader = contextSuffix ? `❓ Terminal${contextSuffix}\n\n` : '';
        const outMsg: OutboundMessage = {
          chatId: target.chatId,
          receiveIdType: target.receiveIdType,
          text: adapter.channelType === CHANNEL_TYPES.FEISHU ? questionText + hint : contextHeader + questionText + hint,
          buttons,
          feishuHeader: adapter.channelType === CHANNEL_TYPES.FEISHU
            ? { template: 'blue', title: `❓ Terminal${contextSuffix}` }
            : undefined,
        };
        if (adapter.channelType === CHANNEL_TYPES.TELEGRAM) {
          outMsg.html = `<b>❓ Terminal${contextSuffix}</b>\n\n${questionText.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')}${hint}`;
          outMsg.text = undefined;
        }

        const sendResult = await adapter.send(outMsg);
        if (permission.session_id) {
          this.options.manager.trackHookMessage(sendResult.messageId, permission.session_id);
        }
        this.options.manager.trackPermissionMessage(sendResult.messageId, permission.id, permission.session_id || '', adapter.channelType);
      } catch (err) {
        this.options.logger.warn(`Failed to send question to ${adapter.channelType}: ${err}`);
      }
    }

    return true;
  }

  private async sendPermissionRequest(permission: PendingHookPermission): Promise<void> {
    const contextSuffix = this.buildContextSuffix(permission.session_id);
    const text = this.formatPermissionCard(permission.tool_name, permission.input);
    const sessionId = permission.session_id || '';
    const buttons: Array<{ label: string; callbackData: string; style: 'primary' | 'danger' }> = [
      { label: '✅ Allow', callbackData: `hook:allow:${permission.id}:${sessionId}`, style: 'primary' },
    ];
    if (permission.permission_suggestions && permission.permission_suggestions.length > 0) {
      buttons.push({ label: '📌 Always', callbackData: `hook:allow_always:${permission.id}:${sessionId}`, style: 'primary' });
    }
    buttons.push({ label: '❌ Deny', callbackData: `hook:deny:${permission.id}:${sessionId}`, style: 'danger' });

    for (const adapter of this.options.manager.getAdapters()) {
      const target = this.getHookTarget(adapter.channelType);
      if (!target.chatId) {
        continue;
      }

      try {
        const hint = this.permissionApprovalHint(adapter.channelType);
        const contextHeader = contextSuffix ? `🔐 Terminal${contextSuffix}\n\n` : '';
        const outMsg: OutboundMessage = {
          chatId: target.chatId,
          receiveIdType: target.receiveIdType,
          text: adapter.channelType === CHANNEL_TYPES.FEISHU ? text + hint : contextHeader + text + hint,
          buttons,
          feishuHeader: adapter.channelType === CHANNEL_TYPES.FEISHU
            ? { template: 'orange', title: `🔐 Terminal${contextSuffix}` }
            : undefined,
        };
        if (adapter.channelType === CHANNEL_TYPES.TELEGRAM) {
          outMsg.html = `<b>🔐 Terminal${contextSuffix}</b>\n\n${text}${hint}`;
          outMsg.text = undefined;
        }

        const sendResult = await adapter.send(outMsg);
        if (permission.session_id) {
          this.options.manager.trackHookMessage(sendResult.messageId, permission.session_id);
        }
        this.options.manager.trackPermissionMessage(sendResult.messageId, permission.id, permission.session_id || '', adapter.channelType);
        this.options.manager.storeHookPermissionText(permission.id, text);
      } catch (err) {
        this.options.logger.warn(`Failed to send permission to ${adapter.channelType}: ${err}`);
      }
    }
  }

  private buildContextSuffix(sessionId?: string): string {
    const parts: string[] = [];
    const sessionCwd = sessionId ? this.sessionCwdCache.get(sessionId) : undefined;
    if (sessionCwd) {
      parts.push(basename(sessionCwd));
    }
    if (sessionId) {
      parts.push(`#${sessionId.slice(-6)}`);
    }
    return parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
  }

  private askQuestionHint(channelType: string, multiSelect: boolean): string {
    if (multiSelect) {
      return channelType === CHANNEL_TYPES.FEISHU
        ? '\n\n💬 点击选项切换选中，然后按 Submit 确认'
        : '\n\n💬 Tap options to toggle, then Submit';
    }
    return channelType === CHANNEL_TYPES.FEISHU
      ? '\n\n💬 回复数字选择，或直接输入内容'
      : '\n\n💬 Reply with number to select, or type your answer';
  }

  private permissionApprovalHint(channelType: string): string {
    if (channelType === CHANNEL_TYPES.FEISHU) {
      return '\n\n💬 或回复 **allow** / **deny**';
    }
    if (channelType === CHANNEL_TYPES.TELEGRAM) {
      return '\n\n💬 Or reply <b>allow</b> / <b>deny</b>';
    }
    return '\n\n💬 Or reply `allow` / `deny`';
  }

  /** Format a permission card for IM display — human-readable, not raw JSON. */
  private formatPermissionCard(toolName: string, input: unknown): string {
    const parts: string[] = ['🔐 Permission Required'];
    const data = safeParseObject(input as Record<string, unknown>);

    switch (toolName) {
      case 'Bash': {
        const command = String(data.command || '');
        const description = data.description ? `\n${data.description}` : '';
        parts.push(`\n🖥 Bash${description}\n\`\`\`\n${truncate(command, 500)}\n\`\`\``);
        break;
      }
      case 'Edit': {
        const file = shortPath(String(data.file_path || ''));
        const oldText = String(data.old_string || '');
        const newText = String(data.new_string || '');
        const diffLines: string[] = [];
        for (const line of oldText.split('\n')) {
          diffLines.push(`- ${line}`);
        }
        for (const line of newText.split('\n')) {
          diffLines.push(`+ ${line}`);
        }
        parts.push(`\n📝 Edit: \`${file}\`\n\`\`\`diff\n${truncate(diffLines.join('\n'), 500)}\n\`\`\``);
        break;
      }
      case 'Write': {
        const file = shortPath(String(data.file_path || ''));
        const content = String(data.content || '');
        parts.push(`\n📄 Write: \`${file}\` (${content.length} chars)\n\`\`\`\n${truncate(content, 200)}\n\`\`\``);
        break;
      }
      case 'Read': {
        parts.push(`\n📖 Read: \`${shortPath(String(data.file_path || ''))}\``);
        break;
      }
      case 'NotebookEdit': {
        parts.push(`\n📓 NotebookEdit: \`${shortPath(String(data.file_path || ''))}\``);
        break;
      }
      case 'Skill': {
        const skillArgs = data.args ? `\nArgs: ${data.args}` : '';
        parts.push(`\n⚡ Skill: \`${String(data.skill || '')}\`${skillArgs}`);
        break;
      }
      case 'Agent': {
        const description = truncate(String(data.description || data.prompt || ''), 200);
        const agentType = data.subagent_type ? ` (${data.subagent_type})` : '';
        parts.push(`\n🤖 Agent${agentType}\n${description}`);
        break;
      }
      case 'WebFetch': {
        parts.push(`\n🌐 WebFetch: \`${data.url || ''}\``);
        break;
      }
      default: {
        const inputText = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
        parts.push(`\n🔧 ${toolName}\n\`\`\`\n${truncate(inputText, 500)}\n\`\`\``);
        break;
      }
    }

    parts.push('\n⏱ Expires in 5 minutes');
    return parts.join('');
  }
}
