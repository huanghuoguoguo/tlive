/**
 * Feishu home screen formatting - extracted from main formatter.
 */

import type { FeishuCardElement } from './card-builder.js';
import type { HomeData } from '../../formatting/message-types.js';
import type { Button } from '../../ui/types.js';
import { navNew } from '../../ui/buttons.js';
import { truncate } from '../../utils/string.js';
import { downgradeHeadings, splitLargeTables } from './markdown.js';

/** Unified session status label for consistent display across /status and /home */
export function sessionStatusLabel(isTurnActive: boolean, isAlive: boolean): { icon: string; text: string } {
  if (isTurnActive) return { icon: '⏳', text: '执行中' };
  if (isAlive) return { icon: '🟢', text: '活跃' };
  return { icon: '💤', text: '空闲' };
}

/** Shared helper for creating markdown elements with table handling */
export function mdElement(content: string): FeishuCardElement {
  return { tag: 'markdown', content: downgradeHeadings(splitLargeTables(content)) };
}

/** Shared helper for panel content */
export function mdPanel(content: string): { tag: string; content: string } {
  return { tag: 'markdown', content: downgradeHeadings(splitLargeTables(content)) };
}

export interface FormatHomeParams {
  chatId: string;
  data: HomeData;
  locale: 'en' | 'zh';
  md: (content: string) => FeishuCardElement;
  buildButtons: (buttons: Button[]) => FeishuCardElement[];
}

export function buildHomeElements(params: FormatHomeParams): FeishuCardElement[] {
  const { data, md, buildButtons } = params;
  const elements: FeishuCardElement[] = [];

  // Global status - minimal
  const bridgeStatus = data.bridge.healthy ? '🟢' : '🔴';
  const channels = data.bridge.channels?.join(', ') || '无';
  const taskStatus = data.task.active ? '⏳' : '✅';

  elements.push(md(`${bridgeStatus} ${channels} · ${taskStatus}`));

  // Current bridge session info (always show)
  if (data.session.current) {
    const sessionInfo = data.session.current;
    const sdkInfo = sessionInfo.sdkSessionId
      ? `\n**SDK会话** \`${sessionInfo.sdkSessionId.slice(0, 8)}…\``
      : '\n**SDK会话** (未绑定)';
    const queueInfo = sessionInfo.queueDepth
      ? `\n**队列** ${sessionInfo.queueDepth} 条待处理`
      : '';
    elements.push({
      tag: 'collapsible_panel',
      expanded: sessionInfo.isActive,
      header: { title: { tag: 'plain_text', content: `📍 当前会话 ${sessionInfo.isActive ? '⏳' : '✅'}` } },
      elements: [mdPanel(`**目录** \`${sessionInfo.cwd}\`${sdkInfo}${queueInfo}\n**权限** ${data.permission.mode === 'on' ? '🔐 开启' : '⚡ 关闭'}`)],
    } as FeishuCardElement);
  }

  // Active sessions (in-memory managed sessions for this chat)
  if (data.session.managed && data.session.managed.length > 1) {
    const bsessionElements: FeishuCardElement[] = [];
    for (const s of data.session.managed) {
      const { icon: statusIcon, text: statusText } = sessionStatusLabel(s.isTurnActive, s.isAlive);
      const status = `${statusIcon} ${statusText}`;
      const currentMark = s.isCurrent ? ' ◀' : '';
      const queueText = s.queueDepth > 0 ? ` · 队列 ${s.queueDepth}` : '';
      const sdkShort = s.sdkSessionId ? s.sdkSessionId.slice(0, 8) : '-';
      const headerText = `${status} \`${sdkShort}\` ${truncate(s.workdir, 20)}${queueText}${currentMark}`;

      const panelContent: FeishuCardElement[] = [
        md(`**目录** \`${s.workdir}\`\n**SDK** \`${sdkShort}\`\n**状态** ${status}${queueText}`),
      ];

      if (!s.isCurrent) {
        panelContent.push(...buildButtons([
          { label: '切换 ▶️', callbackData: `cmd:rebind ${s.bindingSessionId}`, style: 'default', row: 0 },
        ]));
      }

      bsessionElements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: { title: { tag: 'plain_text', content: headerText } },
        elements: panelContent,
      } as FeishuCardElement);
    }
    elements.push({
      tag: 'collapsible_panel',
      expanded: true,
      header: { title: { tag: 'plain_text', content: `🔄 活跃会话 (${data.session.managed.length})` } },
      elements: bsessionElements,
    } as FeishuCardElement);
  }

  // Recent sessions (current workspace)
  if (data.session.recent?.length) {
    const recentElements = buildRecentSessionPanels(data, md, buildButtons);
    if (recentElements.length > 0) {
      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: { title: { tag: 'plain_text', content: `📋 历史 (${data.workspace.cwd})` } },
        elements: recentElements,
      } as FeishuCardElement);
    }
  }

  // All sessions (global)
  if (data.session.all?.length) {
    const allElements = buildAllSessionPanels(data, md, buildButtons);
    if (allElements.length > 0) {
      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: { title: { tag: 'plain_text', content: '📋 全局' } },
        elements: allElements,
      } as FeishuCardElement);
    }
  }

  // Help as collapsible
  if (data.help?.entries?.length) {
    const helpText = data.help.entries
      .map(e => `/${e.cmd} — ${e.desc}`)
      .join('\n');
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: { title: { tag: 'plain_text', content: '❓ 帮助' } },
      elements: [mdPanel(helpText)],
    } as FeishuCardElement);
  }

  return elements;
}

