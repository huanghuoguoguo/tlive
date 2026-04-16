/**
 * Base message formatter with platform-aware formatting.
 * Adapters can override specific methods for custom rendering.
 *
 * @typeParam TRendered - Platform-specific rendered message type
 */

import type { Button } from '../ui/types.js';
import {
  permissionButtons,
  deferredSubmit,
  deferredSkip,
  homeButtons,
  progressDoneButtons,
  progressRunningButtons,
  taskStartButtons,
  taskSummaryButtons,
  permStatusButtons,
} from '../ui/buttons.js';
import type {
  StatusData,
  PermissionData,
  QuestionData,
  DeferredToolInputData,
  NotificationData,
  HomeData,
  PermissionStatusData,
  TaskStartData,
  SessionsData,
  SessionDetailData,
  HelpData,
  NewSessionData,
  ErrorData,
  ProgressData,
  TaskSummaryData,
  CardResolutionData,
  VersionUpdateData,
  MultiSelectToggleData,
  QueueStatusData,
  DiagnoseData,
  ProjectListData,
  ProjectInfoData,
  RecentProjectsData,
  FormattableMessage,
} from './message-types.js';
import { truncate } from '../utils/string.js';
import { AVERAGE_TURN_SECONDS } from '../utils/constants.js';
import { t, type Locale, type TranslationKey } from '../i18n/index.js';

/** @deprecated Use `Locale` from `../i18n/index.js` instead */
export type MessageLocale = Locale;

export abstract class MessageFormatter<TRendered extends { chatId: string }> {
  constructor(protected locale: Locale = 'en') {}

  /** Look up a translation for the current locale */
  protected t(key: TranslationKey): string {
    return t(this.locale, key);
  }

  // --- Abstract methods that subclasses must implement --

  /** Format markdown content for this platform (e.g., HTML for Telegram) */
  protected abstract formatMarkdown(text: string): string;

  /** Check if platform supports native buttons */
  protected abstract supportsButtons(): boolean;

  /** Create a platform-specific message. Subclasses implement to return their type. */
  protected abstract createMessage(chatId: string, text: string, buttons?: Button[]): TRendered;

  /** Public accessor for locale */
  getLocale(): Locale {
    return this.locale;
  }

  // --- Generic format method --

  /** Format a semantic message into a platform-specific rendered message */
  format(msg: FormattableMessage): TRendered {
    const { type, chatId } = msg;
    switch (type) {
      case 'status':
        return this.formatStatus(chatId, msg.data);
      case 'permission':
        return this.formatPermission(chatId, msg.data);
      case 'question':
        return this.formatQuestion(chatId, msg.data);
      case 'deferredToolInput':
        return this.formatDeferredToolInput(chatId, msg.data);
      case 'notification':
        return this.formatNotification(chatId, msg.data);
      case 'home':
        return this.formatHome(chatId, msg.data);
      case 'permissionStatus':
        return this.formatPermissionStatus(chatId, msg.data);
      case 'taskStart':
        return this.formatTaskStart(chatId, msg.data);
      case 'sessions':
        return this.formatSessions(chatId, msg.data);
      case 'sessionDetail':
        return this.formatSessionDetail(chatId, msg.data);
      case 'help':
        return this.formatHelp(chatId, msg.data);
      case 'newSession':
        return this.formatNewSession(chatId, msg.data);
      case 'error':
        return this.formatError(chatId, msg.data);
      case 'progress':
        return this.formatProgress(chatId, msg.data);
      case 'taskSummary':
        return this.formatTaskSummary(chatId, msg.data);
      case 'cardResolution':
        return this.formatCardResolution(chatId, msg.data);
      case 'versionUpdate':
        return this.formatVersionUpdate(chatId, msg.data);
      case 'multiSelectToggle':
        return this.formatMultiSelectToggle(chatId, msg.data);
      case 'queueStatus':
        return this.formatQueueStatus(chatId, msg.data);
      case 'diagnose':
        return this.formatDiagnose(chatId, msg.data);
      case 'projectList':
        return this.formatProjectList(chatId, msg.data);
      case 'projectInfo':
        return this.formatProjectInfo(chatId, msg.data);
      case 'recentProjects':
        return this.formatRecentProjects(chatId, msg.data);
      default:
        throw new Error(`Unknown message type: ${(msg as any).type}`);
    }
  }

