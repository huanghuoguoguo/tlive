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

  // Global status - minimal
  const bridgeStatus = data.bridge.healthy ? '🟢' : '🔴';
  const channels = data.bridge.channels?.join(', ') || t(locale, 'home.labelNone');
  const taskStatus = data.task.active ? '⏳' : '✅';

  elements.push(md(`${bridgeStatus} ${channels} · ${taskStatus}`));

  // Current bridge session info (always show)
  if (data.session.current) {
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
      header: { title: { tag: 'plain_text', content: `📍 ${t(locale, 'home.labelCurrentSession')} ${sessionInfo.isActive ? '⏳' : '✅'}` } },
      elements: [mdPanel(`**${t(locale, 'home.labelDirectory')}** \`${sessionInfo.cwd}\`${sdkInfo}${queueInfo}\n**${t(locale, 'home.labelPermission')}** ${data.permission.mode === 'on' ? '🔐 ' + t(locale, 'perm.labelModeOn') : '⚡ ' + t(locale, 'perm.labelModeOff')}`)],
    } as FeishuCardElement);
  }

  // Active sessions (in-memory managed sessions for this chat)
  if (data.session.managed && data.session.managed.length > 1) {
    const bsessionElements: FeishuCardElement[] = [];
    for (const s of data.session.managed) {
      const { icon: statusIcon, text: statusText } = sessionStatusLabel(locale, s.isTurnActive, s.isAlive);
      const status = `${statusIcon} ${statusText}`;
      const currentMark = s.isCurrent ? ' ◀' : '';
      const queueText = s.queueDepth > 0 ? ` · ${t(locale, 'home.labelQueue')} ${s.queueDepth}` : '';
      const sdkShort = s.sdkSessionId ? s.sdkSessionId.slice(0, 8) : '-';
      const headerText = `${status} \`${sdkShort}\` ${truncate(s.workdir, 20)}${queueText}${currentMark}`;

      const panelContent: FeishuCardElement[] = [
        md(`**${t(locale, 'home.labelDirectory')}** \`${s.workdir}\`\n**SDK** \`${sdkShort}\`\n**${t(locale, 'home.labelStatus')}** ${status}${queueText}`),
      ];

      if (!s.isCurrent) {
        panelContent.push(...buildButtons([
          { label: `${t(locale, 'home.labelSwitch')} ▶️`, callbackData: `cmd:rebind ${s.bindingSessionId}`, style: 'default', row: 0 },
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
      header: { title: { tag: 'plain_text', content: `🔄 ${t(locale, 'home.activeSessions')} (${data.session.managed.length})` } },
      elements: bsessionElements,
    } as FeishuCardElement);
  }

  // Recent sessions (current workspace)
  if (data.session.recent?.length) {
    const recentElements = buildRecentSessionPanels(data, locale, md, buildButtons);
    if (recentElements.length > 0) {
      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: { title: { tag: 'plain_text', content: `📋 ${t(locale, 'home.labelHistory')} (${data.workspace.cwd})` } },
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
        header: { title: { tag: 'plain_text', content: `📋 ${t(locale, 'home.labelGlobal')}` } },
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
      header: { title: { tag: 'plain_text', content: t(locale, 'home.btnHelp') } },
      elements: [mdPanel(helpText)],
    } as FeishuCardElement);
  }

  // Recent projects buttons
  if (data.recentProjects?.length) {
    const projectButtons: Button[] = data.recentProjects
      .filter(p => !p.isCurrent)
      .slice(0, 3)
      .map(p => ({
        label: `📁 ${p.name}`,
        callbackData: `cd:${p.fullWorkdir}`,
        style: 'default',
        row: 0,
      }));
    if (projectButtons.length > 0) {
      elements.push({
        tag: 'collapsible_panel',
        expanded: true,
        header: { title: { tag: 'plain_text', content: `🏠 ${t(locale, 'home.workspaceBinding')}` } },
        elements: buildButtons(projectButtons),
      } as FeishuCardElement);
    }
  }

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
  locale: Locale,
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
      md(`**${t(locale, 'home.labelDirectory')}** \`${s.cwd}\`\n**${t(locale, 'sessions.labelTime')}** ${s.date}\n**${t(locale, 'home.labelRecentChat')}**\n${transcriptLines}`),
    ];

    if (s.boundToActiveSession) {
      panelContent.push(md(`⚠️ ${t(locale, 'home.labelActiveIn')} ${s.boundToActiveSession.chatId.slice(-4)}`));
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

export function homeButtons(locale: Locale): Button[] {
  return [navNew(locale)];
}