function buildRecentSessionPanels(
  data: HomeData,
  md: (content: string) => FeishuCardElement,
  buildButtons: (buttons: Button[]) => FeishuCardElement[]
): FeishuCardElement[] {
  const recentElements: FeishuCardElement[] = [];
  for (const s of data.session.recent ?? []) {
    if (s.isCurrent) continue;

    const boundMarker = s.boundToActiveSession
      ? ` 🔒 (${s.boundToActiveSession.chatId.slice(-4)})`
      : '';
    const headerText = `${s.index}. ${s.date} · ${truncate(s.preview, 30)}${boundMarker}`;
    const transcriptLines = s.transcript?.map(t => {
      const icon = t.role === 'user' ? '👤' : '🤖';
      return `${icon} ${truncate(t.text, 80)}`;
    }).join('\n') || s.preview;

    const panelContent: FeishuCardElement[] = [
      md(`**大小** ${s.size || '-'}\n**最近对话**\n${transcriptLines}`),
    ];

    if (s.boundToActiveSession) {
      panelContent.push(md(`⚠️ 正在 ${s.boundToActiveSession.chatId.slice(-4)} 活跃中`));
    } else {
      panelContent.push(...buildButtons([
        { label: `▶️`, callbackData: `cmd:session ${s.index}`, style: 'default', row: 0 },
      ]));
    }

    recentElements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: { title: { tag: 'plain_text', content: headerText } },
      elements: panelContent,
    } as FeishuCardElement);
  }
  return recentElements;
}

function buildAllSessionPanels(
  data: HomeData,
  md: (content: string) => FeishuCardElement,
  buildButtons: (buttons: Button[]) => FeishuCardElement[]
): FeishuCardElement[] {
  const allElements: FeishuCardElement[] = [];
  for (const s of data.session.all ?? []) {
    if (s.isCurrent) continue;

    const boundMarker = s.boundToActiveSession
      ? ` 🔒 (${s.boundToActiveSession.chatId.slice(-4)})`
      : '';
    const headerText = `${s.index}. ${truncate(s.cwd, 20)} · ${truncate(s.preview, 20)}${boundMarker}`;
    const transcriptLines = s.transcript?.map(t => {
      const icon = t.role === 'user' ? '👤' : '🤖';
      return `${icon} ${truncate(t.text, 80)}`;
    }).join('\n') || s.preview;

    const panelContent: FeishuCardElement[] = [
      md(`**目录** \`${s.cwd}\`\n**时间** ${s.date}\n**最近对话**\n${transcriptLines}`),
    ];

    if (s.boundToActiveSession) {
      panelContent.push(md(`⚠️ 正在 ${s.boundToActiveSession.chatId.slice(-4)} 活跃中`));
    } else {
      panelContent.push(...buildButtons([
        { label: `▶️`, callbackData: `cmd:session ${s.index} --all`, style: 'default', row: 0 },
      ]));
    }

    allElements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: { title: { tag: 'plain_text', content: headerText } },
      elements: panelContent,
    } as FeishuCardElement);
  }
  return allElements;
}

export function homeButtons(locale: 'en' | 'zh'): Button[] {
  return [navNew(locale)];
}