  // --- Public formatting methods --

  formatStatus(chatId: string, data: StatusData): TRendered {
    const status = data.healthy ? '🟢 running' : '🔴 disconnected';

    // Channel details with bot info
    const channelDetails = data.channelInfo?.map(ch => {
      if (ch.name) return `${ch.type} (@${ch.name})`;
      if (ch.id) return `${ch.type} (${ch.id})`;
      return ch.type;
    }) || data.channels;

    const lines = [
      `**TLive Status**`,
      ``,
      `State: ${status}`,
      `Channels: ${channelDetails.join(', ') || 'none'}`,
    ];

    if (data.activeSessions !== undefined) {
      const sessionText = `${data.activeSessions} active` +
        (data.idleSessions ? ` / ${data.idleSessions} idle` : '');
      lines.push(`Sessions: ${sessionText}`);
    }

    if (data.memoryUsage) lines.push(`Memory: ${data.memoryUsage}`);
    if (data.uptimeSeconds !== undefined) {
      const uptime = this.formatUptime(data.uptimeSeconds);
      lines.push(`Uptime: ${uptime}`);
    }
    if (data.version) lines.push(`Version: \`v${data.version}\``);
    if (data.cwd) lines.push(`Directory: \`${data.cwd}\``);
    if (data.sessionId) lines.push(`Session: #${data.sessionId.slice(-6)}`);

    return this.createMessage(chatId, lines.join('\n'));
  }

  protected formatUptime(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) {
      const hours = Math.floor(seconds / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      return `${hours}h${mins}m`;
    }
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    return `${days}d${hours}h`;
  }

  formatPermission(chatId: string, data: PermissionData): TRendered {
    const input = truncate(data.toolInput, 300);
    const expires = data.expiresInMinutes ?? 5;
    const buttons = permissionButtons(data.permissionId, this.locale);

    const lines = [
      `🔐 **Permission Required**`,
      ``,
      `**Tool:** \`${data.toolName}\``,
      '```',
      input,
      '```',
      ``,
      `⏱ Expires in ${expires} minutes`,
    ];
    if (data.terminalUrl) {
      lines.push(`🔗 [Open Terminal](${data.terminalUrl})`);
    }
    lines.push('', `💬 Or reply **allow** / **deny** / **always**`);

    const msg = this.createMessage(chatId, lines.join('\n'), buttons);
    return msg;
  }

  formatQuestion(chatId: string, data: QuestionData): TRendered {
    const { question, header, options, multiSelect, permId, sessionId } = data;

    const headerLine = header ? `📋 **${header}**\n\n` : '';
    const optionsList = options
      .map((opt, i) => `${i + 1}. **${opt.label}**${opt.description ? ` — ${opt.description}` : ''}`)
      .join('\n');
    const text = `${headerLine}${question}\n\n${optionsList}`;

    const buttons: Button[] = multiSelect
      ? this.buildMultiSelectButtons(permId, sessionId, options)
      : this.buildSingleSelectButtons(permId, options);

    const hint = multiSelect
      ? `\n\n${this.t('question.multiSelectHint')}`
      : `\n\n${this.t('question.singleSelectHint')}`;

    return this.createMessage(chatId, text + hint, buttons);
  }

  formatDeferredToolInput(chatId: string, data: DeferredToolInputData): TRendered {
    const { toolName, prompt, permId } = data;

    const text = [
      this.t('deferred.title'),
      '',
      `**${this.t('deferred.toolLabel')}:** ${toolName}`,
      `**${this.t('deferred.descLabel')}:** ${prompt}`,
      '',
      this.t('deferred.inputHint'),
    ].join('\n');

    const buttons: Button[] = [
      deferredSubmit(permId, this.locale),
      deferredSkip(permId, this.locale),
    ];

    return this.createMessage(chatId, text, buttons);
  }

  formatNotification(chatId: string, data: NotificationData): TRendered {
    const emojiMap = { stop: '✅', idle_prompt: '⏳', generic: '📢' };
    const emoji = emojiMap[data.type];
    const summary = data.summary ? truncate(data.summary, 3000) : undefined;

    const lines = [`**${emoji} ${data.title}**`];
    if (summary) lines.push('', summary);
    if (data.terminalUrl) lines.push('', `🔗 [Open Terminal](${data.terminalUrl})`);

    return this.createMessage(chatId, lines.join('\n'));
  }

