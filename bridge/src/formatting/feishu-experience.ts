import type { Button } from '../channels/types.js';
import { truncate } from '../utils/string.js';
import type { FeishuCardElement } from './types.js';
import { buildFeishuButtonElements } from './feishu-card.js';

export interface FeishuTaskCardState {
  phase: 'starting' | 'executing' | 'waiting_permission' | 'completed' | 'failed';
  renderedText: string;
  taskSummary: string;
  elapsedSeconds: number;
  totalTools: number;
  toolSummary?: string;
  footerLine?: string;
  currentTool?: {
    name: string;
    input: string;
    elapsed: number;
  } | null;
  permission?: {
    toolName: string;
    input: string;
    queueLength: number;
  };
  todoItems: Array<{ content: string; status: string }>;
}

function markdown(content: string): FeishuCardElement {
  return { tag: 'markdown', content };
}

function buildTodoSummary(todos: FeishuTaskCardState['todoItems']): string | null {
  if (!todos.length) return null;
  const done = todos.filter(item => item.status === 'completed').length;
  const lines = todos.slice(0, 5).map(item => {
    const icon = item.status === 'completed' ? '✅' : item.status === 'in_progress' ? '🔧' : '⬜';
    return `${icon} ${item.content}`;
  });
  return `**工作进度** (${done}/${todos.length})\n${lines.join('\n')}`;
}

function buildProcessSummary(text: string): string | null {
  const cleaned = text.trim();
  if (!cleaned) return null;
  return `**工作日志摘要**\n${truncate(cleaned, 700)}`;
}

export function buildFeishuTaskCard(
  state: FeishuTaskCardState,
  buttons: Button[],
): { header: { template: string; title: string }; elements: FeishuCardElement[] } {
  const elements: FeishuCardElement[] = [];

  const header = state.phase === 'completed'
    ? { template: 'green' as const, title: '✅ 已完成' }
    : state.phase === 'failed'
      ? { template: 'red' as const, title: '⚠️ 已停止' }
      : state.phase === 'waiting_permission'
        ? { template: 'orange' as const, title: '🔐 等待权限' }
        : { template: 'blue' as const, title: state.phase === 'starting' ? '⏳ 准备开始' : '⏳ 执行中' };

  const summaryLines = [`**任务**\n${truncate(state.taskSummary || '未命名任务', 180)}`];
  if (state.phase === 'waiting_permission' && state.permission) {
    const extraQueue = state.permission.queueLength > 1 ? `\n待处理审批：${state.permission.queueLength} 个` : '';
    summaryLines.push(
      `**当前等待**\n${state.permission.toolName}\n\`\`\`\n${truncate(state.permission.input, 260)}\n\`\`\`${extraQueue}`,
    );
  } else if (state.currentTool?.input) {
    const currentElapsed = state.currentTool.elapsed > 0 ? ` · ${state.currentTool.elapsed}s` : '';
    summaryLines.push(`**最近动作**\n${state.currentTool.name}: ${truncate(state.currentTool.input, 140)}${currentElapsed}`);
  } else if (state.totalTools > 0 && state.toolSummary) {
    summaryLines.push(`**当前阶段**\n${truncate(state.toolSummary, 180)}`);
  } else {
    summaryLines.push('**当前阶段**\n等待开始处理');
  }

  summaryLines.push(`**运行时长**\n${state.elapsedSeconds}s`);
  if (state.footerLine) {
    summaryLines.push(`**上下文**\n${state.footerLine}`);
  }
  elements.push(markdown(summaryLines.join('\n\n')));

  const todoSummary = buildTodoSummary(state.todoItems);
  if (todoSummary) elements.push(markdown(todoSummary));

  const processSummary = buildProcessSummary(state.renderedText);
  if (processSummary) elements.push(markdown(processSummary));

  elements.push(...buildFeishuButtonElements(buttons));
  return { header, elements };
}

export function buildFeishuQuestionCard(params: {
  title: string;
  question: string;
  optionsText?: string;
  hint?: string;
  buttons: Button[];
}): { header: { template: string; title: string }; elements: FeishuCardElement[] } {
  const body = [
    `**问题**\n${params.question}`,
    params.optionsText ? `**选项**\n${params.optionsText}` : null,
    params.hint ? `**说明**\n${params.hint}` : null,
  ].filter(Boolean).join('\n\n');

  return {
    header: { template: 'blue', title: params.title },
    elements: [
      markdown(body),
      ...buildFeishuButtonElements(params.buttons),
    ],
  };
}

export function buildFeishuHomeCard(params: {
  cwd: string;
  hasActiveTask: boolean;
  recentSummary?: string;
  buttons: Button[];
}): { header: { template: string; title: string }; elements: FeishuCardElement[] } {
  const blocks = [
    `**当前状态**\n${params.hasActiveTask ? '有任务正在执行，通常更适合先回到最近会话继续处理。' : '当前没有执行中的任务，可从最近会话继续，也可开始新会话。'}`,
    `**项目目录**\n${params.cwd}`,
    params.recentSummary ? `**最近一次任务**\n${truncate(params.recentSummary, 180)}` : '**最近一次任务**\n暂无历史任务摘要',
    '**说明**\n“新会话”会清空当前飞书侧会话绑定；如果你只是想接着电脑上的工作做，优先用“最近会话”或“会话列表”。',
  ];

  return {
    header: { template: 'indigo', title: '🏠 TLive 工作台' },
    elements: [
      markdown(blocks.join('\n\n')),
      ...buildFeishuButtonElements(params.buttons),
    ],
  };
}
