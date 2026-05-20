/**
 * Feishu home screen formatting - extracted from main formatter.
 */

import type { Locale } from '../../i18n/index.js';
import { t } from '../../i18n/index.js';
import type { FeishuCardElement } from './card-builder.js';
import type { HomeData } from '../../formatting/message-types.js';
import type { Button } from '../../ui/types.js';
import { navNew } from '../../ui/buttons.js';
import { truncate } from '../../core/string.js';
import { formatCompactHelp } from '../../formatting/help-format.js';
import { downgradeHeadings, splitLargeTables } from './markdown.js';

/** Unified session status label for consistent display across /status and /home */
export function sessionStatusLabel(locale: Locale, isTurnActive: boolean, isAlive: boolean): { icon: string; text: string } {
  if (isTurnActive) return { icon: '⏳', text: t(locale, 'home.statusExecuting') };
  if (isAlive) return { icon: '🟢', text: t(locale, 'home.statusActive') };
  return { icon: '💤', text: t(locale, 'home.statusIdle') };
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
  locale: Locale;
  md: (content: string) => FeishuCardElement;
  buildButtons: (buttons: Button[]) => FeishuCardElement[];
}

export function buildHomeElements(params: FormatHomeParams): FeishuCardElement[] {
  const { data, locale, md, buildButtons } = params;
  const elements: FeishuCardElement[] = [];

  // Global status as collapsible panel with bot info
  const bridgeStatus = data.bridge.healthy ? '🟢' : '🔴';
  const channels = data.bridge.channels?.join(', ') || t(locale, 'home.labelNone');
  const taskStatus = data.task.active ? '⏳' : '✅';
  const headerText = `${bridgeStatus} ${channels} · ${taskStatus}`;

  // Build panel content with bot info
  const panelLines: string[] = [];
  if (data.bridge.channelInfo) {
    for (const ch of data.bridge.channelInfo) {
      const appIdShort = ch.appId ? ch.appId.slice(0, 12) + '...' : '-';
      panelLines.push(`**${ch.type}** AppID: \`${appIdShort}\``);
    }
  }
  panelLines.push(`**状态** ${bridgeStatus} ${data.bridge.healthy ? '正常' : '异常'}`);
  panelLines.push(`**任务** ${taskStatus} ${data.task.active ? '执行中' : '空闲'}`);
  if (data.bridge.queueInfo) {
    panelLines.push(`**${t(locale, 'home.labelQueue')}** ${data.bridge.queueInfo.depth}/${data.bridge.queueInfo.max}`);
  }

  elements.push({
    tag: 'collapsible_panel',
    expanded: false,
    header: { title: { tag: 'plain_text', content: headerText } },
    elements: [mdPanel(panelLines.join('\n'))],
  } as FeishuCardElement);

  // Current context: main chat is a workbench; Feishu topics are real conversations.
  if (data.workspace.scope !== 'topic') {
    elements.push({
      tag: 'collapsible_panel',
      expanded: true,
      header: { title: { tag: 'plain_text', content: '🧭 工作台模式' } },
      elements: [mdPanel(`主会话只作为控制面。选择下方 Claude 会话会在话题内继续。\n**默认目录** \`${data.workspace.cwd}\``)],
    } as FeishuCardElement);
  } else if (data.session.current) {
    const sessionInfo = data.session.current;
    const sdkInfo = sessionInfo.sdkSessionId
      ? `\n**${t(locale, 'home.labelSdkSession')}** \`${sessionInfo.sdkSessionId.slice(0, 8)}…\``
      : `\n**${t(locale, 'home.labelSdkSession')}** (${t(locale, 'home.labelSdkUnbound')})`;
    const queueInfo = sessionInfo.queueDepth
      ? `\n**${t(locale, 'home.labelQueue')}** ${sessionInfo.queueDepth} ${t(locale, 'home.labelQueuePending')}`
      : '';
    elements.push({
      tag: 'collapsible_panel',
      expanded: sessionInfo.isActive,
      header: { title: { tag: 'plain_text', content: `💬 当前话题 ${sessionInfo.isActive ? '⏳' : '✅'}` } },
      elements: [mdPanel(`**${t(locale, 'home.labelDirectory')}** \`${sessionInfo.cwd}\`${sdkInfo}${queueInfo}\n**${t(locale, 'home.labelPermission')}** ${data.permission.mode === 'on' ? '🔐 ' + t(locale, 'perm.labelModeOn') : '⚡ ' + t(locale, 'perm.labelModeOff')}`)],
    } as FeishuCardElement);
  }

  // Recent topic-backed conversations.
  if (data.session.topics?.length) {
    const topicElements: FeishuCardElement[] = [];
    for (const topic of data.session.topics) {
      const status = topic.isActive ? '⏳ 执行中' : '✅ 可继续';
      const currentMark = topic.isCurrent ? ' ◀' : '';
      const sdkShort = topic.sdkSessionId ? topic.sdkSessionId.slice(0, 8) : '-';
      const panelContent: FeishuCardElement[] = [
        md(`**${t(locale, 'home.labelDirectory')}** \`${topic.cwd}\`\n**Claude** \`${sdkShort}\`\n**最近** ${topic.updatedAt}\n\n${truncate(topic.preview, 160)}`),
      ];
      if (topic.sdkSessionId) {
        panelContent.push(...buildButtons([
          { label: topic.isCurrent ? '当前话题' : '继续', callbackData: `cmd:continue ${topic.sdkSessionId}`, style: topic.isCurrent ? 'default' : 'primary', row: 0 },
        ]));
      }
      topicElements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: { title: { tag: 'plain_text', content: `${status} · ${truncate(topic.title, 28)}${currentMark}` } },
        elements: panelContent,
      } as FeishuCardElement);
    }
    elements.push({
      tag: 'collapsible_panel',
      expanded: true,
      header: { title: { tag: 'plain_text', content: `💬 最近对话 (${data.session.topics.length})` } },
      elements: topicElements,
    } as FeishuCardElement);
  }

  // Recent sessions (current workspace)
  if (data.session.recent?.length) {
    const recentElements = buildRecentSessionPanels(data, locale, md, buildButtons);
    if (recentElements.length > 0) {
      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: { title: { tag: 'plain_text', content: `📋 Claude 历史 (${data.workspace.cwd})` } },
        elements: recentElements,
      } as FeishuCardElement);
    }
  }

  // All sessions (global)
  if (data.session.all?.length) {
    const allElements = buildAllSessionPanels(data, locale, md, buildButtons);
    if (allElements.length > 0) {
      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: { title: { tag: 'plain_text', content: '📚 全部 Claude 历史' } },
        elements: allElements,
      } as FeishuCardElement);
    }
  }

  // Help as collapsible
  if (data.help?.entries?.length) {
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: { title: { tag: 'plain_text', content: t(locale, 'home.btnHelp') } },
      elements: [mdPanel(formatCompactHelp(data.help.entries))],
    } as FeishuCardElement);
  }

  // Recent projects / workspace panel (always show)
  const allProjects = data.recentProjects ?? [];
  const nonCurrentProjects = allProjects.filter(p => !p.isCurrent);
  const elements_content: FeishuCardElement[] = [];
  if (nonCurrentProjects.length > 0) {
    const projectButtons: Button[] = nonCurrentProjects
      .slice(0, 3)
      .map(p => ({
        label: `📁 ${p.name}`,
        callbackData: `cd:${p.fullWorkdir}`,
        style: 'default',
        row: 0,
      }));
    elements_content.push(...buildButtons(projectButtons));
  } else {
    // No other workspaces yet - show current + hint
    elements_content.push(md(`当前: **${data.workspace.cwd}**\n在其他目录启动会话后可快速切换。`));
  }
  elements.push({
    tag: 'collapsible_panel',
    expanded: false,
    header: { title: { tag: 'plain_text', content: `🏠 工作台` } },
    elements: elements_content,
  } as FeishuCardElement);

  return elements;
}

