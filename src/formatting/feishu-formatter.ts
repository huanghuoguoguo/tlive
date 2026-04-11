/**
 * Feishu message formatter - uses Card 2.0 JSON format.
 * Supports rich cards with headers, elements, and structured buttons.
 */

import { MessageFormatter, type MessageLocale } from './message-formatter.js';
import { downgradeHeadings } from '../markdown/feishu.js';
import type { OutboundMessage, Button } from '../channels/types.js';
import type {
  NotificationData,
  HomeData,
  PermissionStatusData,
  TaskStartData,
  SessionsData,
  SessionDetailData,
  HelpData,
  NewSessionData,
  ProgressData,
  TaskSummaryData,
  PermissionData,
  QuestionData,
  CardResolutionData,
  VersionUpdateData,
  MultiSelectToggleData,
} from './message-types.js';
import { truncate } from '../utils/string.js';
import { buildFeishuButtonElements } from './feishu-card.js';

type FeishuElement = { tag: string; [key: string]: unknown };
type TimelineToolDisplay = {
  toolName: string;
  toolInput: string;
  toolResult?: string;
  isError?: boolean;
};

type TimelineOperationDisplay = {
  thinkingContent: string;
  textEntries: string[];
  toolEntries: TimelineToolDisplay[];
};

function summarizeOperationText(text: string): string {
  const cleaned = text
    .replace(/[*_`>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';

  const sentence = cleaned
    .split(/[。！？.!?\n]/)
    .map(part => part.trim())
    .find(Boolean) || cleaned;

  return truncate(sentence, 20);
}

export class FeishuFormatter extends MessageFormatter {
  constructor(locale: MessageLocale = 'zh') {
    super(locale);
  }

  protected formatMarkdown(_text: string): string {
    // Feishu uses markdown directly in card elements
    throw new Error('Use createCardMessage for Feishu');
  }

  protected supportsButtons(): boolean {
    return true;
  }

  protected createMessage(chatId: string, text: string, buttons?: Button[]): OutboundMessage {
    // Simple text message (no card)
    const msg: OutboundMessage = { chatId, text };
    if (buttons) {
      msg.buttons = buttons;
    }
    return msg;
  }

  protected createCardMessage(
    chatId: string,
    header: { template: string; title: string },
    elements: FeishuElement[],
    buttons?: Button[]
  ): OutboundMessage {
    const allElements = [...elements];
    if (buttons && buttons.length > 0) {
      allElements.push(...buildFeishuButtonElements(buttons));
    }
    return {
      chatId,
      text: '', // Text is in elements
      feishuHeader: header,
      feishuElements: allElements,
    };
  }

  private md(content: string): FeishuElement {
    return { tag: 'markdown', content: downgradeHeadings(content) };
  }

  private collectTimelineOperations(data: ProgressData): TimelineOperationDisplay[] {
    const operations: TimelineOperationDisplay[] = [];
    let current: TimelineOperationDisplay | undefined;
    let currentToolByKey: Map<string, TimelineToolDisplay> | undefined;

    const ensureCurrent = (): TimelineOperationDisplay => {
      if (!current) {
        current = { thinkingContent: '', textEntries: [], toolEntries: [] };
        currentToolByKey = new Map<string, TimelineToolDisplay>();
      }
      return current;
    };

    const flushCurrent = (): void => {
      if (!current) return;
      if (current.thinkingContent.trim() || current.textEntries.length > 0 || current.toolEntries.length > 0) {
        operations.push(current);
      }
      current = undefined;
      currentToolByKey = undefined;
    };

    for (const entry of data.timeline ?? []) {
      if (entry.kind === 'thinking' && entry.text?.trim()) {
        const currentOp = current;
        if (currentOp && (currentOp.toolEntries.length > 0 || currentOp.textEntries.length > 0)) {
          flushCurrent();
        }
        const op = ensureCurrent();
        op.thinkingContent = op.thinkingContent
          ? `${op.thinkingContent}\n\n${entry.text.trim()}`
          : entry.text.trim();
        continue;
      }

      if (entry.kind === 'text' && entry.text?.trim()) {
        ensureCurrent().textEntries.push(entry.text.trim());
        continue;
      }

      if (entry.kind === 'tool' && entry.toolName) {
        const op = ensureCurrent();
        const toolMap = currentToolByKey ?? new Map<string, TimelineToolDisplay>();
        currentToolByKey = toolMap;
        const toolInput = entry.toolInput || '(no input)';
        const key = `${entry.toolName}\u0000${toolInput}`;
        const existing = toolMap.get(key);
        if (existing) {
          if (entry.toolResult !== undefined) {
            existing.toolResult = entry.toolResult;
          }
          if (entry.isError !== undefined) {
            existing.isError = entry.isError;
          }
          continue;
        }

        const toolEntry: TimelineToolDisplay = {
          toolName: entry.toolName,
          toolInput,
          toolResult: entry.toolResult,
          isError: entry.isError,
        };
        toolMap.set(key, toolEntry);
        op.toolEntries.push(toolEntry);
      }
    }

    flushCurrent();
    return operations;
  }

  private extractCompletedBody(data: ProgressData): string {
    let body = data.renderedText.trim();

    if (data.footerLine && body.endsWith(data.footerLine)) {
      body = body.slice(0, -data.footerLine.length).trimEnd();
    }
    if (data.toolSummary && body.endsWith(data.toolSummary)) {
      body = body.slice(0, -data.toolSummary.length).trimEnd();
    }
    if (body.endsWith('───────────────')) {
      body = body.slice(0, -'───────────────'.length).trimEnd();
    }

    return body;
  }

  private buildOperationHeader(operation: TimelineOperationDisplay, isExpanded: boolean): string {
    const summarySource = operation.thinkingContent.trim()
      || operation.textEntries.find(text => text.trim())
      || '';
    const summary = summarizeOperationText(summarySource);
    const toolNames = [...new Set(operation.toolEntries.map(tool => tool.toolName))];
    const toolSuffix = toolNames.length > 0
      ? toolNames.length === 1
        ? `${toolNames[0]}×${operation.toolEntries.length}`
        : `${toolNames.slice(0, 2).join('/')} 等`
      : '';
    const title = summary
      ? toolSuffix
        ? `${summary} · ${toolSuffix}`
        : summary
      : toolNames.length > 0
        ? toolNames.slice(0, 3).join(' · ')
        : '思考';
    const hasPendingTool = operation.toolEntries.some(tool => tool.toolResult === undefined && !tool.isError);
    const hasError = operation.toolEntries.some(tool => tool.isError);
    const icon = hasError ? '❌' : hasPendingTool ? '⏳' : isExpanded ? '🔄' : '✅';
    return `${icon} ${title}`;
  }

  private buildOperationContent(operation: TimelineOperationDisplay, includeTextEntries: boolean): string {
    const sections: string[] = [];

    if (operation.thinkingContent.trim()) {
      sections.push(operation.thinkingContent.trim());
    }

    if (includeTextEntries && operation.textEntries.length > 0) {
      sections.push(operation.textEntries.join('\n\n'));
    }

    if (operation.toolEntries.length > 0) {
      const toolLines = operation.toolEntries.map(tool => {
        const status = tool.isError ? '❌' : tool.toolResult !== undefined ? '✅' : '⏳';
        const resultLine = tool.toolResult ? `\n→ ${truncate(tool.toolResult, 120)}` : '';
        const inputPreview = tool.toolName === 'Bash'
          ? `\`${truncate(tool.toolInput, 120)}\``
          : truncate(tool.toolInput, 160);
        return `${status} **${tool.toolName}**\n\n${inputPreview}${resultLine}`;
      });
      sections.push(toolLines.join('\n\n'));
    }

    return sections.join('\n\n');
  }

  // --- Override all formatting methods for Feishu Card format ---

  override formatStatus(chatId: string, data: { healthy: boolean; channels: string[]; cwd?: string; sessionId?: string }): OutboundMessage {
    const status = data.healthy ? '🟢 运行中' : '🔴 已断开';
    const channelList = data.channels.join(', ') || '无';
    const elements: FeishuElement[] = [
      this.md(`**状态**\n${status}`),
      this.md(`**通道**\n${channelList}`),
    ];
    if (data.cwd) {
      elements.push(this.md(`**目录**\n\`${data.cwd}\``));
    }
    return this.createCardMessage(chatId,
      { template: 'blue', title: '📊 TLive 状态' },
      elements
    );
  }

  override formatPermission(chatId: string, data: PermissionData): OutboundMessage {
    const input = truncate(data.toolInput, 300);
    const expires = data.expiresInMinutes ?? 5;
    const elements: FeishuElement[] = [
      this.md(`**工具**\n${data.toolName}`),
      this.md(`**输入**\n\`\`\`\n${input}\n\`\`\``),
      this.md(`⏱ ${expires} 分钟内处理`),
    ];
    if (data.terminalUrl) {
      elements.push(this.md(`🔗 [在终端中查看](${data.terminalUrl})`));
    }
    elements.push(this.md('💬 也可以直接回复 **allow** / **deny** / **always**。'));

    const buttons: Button[] = [
      { label: '✅ 允许本次', callbackData: `perm:allow:${data.permissionId}`, style: 'primary', row: 0 },
      { label: '📌 本会话始终允许', callbackData: `perm:allow_session:${data.permissionId}`, style: 'default', row: 0 },
      { label: '❌ 拒绝', callbackData: `perm:deny:${data.permissionId}`, style: 'danger', row: 1 },
    ];

    return this.createCardMessage(chatId,
      { template: 'orange', title: '🔐 待审批动作' },
      elements,
      buttons
    );
  }

  override formatQuestion(chatId: string, data: QuestionData): OutboundMessage {
    const { question, options, multiSelect, permId, sessionId } = data;

    // Build form elements according to Feishu Card 2.0 spec
    const formElements: FeishuElement[] = [];

    // For single-select with many options, use select_static dropdown
    const useSelectDropdown = !multiSelect && options.length > 4;

    if (useSelectDropdown) {
      // Feishu select_static dropdown
      formElements.push({
        tag: 'select_static',
        name: '_select',
        placeholder: { tag: 'plain_text', content: '选择一个选项...' },
        options: options.map(opt => ({
          text: { tag: 'plain_text', content: opt.label },
          value: opt.label,
        })),
        required: false,
      } as FeishuElement);
    }

    // Text input for free-form answers
    formElements.push({
      tag: 'input',
      name: '_text_answer',
      placeholder: { tag: 'plain_text', content: useSelectDropdown ? '或直接输入文字回答...' : '直接输入文字回答...' },
      required: false,
    } as FeishuElement);

    // Hidden interaction ID input
    formElements.push({
      tag: 'input',
      name: '_interaction_id',
      placeholder: { tag: 'plain_text', content: '' },
      required: false,
      default_value: permId,
    } as FeishuElement);

    // Buttons based on mode
    const formButtons: Button[] = [];

    if (useSelectDropdown) {
      // Submit + Skip buttons for dropdown mode
      formButtons.push({
        label: '✅ 提交',
        callbackData: `form:${permId}`,
        style: 'primary',
        row: 0,
      });
      formButtons.push({
        label: '⏭️ 跳过',
        callbackData: `askq_skip:${permId}:${sessionId}`,
        style: 'default',
        row: 0,
      });
    } else if (multiSelect) {
      // Multi-select uses toggle buttons + submit
      formButtons.push(...this.buildMultiSelectButtons(permId, sessionId, options));
    } else {
      // Few options: direct option buttons
      formButtons.push(...this.buildSingleSelectButtons(permId, options));
      formButtons.push({
        label: '⏭️ 跳过',
        callbackData: `askq_skip:${permId}:${sessionId}`,
        style: 'default',
        row: Math.floor(options.length / 2),
      });
    }

    // Build the card with form container
    const cardElements: FeishuElement[] = [
      this.md(`**问题**\n${question}`),
    ];

    if (!useSelectDropdown) {
      // For non-dropdown modes, show options as markdown list
      const optionsList = options
        .map((opt, i) => `${i + 1}. **${opt.label}**${opt.description ? ` — ${opt.description}` : ''}`)
        .join('\n');
      cardElements.push(this.md(`**选项**\n${optionsList}`));
      if (multiSelect) {
        cardElements.push(this.md('💡 点击选项切换勾选，然后点提交。'));
      } else {
        cardElements.push(this.md('💡 点击选项或直接回复文字。'));
      }
    }

    // Add form container with form elements and buttons
    const formContainer: FeishuElement = {
      tag: 'form',
      name: `form_${permId}`,
      elements: [
        ...formElements,
        ...buildFeishuButtonElements(formButtons) as unknown as FeishuElement[],
      ],
    };

    cardElements.push(formContainer);

    return this.createCardMessage(chatId,
      { template: 'blue', title: '❓ 等待回答' },
      cardElements,
      undefined // buttons are inside form container
    );
  }

  override formatNotification(chatId: string, data: NotificationData): OutboundMessage {
    const templateMap = { stop: 'green', idle_prompt: 'yellow', generic: 'blue' };
    const emojiMap = { stop: '✅', idle_prompt: '⏳', generic: '📢' };
    const template = templateMap[data.type];
    const emoji = emojiMap[data.type];

    const elements: FeishuElement[] = [];
    if (data.summary) {
      elements.push(this.md(downgradeHeadings(truncate(data.summary, 3000))));
    }
    if (data.terminalUrl) {
      elements.push({ tag: 'hr' });
      elements.push(this.md(`<font color='grey'>🔗 [Open Terminal](${data.terminalUrl})</font>`));
    }

    return this.createCardMessage(chatId,
      { template, title: `${emoji} ${data.title}` },
      elements
    );
  }

  override formatHome(chatId: string, data: HomeData): OutboundMessage {
    // Header section: Bridge status
    const bridgeStatus = data.bridgeHealthy ? '🟢 已连接' : '🔴 已断开';
    const channels = data.activeChannels?.join(', ') || '无';
    const taskStatus = data.hasActiveTask
      ? '⏳ 有任务正在执行'
      : '✅ 当前无执行任务';

    const elements: FeishuElement[] = [
      // Status overview panel
      this.md(`**系统状态**\n${bridgeStatus} · 通道: ${channels}`),
      this.md(`**任务状态**\n${taskStatus}`),
      this.md(`**项目目录**\n\`${data.cwd}\``),
      this.md(`**权限模式**\n${data.permissionMode === 'on' ? '🔐 开启审批' : '⚡ 关闭审批'}`),
    ];

    // Permission details (if relevant)
    if (data.pendingPermission) {
      elements.push(this.md(`**待处理审批**\n${data.pendingPermission.toolName}\n\`\`\`\n${truncate(data.pendingPermission.input, 180)}\n\`\`\``));
    } else {
      elements.push(this.md('**待处理审批**\n暂无'));
    }

    // Last permission decision
    if (data.lastPermissionDecision) {
      const decisionLabel = {
        allow: '✅ 允许一次',
        allow_always: '📌 本会话始终允许',
        deny: '❌ 拒绝',
        cancelled: '⏭ 已取消',
      }[data.lastPermissionDecision.decision];
      elements.push(this.md(`**最近审批**\n${data.lastPermissionDecision.toolName} → ${decisionLabel}`));
    }

    // Session whitelist count
    if (data.sessionWhitelistCount && data.sessionWhitelistCount > 0) {
      elements.push(this.md(`**会话白名单**\n已记忆 ${data.sessionWhitelistCount} 项工具/Bash 前缀`));
    }

    // Recent task summary
    if (data.recentSummary) {
      elements.push(this.md(`**最近任务**\n${truncate(data.recentSummary, 150)}`));
    }

    // Recent sessions
    const recentSessions = data.recentSessions?.length
      ? data.recentSessions
        .map(session => `${session.index}. ${session.date} · ${truncate(session.preview, 50)}${session.isCurrent ? ' ◀' : ''}`)
        .join('\n')
      : '暂无最近会话';
    elements.push(this.md(`**最近会话**\n${recentSessions}`));

    // Usage hint
    elements.push(this.md('💡 点击下方按钮快速操作；也可直接发送消息让 AI 处理。'));

    const buttons: Button[] = [
      { label: '🕘 最近会话', callbackData: 'cmd:sessions --all', style: 'primary' },
      { label: '🔐 权限设置', callbackData: 'cmd:perm', style: 'default' },
      { label: '🆕 新会话', callbackData: 'cmd:new', style: 'default' },
      { label: '📊 状态详情', callbackData: 'cmd:status', style: 'default' },
      { label: '❓ 帮助', callbackData: 'cmd:help', style: 'default' },
    ];

    return this.createCardMessage(chatId,
      { template: 'indigo', title: '🏠 TLive 工作台' },
      elements,
      buttons
    );
  }

  override formatPermissionStatus(chatId: string, data: PermissionStatusData): OutboundMessage {
    const rememberedCount = data.rememberedTools + data.rememberedBashPrefixes;
    const decisionLabel = data.lastDecision
      ? {
          allow: '允许一次',
          allow_always: '本会话始终允许',
          deny: '拒绝',
          cancelled: '已取消',
        }[data.lastDecision.decision]
      : '';

    const elements: FeishuElement[] = [
      this.md(`**当前模式**\n${data.mode === 'on' ? '开启审批' : '关闭审批'}`),
      this.md(`**本会话记忆**\n工具 ${data.rememberedTools} 项 · Bash 前缀 ${data.rememberedBashPrefixes} 项`),
    ];

    if (data.pending) {
      elements.push(this.md(`**当前待审批**\n${data.pending.toolName}\n\`\`\`\n${truncate(data.pending.input, 220)}\n\`\`\``));
    } else {
      elements.push(this.md('**当前待审批**\n暂无'));
    }

    if (data.lastDecision) {
      elements.push(this.md(`**最近处理**\n${data.lastDecision.toolName} · ${decisionLabel}`));
    }

    const buttons: Button[] = data.mode === 'on'
      ? [
          { label: '⚡ 关闭审批', callbackData: 'cmd:perm off', style: 'danger' },
          { label: '🏠 首页', callbackData: 'cmd:home', style: 'default' },
        ]
      : [
          { label: '🔐 开启审批', callbackData: 'cmd:perm on', style: 'primary' },
          { label: '🏠 首页', callbackData: 'cmd:home', style: 'default' },
        ];

    return this.createCardMessage(chatId,
      { template: data.mode === 'on' ? 'orange' : 'grey', title: '🔐 权限状态' },
      elements,
      buttons
    );
  }

  override formatTaskStart(chatId: string, data: TaskStartData): OutboundMessage {
    const title = data.isNewSession ? '🔄 会话已重置' : '🚀 开始执行';
    const elements: FeishuElement[] = [
      this.md(`**当前配置**\n目录：${data.cwd}\n权限：${data.permissionMode === 'on' ? '开启审批' : '关闭审批'}`),
    ];

    if (data.previousSessionPreview) {
      elements.push(this.md(`**上次会话**\n${truncate(data.previousSessionPreview, 100)}`));
    }

    elements.push(this.md('💡 任务已开始执行。如需调整配置，点击下方按钮。'));

    const buttons: Button[] = [
      { label: '🏠 调整配置', callbackData: 'cmd:home', style: 'default', row: 0 },
      { label: '🆕 新会话', callbackData: 'cmd:new', style: 'default', row: 0 },
    ];

    return this.createCardMessage(chatId,
      { template: 'blue', title },
      elements,
      buttons
    );
  }

  override formatTaskSummary(chatId: string, data: TaskSummaryData): OutboundMessage {
    const elements: FeishuElement[] = [
      this.md(`**结果摘要**\n${truncate(data.summary, 500)}`),
      this.md(`**执行结果**\n改动文件：${data.changedFiles}\n权限审批：${data.permissionRequests}\n状态：${data.hasError ? '有错误' : '已完成'}`),
      this.md(`**下一步建议**\n${data.nextStep}`),
    ];

    const buttons: Button[] = [
      { label: '🏠 首页', callbackData: 'cmd:home', style: 'primary' },
      { label: '🕘 最近会话', callbackData: 'cmd:sessions --all', style: 'default' },
    ];

    return this.createCardMessage(chatId,
      { template: data.hasError ? 'red' : 'green', title: data.hasError ? '⚠️ 任务结束' : '✅ 任务摘要' },
      elements,
      buttons
    );
  }

  override formatSessions(chatId: string, data: SessionsData): OutboundMessage {
    const lines: string[] = [];
    for (const s of data.sessions) {
      const marker = s.isCurrent ? ' ◀ 当前' : '';
      lines.push(`${s.index}. ${s.date} · ${truncate(s.preview, 60)}${marker}`);
    }

    const elements: FeishuElement[] = [
      this.md(`**最近会话** ${data.filterHint}\n\n${lines.join('\n')}`),
      this.md('💡 点击"继续"恢复会话；长按可查看详情。'),
    ];

    const buttons: Button[] = [];
    for (let i = 0; i < Math.min(data.sessions.length, 10); i++) {
      const s = data.sessions[i];
      const style = s.isCurrent ? 'primary' : 'default';
      buttons.push(
        { label: `▶️ #${i + 1}`, callbackData: `cmd:session ${i + 1}`, style, row: i },
        { label: `ℹ️`, callbackData: `cmd:sessioninfo ${i + 1}`, style: 'default', row: i }
      );
    }

    return this.createCardMessage(chatId,
      { template: 'blue', title: '📋 会话列表' },
      elements,
      buttons.length > 0 ? buttons : undefined
    );
  }

  override formatSessionDetail(chatId: string, data: SessionDetailData): OutboundMessage {
    const elements: FeishuElement[] = [
      this.md(`**目录**\n\`${data.cwd}\``),
      this.md(`**时间**\n${data.date}`),
      this.md(`**大小**\n${data.size}`),
      this.md(`**预览**\n${data.preview}`),
    ];

    if (data.transcript.length > 0) {
      const transcriptLines = data.transcript.slice(0, 4).map(t => {
        const role = t.role === 'user' ? '👤' : '🤖';
        return `${role} ${truncate(t.text, 100)}`;
      });
      elements.push(this.md(`**最近消息**\n${transcriptLines.join('\n')}`));
    }

    return this.createCardMessage(chatId,
      { template: 'blue', title: `📋 会话 #${data.index}` },
      elements
    );
  }

  override formatHelp(chatId: string, data: HelpData): OutboundMessage {
    const lines = data.commands.map(cmd => `/${cmd.cmd} — ${cmd.desc}`);
    const elements: FeishuElement[] = [
      this.md(`**命令列表**\n${lines.join('\n')}`),
    ];

    const buttons: Button[] = [
      { label: '🆕 新会话', callbackData: 'cmd:new', style: 'primary', row: 0 },
      { label: '📋 会话列表', callbackData: 'cmd:sessions', style: 'default', row: 0 },
    ];

    return this.createCardMessage(chatId,
      { template: 'blue', title: '❓ 常用帮助' },
      elements,
      buttons
    );
  }

  override formatNewSession(chatId: string, data: NewSessionData): OutboundMessage {
    const cwdLabel = data.cwd ? ` in \`${data.cwd}\`` : '';
    return this.createCardMessage(chatId,
      { template: 'green', title: '✅ 新会话' },
      [this.md(`已创建新会话${cwdLabel}`)]
    );
  }

  override formatProgress(chatId: string, data: ProgressData): OutboundMessage {
    const headerConfig = data.phase === 'completed'
      ? { template: 'green' as const, title: '✅ 已完成' }
      : data.phase === 'failed'
        ? { template: 'red' as const, title: '⚠️ 已停止' }
        : data.phase === 'waiting_permission'
          ? { template: 'orange' as const, title: '🔐 等待权限' }
          : data.isContinuation
            ? { template: 'blue' as const, title: `🔄 继续执行 (${data.totalTools} 步已完成)` }
            : { template: 'blue' as const, title: data.phase === 'starting' ? '⏳ 准备开始' : '⏳ 执行中' };

    const elements: FeishuElement[] = [];
    const isDone = data.phase === 'completed' || data.phase === 'failed';
    const operations = this.collectTimelineOperations(data);

    // Timeline: group one reasoning step + subsequent tool calls into one operation panel
    if (operations.length > 0) {
      let budget = 3000;
      const expandedIndex = isDone ? -1 : operations.length - 1;
      for (let i = 0; i < operations.length; i++) {
        if (budget <= 0) break;
        const operation = operations[i];
        const isExpanded = i === expandedIndex;
        const content = truncate(
          downgradeHeadings(this.buildOperationContent(operation, !isDone)),
          Math.min(budget, isExpanded ? 1800 : 1200),
        );
        budget -= content.length;
        elements.push({
          tag: 'collapsible_panel',
          expanded: isExpanded,
          header: { title: { tag: 'plain_text', content: this.buildOperationHeader(operation, isExpanded) } },
          elements: [{ tag: 'markdown', content }],
        });
      }
    } else {
      // Legacy fallback: separate thinking + tool panels (when no timeline data)
      if (data.thinkingText?.trim()) {
        elements.push({
          tag: 'collapsible_panel',
          expanded: false,
          header: { title: { tag: 'plain_text', content: '💭 思考过程' } },
          elements: [{ tag: 'markdown', content: truncate(data.thinkingText.trim(), 1500) }],
        });
      }
      if (data.toolLogs?.length) {
        const logLines = data.toolLogs.map(log => {
          const icon = log.isError ? '❌' : '✅';
          const status = log.result !== undefined ? icon : '⏳';
          const resultLine = log.result ? `\n   → ${truncate(log.result, 120)}` : '';
          return `${status} **${log.name}**: ${truncate(log.input || '(no input)', 100)}${resultLine}`;
        });
        elements.push({
          tag: 'collapsible_panel',
          expanded: !isDone,
          header: { title: { tag: 'plain_text', content: `🔧 工具调用 (${data.toolLogs.length})` } },
          elements: [{ tag: 'markdown', content: truncate(logLines.join('\n'), 2000) }],
        });
      }
    }

    // Main content area (after timeline panels)
    if (isDone) {
      if (!data.completedTraceOnly) {
        const completedBody = this.extractCompletedBody(data);
        if (completedBody) {
          elements.push(this.md(downgradeHeadings(truncate(completedBody, 3000))));
        }
        if (data.footerLine) {
          elements.push(this.md(`<font color='grey'>${data.footerLine}</font>`));
        }
      }
    } else if (data.phase === 'waiting_permission' && data.permission) {
      const extraQueue = data.permission.queueLength > 1 ? `\n待处理审批：${data.permission.queueLength} 个` : '';
      elements.push(this.md(
        `**当前等待**\n${data.permission.toolName}\n\`\`\`\n${truncate(data.permission.input, 260)}\n\`\`\`${extraQueue}`
      ));
      elements.push(this.md(`**运行时长** ${data.elapsedSeconds}s`));
    } else if (!operations.length) {
      // In-progress fallback when no timeline
      if (data.currentTool?.input) {
        const currentElapsed = data.currentTool.elapsed > 0 ? ` · ${data.currentTool.elapsed}s` : '';
        elements.push(this.md(`**最近动作**\n${data.currentTool.name}: ${truncate(data.currentTool.input, 140)}${currentElapsed}`));
      }
      elements.push(this.md(`**运行时长** ${data.elapsedSeconds}s`));
    }

    // Status line for in-progress cards with timeline
    if (!isDone && operations.length > 0) {
      const statusParts: string[] = [];
      if (data.totalTools > 0) statusParts.push(`${data.totalTools} tools`);
      statusParts.push(`${data.elapsedSeconds}s`);
      elements.push(this.md(`⏳ ${statusParts.join(' · ')}`));
    }

    // Todo progress
    if (data.todoItems.length > 0) {
      const done = data.todoItems.filter(item => item.status === 'completed').length;
      const todoLines = data.todoItems.slice(0, 5).map(item => {
        const icon = item.status === 'completed' ? '✅' : item.status === 'in_progress' ? '🔧' : '⬜';
        return `${icon} ${item.content}`;
      });
      elements.push(this.md(`**工作进度** (${done}/${data.todoItems.length})\n${todoLines.join('\n')}`));
    }

    const buttons = data.actionButtons?.length ? data.actionButtons : this.defaultProgressButtons(data.phase);
    return this.createCardMessage(chatId, headerConfig, elements, buttons);
  }

  override formatCardResolution(chatId: string, data: CardResolutionData): OutboundMessage {
    const templateMap: Record<CardResolutionData['resolution'], string> = {
      approved: 'green',
      denied: 'red',
      skipped: 'grey',
      answered: 'green',
      selected: 'green',
    };
    const template = templateMap[data.resolution] ?? 'grey';
    const title = data.contextSuffix ? `${data.label}${data.contextSuffix}` : data.label;
    const elements: FeishuElement[] = data.originalText
      ? [this.md(`${data.originalText}\n\n${data.label}`)]
      : [this.md(data.label)];
    return this.createCardMessage(chatId, { template, title }, elements, data.buttons);
  }

  override formatVersionUpdate(chatId: string, data: VersionUpdateData): OutboundMessage {
    const dateStr = data.publishedAt
      ? new Date(data.publishedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
      : '';
    const elements: FeishuElement[] = [
      this.md(`**当前版本**\nv${data.current}`),
      this.md(`**最新版本**\nv${data.latest}`),
    ];
    if (dateStr) {
      elements.push(this.md(`**发布时间**\n${dateStr}`));
    }

    const buttons: Button[] = [
      { label: '⬆️ 立即升级', callbackData: `cmd:upgrade confirm:${data.latest}`, style: 'primary' },
    ];

    return this.createCardMessage(chatId,
      { template: 'blue', title: '🔄 发现新版本' },
      elements,
      buttons
    );
  }

  override formatMultiSelectToggle(chatId: string, data: MultiSelectToggleData): OutboundMessage {
    const optionsList = data.options
      .map((opt, i) => `${data.selectedIndices.has(i) ? '☑' : '☐'} ${i + 1}. **${opt.label}**${opt.description ? ` — ${opt.description}` : ''}`)
      .join('\n');

    const buttons = this.buildMultiSelectButtons(data.permId, data.sessionId, data.options);
    buttons.forEach((btn, idx) => {
      if (idx < data.options.length) {
        btn.label = `${data.selectedIndices.has(idx) ? '☑' : '☐'} ${data.options[idx].label}`;
      }
    });

    const elements: FeishuElement[] = [
      this.md(`**问题**\n${data.question}`),
      this.md(`**选项**\n${optionsList}`),
      this.md('**说明**\n点击选项切换勾选，然后点 Submit；也可以直接回复文字。'),
    ];

    return this.createCardMessage(chatId,
      { template: 'blue', title: '❓ 等待回答' },
      elements,
      buttons
    );
  }
}