  formatHome(chatId: string, data: HomeData): TRendered {
    const taskStatus = data.task.active
      ? this.t('home.taskActive')
      : this.t('home.taskIdle');

    const lines = [
      `🏠 **TLive**`,
      ``,
      `**Status:** ${taskStatus}`,
      `**Directory:** \`${data.workspace.cwd}\``,
    ];

    // Show workspace binding if different from current cwd
    if (data.workspace.binding && data.workspace.binding !== data.workspace.cwd) {
      lines.push(`**${this.t('home.workspaceBinding')}:** \`${data.workspace.binding}\``);
    }

    lines.push(`**Permissions:** ${data.permission.mode}`);

    // Show active sessions count
    if (data.session.managed && data.session.managed.length > 1) {
      const activeCount = data.session.managed.filter(s => s.isAlive).length;
      const label = this.t('home.activeSessions');
      lines.push(`**${label}:** ${data.session.managed.length} (${activeCount} alive)`);
    }

    if (data.help?.recentSummary) {
      lines.push(``, `**Recent:** ${truncate(data.help.recentSummary, 100)}`);
    }
    if (data.session.recent?.length) {
      lines.push('', this.t('home.recentSessions'));
      for (const session of data.session.recent) {
        const marker = session.isCurrent ? ' ◀' : '';
        lines.push(`${session.index}. ${session.date} · ${truncate(session.preview, 50)}${marker}`);
      }
    }

    const buttons: Button[] = homeButtons(this.locale);

    return this.createMessage(chatId, lines.join('\n'), buttons);
  }

  formatPermissionStatus(chatId: string, data: PermissionStatusData): TRendered {
    const memoryCount = data.rememberedTools + data.rememberedBashPrefixes;
    const lines = [
      this.t('perm.title'),
      '',
      `**${this.t('perm.mode')}:** ${data.mode}`,
      `**${this.t('perm.remembered')}:** ${memoryCount}`,
    ];

    if (data.pending) {
      lines.push(
        '',
        `**${this.t('perm.pendingApproval')}:** ${data.pending.toolName}`,
        '```',
        truncate(data.pending.input, 180),
        '```',
      );
    }

    if (data.lastDecision) {
      const decisionLabel = {
        allow: this.t('perm.decisionAllow'),
        allow_always: this.t('perm.decisionAlwaysAllow'),
        deny: this.t('perm.decisionDeny'),
        cancelled: this.t('perm.decisionCancelled'),
      }[data.lastDecision.decision];
      lines.push(
        '',
        `**${this.t('perm.lastDecision')}:** ${data.lastDecision.toolName} · ${decisionLabel}`,
      );
    }

    const buttons: Button[] = permStatusButtons(data.mode, this.locale);

    return this.createMessage(chatId, lines.join('\n'), buttons);
  }

  formatTaskStart(chatId: string, data: TaskStartData): TRendered {
    const lines = [
      data.isNewSession ? this.t('taskStart.resetTitle') : this.t('taskStart.title'),
      '',
      `**${this.t('taskStart.directory')}:** ${data.cwd}`,
      `**${this.t('taskStart.permMode')}:** ${data.permissionMode === 'on' ? this.t('taskStart.permOn') : data.permissionMode}`,
    ];

    if (data.previousSessionPreview) {
      lines.push('', `**${this.t('taskStart.previousSession')}:** ${truncate(data.previousSessionPreview, 80)}`);
    }

    const buttons: Button[] = taskStartButtons(this.locale);

    return this.createMessage(chatId, lines.join('\n'), buttons);
  }

  formatSessions(chatId: string, data: SessionsData): TRendered {
    const lines = [`📋 **Sessions** ${data.filterHint}`, ''];

    // Show workspace binding if available
    if (data.workspaceBinding) {
      const label = this.t('home.workspaceBinding');
      lines.push(`🏠 **${label}:** \`${data.workspaceBinding}\``, '');
    }

    for (const s of data.sessions) {
      const marker = s.isCurrent ? ' ◀' : '';
      lines.push(`${s.index}. ${s.date} · ${s.cwd} · ${s.size} · ${s.preview}${marker}`);
    }
    const footer = this.t('sessions.footer');
    return this.createMessage(chatId, lines.join('\n') + footer);
  }

