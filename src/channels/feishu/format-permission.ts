/**
 * Feishu permission and question formatting - extracted from main formatter.
 */

import type { FeishuCardElement } from './card-builder.js';
import { buildFeishuButtonElements } from './card-builder.js';
import type {
  PermissionData,
  QuestionData,
  DeferredToolInputData,
  PermissionStatusData,
  MultiSelectToggleData,
} from '../../formatting/message-types.js';
import type { Button } from '../../ui/types.js';
import {
  permissionButtons,
  permStatusButtons,
} from '../../ui/buttons.js';
import { truncate } from '../../utils/string.js';
import { downgradeHeadings } from './markdown.js';
import { mdElement } from './format-home.js';

export interface FormatPermissionParams {
  chatId: string;
  data: PermissionData;
  locale: 'en' | 'zh';
}

export function buildPermissionElements(params: FormatPermissionParams): FeishuCardElement[] {
  const { data, locale } = params;
  const input = truncate(data.toolInput, 300);
  const expires = data.expiresInMinutes ?? 5;
  const elements: FeishuCardElement[] = [
    mdElement(`**工具**\n${data.toolName}`),
    mdElement(`**输入**\n\`\`\`\n${input}\n\`\`\``),
    mdElement(`⏱ ${expires} 分钟内处理`),
  ];
  if (data.terminalUrl) {
    elements.push(mdElement(`🔗 [在终端中查看](${data.terminalUrl})`));
  }
  elements.push(mdElement('💬 也可以直接回复 **allow** / **deny** / **always**。'));
  return elements;
}

export function permissionFormatButtons(data: PermissionData, locale: 'en' | 'zh'): Button[] {
  return permissionButtons(data.permissionId, locale);
}

export interface FormatQuestionParams {
  chatId: string;
  data: QuestionData;
}

export function buildQuestionElements(params: FormatQuestionParams): FeishuCardElement[] {
  const { data } = params;
  const { question, options, multiSelect, permId, sessionId } = data;

  const cardElements: FeishuCardElement[] = [
    mdElement(`**问题**\n${question}`),
  ];

  const useSelectDropdown = !multiSelect && options.length > 4;

  if (!useSelectDropdown) {
    const optionsList = options
      .map((opt, i) => `${i + 1}. **${opt.label}**${opt.description ? ` — ${opt.description}` : ''}`)
      .join('\n');
    cardElements.push(mdElement(`**选项**\n${optionsList}`));
    if (multiSelect) {
      cardElements.push(mdElement('💡 点击选项切换勾选，然后点提交。'));
    } else {
      cardElements.push(mdElement('💡 点击选项或直接回复文字。'));
    }
  }

  // Build form elements
  const formElements: FeishuCardElement[] = [];

  if (useSelectDropdown) {
    formElements.push({
      tag: 'select_static',
      name: '_select',
      placeholder: { tag: 'plain_text', content: '选择一个选项...' },
      options: options.map(opt => ({
        text: { tag: 'plain_text', content: opt.label },
        value: opt.label,
      })),
      required: false,
    } as FeishuCardElement);
  }

  formElements.push({
    tag: 'input',
    name: '_text_answer',
    placeholder: { tag: 'plain_text', content: useSelectDropdown ? '或直接输入文字回答...' : '直接输入文字回答...' },
    required: false,
  } as FeishuCardElement);

  const formButtons = buildQuestionButtons(data);
  const formContainer: FeishuCardElement = {
    tag: 'form',
    name: `form_${permId}`,
    elements: [
      ...formElements as unknown as { tag: string; content: string }[],
      ...buildFeishuButtonElements(formButtons) as unknown as { tag: string; content: string }[],
    ],
  };

  cardElements.push(formContainer);
  return cardElements;
}

function buildQuestionButtons(data: QuestionData): Button[] {
  const { options, multiSelect, permId, sessionId } = data;
  const useSelectDropdown = !multiSelect && options.length > 4;
  const formButtons: Button[] = [];

  if (useSelectDropdown) {
    formButtons.push({ label: '✅ 提交', callbackData: `form:${permId}`, style: 'primary', row: 0 });
    formButtons.push({ label: '⏭️ 跳过', callbackData: `askq_skip:${permId}:${sessionId}`, style: 'default', row: 0 });
  } else if (multiSelect) {
    formButtons.push(...options.map((opt, idx) => ({
      label: `☐ ${opt.label}`,
      callbackData: `askq_toggle:${permId}:${idx}:${sessionId}`,
      style: 'primary' as const,
      row: idx,
    })));
    formButtons.push({ label: '✅ 提交', callbackData: `form:${permId}`, style: 'primary', row: options.length });
    formButtons.push({ label: '⏭️ 跳过', callbackData: `askq_skip:${permId}:${sessionId}`, style: 'default', row: options.length });
  } else {
    formButtons.push(...options.map((opt, idx) => ({
      label: `${idx + 1}. ${opt.label}`,
      callbackData: `perm:allow:${permId}:askq:${idx}`,
      style: 'primary' as const,
      row: idx,
    })));
    formButtons.push({ label: '✅ 提交文字', callbackData: `form:${permId}`, style: 'primary', row: options.length });
    formButtons.push({ label: '⏭️ 跳过', callbackData: `askq_skip:${permId}:${sessionId}`, style: 'default', row: options.length });
  }

  return formButtons;
}