function buildRecentSessionPanels(
  data: HomeData,
  locale: Locale,
  md: (content: string) => FeishuCardElement,
  buildButtons: (buttons: Button[]) => FeishuCardElement[]
): FeishuCardElement[] {
  const recentElements: FeishuCardElement[] = [];
  for (const s of data.session.recent ?? []) {
    if (s.isCurrent) continue;

    const boundMarker = s.boundToActiveSession
      ? ` 🔒 (${s.boundToActiveSession.chatId.slice(-4)})`
      : s.topic
        ? ' 💬'
      : '';
    const headerText = `${s.index}. ${s.date} · ${truncate(s.preview, 30)}${boundMarker}`;
    const transcriptLines = s.transcript?.map(t => {
      const icon = t.role === 'user' ? '👤' : '🤖';
      return `${icon} ${truncate(t.text, 80)}`;
    }).join('\n') || s.preview;

    const panelContent: FeishuCardElement[] = [
      md(`**${t(locale, 'home.labelSize')}** ${s.size || '-'}\n**${t(locale, 'home.labelRecentChat')}**\n${transcriptLines}`),
    ];

    if (s.boundToActiveSession) {
      panelContent.push(md(`⚠️ ${t(locale, 'home.labelActiveIn')} ${s.boundToActiveSession.chatId.slice(-4)}`));
    } else {
      panelContent.push(...buildButtons([
        {
          label: '继续',
          callbackData: s.sdkSessionId ? `cmd:continue ${s.sdkSessionId}` : `cmd:session ${s.index}`,
          style: s.topic ? 'primary' : 'default',
          row: 0,
        },
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
  locale: Locale,
  md: (content: string) => FeishuCardElement,
  buildButtons: (buttons: Button[]) => FeishuCardElement[]
): FeishuCardElement[] {
  const allElements: FeishuCardElement[] = [];
  for (const s of data.session.all ?? []) {
    if (s.isCurrent) continue;

    const boundMarker = s.boundToActiveSession
      ? ` 🔒 (${s.boundToActiveSession.chatId.slice(-4)})`
      : s.topic
        ? ' 💬'
      : '';
    const headerText = `${s.index}. ${truncate(s.cwd, 20)} · ${truncate(s.preview, 20)}${boundMarker}`;
    const transcriptLines = s.transcript?.map(t => {
      const icon = t.role === 'user' ? '👤' : '🤖';
      return `${icon} ${truncate(t.text, 80)}`;
    }).join('\n') || s.preview;

    const panelContent: FeishuCardElement[] = [
      md(`**${t(locale, 'home.labelDirectory')}** \`${s.cwd}\`\n**${t(locale, 'sessions.labelTime')}** ${s.date}\n**${t(locale, 'home.labelRecentChat')}**\n${transcriptLines}`),
    ];

    if (s.boundToActiveSession) {
      panelContent.push(md(`⚠️ ${t(locale, 'home.labelActiveIn')} ${s.boundToActiveSession.chatId.slice(-4)}`));
    } else {
      panelContent.push(...buildButtons([
        {
          label: '继续',
          callbackData: s.sdkSessionId ? `cmd:continue ${s.sdkSessionId}` : `cmd:session ${s.index} --all`,
          style: s.topic ? 'primary' : 'default',
          row: 0,
        },
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

export function homeButtons(locale: Locale): Button[] {
  return [navNew(locale)];
}