  formatSessionDetail(chatId: string, data: SessionDetailData): TRendered {
    const lines = [
      `📋 **Session #${data.index}**`,
      ``,
      `**Directory:** \`${data.cwd}\``,
      `**Date:** ${data.date}`,
      `**Size:** ${data.size}`,
      ``,
      `**Preview:** ${data.preview}`,
    ];
    if (data.transcript.length > 0) {
      lines.push(``, `**Recent messages:**`);
      for (const t of data.transcript.slice(0, 4)) {
        const role = t.role === 'user' ? '👤' : '🤖';
        lines.push(`${role} ${truncate(t.text, 100)}`);
      }
    }
    return this.createMessage(chatId, lines.join('\n'));
  }

  formatHelp(chatId: string, data: HelpData): TRendered {
    const lines = [`📖 **Commands**`, ''];
    for (const cmd of data.commands) {
      lines.push(`/${cmd.cmd} — ${cmd.desc}`);
    }
    return this.createMessage(chatId, lines.join('\n'));
  }

  formatNewSession(chatId: string, data: NewSessionData): TRendered {
    const cwdLabel = data.cwd ? ` in \`${data.cwd}\`` : '';
    const text = `${this.t('newSession.title')}${cwdLabel}`;
    return this.createMessage(chatId, text);
  }

  formatError(chatId: string, data: ErrorData): TRendered {
    const text = `❌ **${data.title}**\n\n${data.message}`;
    return this.createMessage(chatId, text);
  }

  formatProgress(chatId: string, data: ProgressData): TRendered {
    const phaseEmoji = {
      starting: '⏳',
      executing: '⏳',
      waiting_permission: '🔐',
      completed: '✅',
      failed: '⚠️',
    };
    const emoji = phaseEmoji[data.phase];
    const lines = [
      `${emoji} **${data.taskSummary}**`,
      ``,
      `⏱ ${data.elapsedSeconds}s`,
    ];
    if (data.currentTool) {
      lines.push(``, `**Current:** ${data.currentTool.name}: ${truncate(data.currentTool.input, 100)}`);
    }
    const buttons = data.actionButtons?.length ? data.actionButtons : this.defaultProgressButtons(data.phase);
    return this.createMessage(chatId, lines.join('\n'), buttons);
  }

  formatTaskSummary(chatId: string, data: TaskSummaryData): TRendered {
    const lines = [
      this.t('taskSummary.title'),
      '',
      data.summary,
      '',
      `${this.t('taskSummary.changedFiles')}: ${data.changedFiles}`,
      `${this.t('taskSummary.permissionPrompts')}: ${data.permissionRequests}`,
      `Status: ${data.hasError ? this.t('taskSummary.statusError') : this.t('taskSummary.statusDone')}`,
    ];

    // Footer line with model, cwd, sessionId
    if (data.footerLine) {
      lines.push('', data.footerLine);
    }

    const buttons = taskSummaryButtons(this.locale);

    return this.createMessage(chatId, lines.join('\n'), buttons);
  }

  /** Generate default action buttons for a progress phase. */
  protected defaultProgressButtons(phase: ProgressData['phase']): Button[] {
    if (phase === 'completed' || phase === 'failed') {
      return progressDoneButtons(this.locale);
    }
    return progressRunningButtons(this.locale);
  }

  /** Format raw markdown content into a platform-appropriate message. */
  formatContent(chatId: string, content: string, buttons?: Button[]): TRendered {
    return this.createMessage(chatId, content, buttons);
  }

  formatCardResolution(chatId: string, data: CardResolutionData): TRendered {
    return this.createMessage(chatId, data.label, data.buttons);
  }