export interface FormatDeferredToolParams {
  chatId: string;
  data: DeferredToolInputData;
}

export function buildDeferredToolElements(params: FormatDeferredToolParams): FeishuCardElement[] {
  const { data } = params;
  const { toolName, prompt, permId, sessionId, inputPlaceholder } = data;

  const cardElements: FeishuCardElement[] = [
    mdElement(`**工具请求**\n${toolName}`),
    mdElement(`**说明**\n${prompt}`),
    mdElement(`**会话**\n${sessionId}`),
    mdElement('💡 输入内容后点击提交，或直接回复文字。'),
  ];

  const formElements: FeishuCardElement[] = [
    {
      tag: 'input',
      name: '_deferred_input',
      placeholder: { tag: 'plain_text', content: inputPlaceholder || '输入内容...' },
      required: false,
    } as FeishuCardElement,
  ];

  const formButtons: Button[] = [
    { label: '✅ 提交', callbackData: `form:${permId}`, style: 'primary' as const, row: 0 },
    { label: '⏭ 跳过', callbackData: `deferred:skip:${permId}`, style: 'default' as const, row: 0 },
  ];

  const formContainer: FeishuCardElement = {
    tag: 'form',
    name: `form_deferred_${permId}`,
    elements: [
      ...formElements as unknown as { tag: string; content: string }[],
      ...buildFeishuButtonElements(formButtons) as unknown as { tag: string; content: string }[],
    ],
  };

  cardElements.push(formContainer);
  return cardElements;
}

export interface FormatPermStatusParams {
  chatId: string;
  data: PermissionStatusData;
  locale: 'en' | 'zh';
}

export function buildPermStatusElements(params: FormatPermStatusParams): FeishuCardElement[] {
  const { data } = params;
  const decisionLabel = data.lastDecision
    ? {
        allow: '允许一次',
        allow_always: '本会话始终允许',
        deny: '拒绝',
        cancelled: '已取消',
      }[data.lastDecision.decision]
    : '';

  const elements: FeishuCardElement[] = [
    mdElement(`**当前模式**\n${data.mode === 'on' ? '开启审批' : '关闭审批'}`),
    mdElement(`**本会话记忆**\n工具 ${data.rememberedTools} 项 · Bash 前缀 ${data.rememberedBashPrefixes} 项`),
  ];

  if (data.pending) {
    elements.push(mdElement(`**当前待审批**\n${data.pending.toolName}\n\`\`\`\n${truncate(data.pending.input, 220)}\n\`\`\``));
  } else {
    elements.push(mdElement('**当前待审批**\n暂无'));
  }

  if (data.lastDecision) {
    elements.push(mdElement(`**最近处理**\n${data.lastDecision.toolName} · ${decisionLabel}`));
  }

  return elements;
}

export function permStatusButtonsForMode(mode: string, locale: 'en' | 'zh'): Button[] {
  return permStatusButtons(mode, locale);
}

export interface FormatMultiSelectParams {
  chatId: string;
  data: MultiSelectToggleData;
}

export function buildMultiSelectElements(params: FormatMultiSelectParams): FeishuCardElement[] {
  const { data } = params;
  const optionsList = data.options
    .map((opt, i) => `${data.selectedIndices.has(i) ? '☑' : '☐'} ${i + 1}. **${opt.label}**${opt.description ? ` — ${opt.description}` : ''}`)
    .join('\n');

  const elements: FeishuCardElement[] = [
    mdElement(`**问题**\n${data.question}`),
    mdElement(`**选项**\n${optionsList}`),
    mdElement('**说明**\n点击选项切换勾选，然后点 Submit；也可以直接回复文字。'),
  ];

  return elements;
}

export function buildMultiSelectButtons(permId: string, sessionId: string, options: Array<{ label: string; description?: string }>): Button[] {
  const buttons: Button[] = options.map((opt, idx) => ({
    label: `☐ ${opt.label}`,
    callbackData: `askq_toggle:${permId}:${idx}:${sessionId}`,
    style: 'primary' as const,
    row: idx,
  }));
  buttons.push({ label: '✅ 提交', callbackData: `form:${permId}`, style: 'primary' as const, row: options.length });
  buttons.push({ label: '⏭️ 跳过', callbackData: `askq_skip:${permId}:${sessionId}`, style: 'default' as const, row: options.length });
  return buttons;
}