  formatVersionUpdate(chatId: string, data: VersionUpdateData): TRendered {
    const dateStr = data.publishedAt
      ? new Date(data.publishedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
      : '';
    const text = `${this.t('version.title')}\nv${data.current} → v${data.latest}${dateStr ? `\n${this.t('version.released')}：${dateStr}` : ''}`;
    return this.createMessage(chatId, text);
  }

  formatMultiSelectToggle(chatId: string, data: MultiSelectToggleData): TRendered {
    const headerLine = data.header ? `📋 **${data.header}**\n\n` : '';
    const optionsList = data.options
      .map((opt, i) => `${data.selectedIndices.has(i) ? '☑' : '☐'} ${i + 1}. **${opt.label}**${opt.description ? ` — ${opt.description}` : ''}`)
      .join('\n');
    const text = `${headerLine}${data.question}\n\n${optionsList}`;
    const hint = `\n\n${this.t('multiSelect.hint')}`;

    const buttons = this.buildMultiSelectButtons(data.permId, data.sessionId, data.options);
    // Update button labels to show selected state
    buttons.forEach((btn, idx) => {
      if (idx < data.options.length) {
        btn.label = `${data.selectedIndices.has(idx) ? '☑' : '☐'} ${data.options[idx].label}`;
      }
    });

    return this.createMessage(chatId, text + hint, buttons);
  }

  formatQueueStatus(chatId: string, data: QueueStatusData): TRendered {
    const saturationRatio = data.saturationRatio ?? (data.maxDepth > 0 ? data.depth / data.maxDepth : 0);
    const oldestQueuedAgeSeconds = data.oldestQueuedAgeSeconds
      ?? (data.queuedMessages?.length
        ? Math.max(0, Math.floor((Date.now() - Math.min(...data.queuedMessages.map(item => item.timestamp))) / 1000))
        : undefined);
    const estimatedWaitSeconds = data.estimatedWaitSeconds
      ?? (data.depth > 0 ? data.depth * AVERAGE_TURN_SECONDS : undefined);
    const state = data.depth === 0
      ? 'idle'
      : saturationRatio >= 1
        ? 'saturated'
        : saturationRatio >= 0.8
          ? 'high'
          : 'normal';

    const lines = [
      '📥 **Queue Status**',
      '',
      `**Session:** \`${data.sessionKey}\``,
      `**Depth:** ${data.depth}/${data.maxDepth}`,
      `**State:** ${state}`,
    ];

    if (data.queuedMessages?.length) {
      lines.push('', '**Queued messages:**');
      for (const [index, message] of data.queuedMessages.entries()) {
        lines.push(`${index + 1}. ${truncate(message.preview, 80)}`);
      }
    }

    if (oldestQueuedAgeSeconds !== undefined && data.depth > 0) {
      lines.push('', `**Oldest queued:** ${Math.ceil(oldestQueuedAgeSeconds / 60)} min ago`);
    }

    if (estimatedWaitSeconds && data.depth > 0) {
      lines.push('', `**Estimated wait:** ${Math.ceil(estimatedWaitSeconds / 60)} min`);
    }

    return this.createMessage(chatId, lines.join('\n'));
  }

  formatDiagnose(chatId: string, data: DiagnoseData): TRendered {
    const totalCapacity = data.queueStats.reduce((sum, stat) => sum + stat.maxDepth, 0);
    const totalDepth = data.queueStats.reduce((sum, stat) => sum + stat.depth, 0);
    const queueUtilizationRatio = data.queueUtilizationRatio
      ?? (totalCapacity > 0 ? totalDepth / totalCapacity : undefined);
    const saturatedSessions = data.saturatedSessions
      ?? data.queueStats.filter(stat => stat.depth >= stat.maxDepth).length;
    const busiestSession = data.busiestSession
      ?? (data.queueStats.length > 0
        ? data.queueStats.reduce((max, stat) => {
          const ratio = stat.maxDepth > 0 ? stat.depth / stat.maxDepth : 0;
          const maxRatio = max.maxDepth > 0 ? max.depth / max.maxDepth : 0;
          return ratio > maxRatio ? stat : max;
        }, data.queueStats[0])
        : undefined);

    const lines = [
      '🩺 **Diagnose**',
      '',
      `**Sessions:** active ${data.activeSessions}, idle ${data.idleSessions}`,
      `**Queued messages:** ${data.totalQueuedMessages}`,
      `**Processing chats:** ${data.processingChats}`,
      `**Bubble mappings:** ${data.totalBubbleMappings}`,
    ];

    if (queueUtilizationRatio !== undefined) {
      lines.push(`**Queue utilization:** ${Math.round(queueUtilizationRatio * 100)}%`);
    }
    if (saturatedSessions > 0) {
      lines.push(`**Saturated sessions:** ${saturatedSessions}`);
    }
    if (busiestSession) {
      lines.push(`**Busiest session:** ${busiestSession.depth}/${busiestSession.maxDepth}`);
    }

    if (data.memoryUsage) {
      lines.push(`**Memory:** ${data.memoryUsage}`);
    }

    if (data.queueStats.length > 0) {
      lines.push('', '**Queue detail:**');
      for (const stat of data.queueStats) {
        lines.push(`- ${stat.sessionKey}: ${stat.depth}/${stat.maxDepth}`);
      }
    }

    return this.createMessage(chatId, lines.join('\n'));
  }

  formatProjectList(chatId: string, data: ProjectListData): TRendered {
    const lines = ['📦 **Projects**', ''];

    for (const project of data.projects) {
      const flags = [
        project.isCurrent ? 'current' : '',
        project.isDefault ? 'default' : '',
      ].filter(Boolean).join(', ');
      lines.push(`- **${project.name}** — \`${project.workdir}\`${flags ? ` (${flags})` : ''}`);
    }

    return this.createMessage(chatId, lines.join('\n'));
  }

  formatProjectInfo(chatId: string, data: ProjectInfoData): TRendered {
    const lines = [
      `📦 **${data.projectName}**`,
      '',
      `**Workdir:** \`${data.workdir}\``,
    ];

    if (data.workspaceBinding && data.workspaceBinding !== data.workdir) {
      lines.push(`**Workspace binding:** \`${data.workspaceBinding}\``);
    }
    if (data.channels?.length) {
      lines.push(`**Channels:** ${data.channels.join(', ')}`);
    }
    if (data.claudeSettingSources?.length) {
      lines.push(`**Settings:** ${data.claudeSettingSources.join(', ')}`);
    }

    return this.createMessage(chatId, lines.join('\n'));
  }

  formatRecentProjects(chatId: string, data: RecentProjectsData): TRendered {
    const lines = ['📂 **Recent Projects**', '', `**Current:** \`${data.currentCwd}\``, ''];

    for (const project of data.projects) {
      const marker = project.isCurrent ? ' ◀' : '';
      const timeAgo = this.formatTimeAgo(project.lastUsedAt);
      const useInfo = project.useCount > 1 ? ` · ${project.useCount}x` : '';
      lines.push(`- **${project.name}** — \`${project.workdir}\` (${timeAgo}${useInfo})${marker}`);
    }

    lines.push('', this.t('recentProjects.hint'));

    // Add buttons for quick switch
    const buttons: Button[] = data.projects
      .filter(p => !p.isCurrent) // Don't show button for current directory
      .slice(0, 5) // Max 5 buttons
      .map(project => ({
        label: `📂 ${project.name}`,
        callbackData: `cmd:/cd ${project.fullWorkdir}`,
        style: 'primary' as const,
      }));

    return this.createMessage(chatId, lines.join('\n'), buttons);
  }

  protected formatTimeAgo(timestamp: string): string {
    const now = Date.now();
    const then = new Date(timestamp).getTime();
    const diffMs = now - then;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  }

  // --- Helper methods --

  protected buildSingleSelectButtons(permId: string, options: Array<{ label: string }>): Button[] {
    return [
      ...options.map((opt, idx) => ({
        label: `${idx + 1}. ${opt.label}`,
        callbackData: `perm:allow:${permId}:askq:${idx}`,
        style: 'primary' as const,
      })),
      { label: '❌ Skip', callbackData: `perm:allow:${permId}:askq_skip`, style: 'danger' as const },
    ];
  }

  protected buildMultiSelectButtons(permId: string, sessionId: string, options: Array<{ label: string }>): Button[] {
    const buttons: Button[] = options.map((opt, idx) => ({
      label: `☐ ${opt.label}`,
      callbackData: `askq_toggle:${permId}:${idx}:${sessionId}`,
      style: 'primary' as const,
      row: idx,
    }));
    buttons.push(
      { label: '✅ Submit', callbackData: `askq_submit:${permId}:${sessionId}`, style: 'primary', row: options.length },
      { label: '❌ Skip', callbackData: `askq_skip:${permId}:${sessionId}`, style: 'danger', row: options.length }
    );
    return buttons;
  }
}