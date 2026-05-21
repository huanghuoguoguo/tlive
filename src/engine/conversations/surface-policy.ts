import type { InboundMessage } from '../../channels/types.js';
import {
  conversationSurfaceFor,
  type ConversationSurface,
} from '../../channels/conversation-context.js';
import type { Locale } from '../../i18n/index.js';
import { progressRunningButtons, topicDoneButtons } from '../../ui/buttons.js';
import type { Button } from '../../ui/types.js';
import type { MessageRendererState } from '../messages/renderer-types.js';

export type { ConversationSurface } from '../../channels/conversation-context.js';

type SurfaceInput = Pick<InboundMessage, 'threadId' | 'scopeId'>;

const WORKBENCH_ONLY_COMMANDS = new Set(['tlive', 'home', 'session', 'continue']);

const WORKBENCH_ONLY_REJECTIONS: Record<string, string> = {
  tlive:
    '⚠️ /tlive 是工作台命令，只能在主会话使用。当前话题已绑定一个 Agent 会话，请直接在本话题内继续对话。',
  home: '⚠️ /home 是工作台命令，只能在主会话使用。当前话题已绑定一个 Agent 会话，请直接在本话题内继续对话。',
  session:
    '⚠️ /session 是工作台命令，只能在主会话选择或打开 Agent 会话。话题内固定绑定当前会话，不支持切换。',
  continue: '⚠️ 话题内固定绑定当前 Agent 会话，不支持切换到其他会话。',
};

export function conversationSurface(input: SurfaceInput): ConversationSurface {
  return conversationSurfaceFor(input);
}

function normalizeCommandName(command: string): string {
  return command.trim().replace(/^\//, '').split(/\s+/, 1)[0]?.toLowerCase() ?? '';
}

export function isCommandAllowedOnSurface(command: string, surface: ConversationSurface): boolean {
  return surface !== 'topic' || !WORKBENCH_ONLY_COMMANDS.has(normalizeCommandName(command));
}

export function commandRejectionForSurface(
  command: string,
  surface: ConversationSurface,
): string | undefined {
  if (surface !== 'topic') return undefined;
  return WORKBENCH_ONLY_REJECTIONS[normalizeCommandName(command)];
}

export function helpEntriesForSurface<T extends { cmd: string }>(
  entries: T[],
  surface: ConversationSurface,
): T[] {
  if (surface === 'workbench') return entries;
  return entries.filter((entry) => isCommandAllowedOnSurface(entry.cmd, surface));
}

export function helpButtonsForSurface(surface: ConversationSurface): Button[] | undefined {
  return surface === 'topic' ? [] : undefined;
}

export function progressButtonsForSurface(
  surface: ConversationSurface,
  phase: MessageRendererState['phase'],
  locale: Locale,
  sessionKey?: string,
): Button[] | undefined {
  if (phase === 'starting' || phase === 'executing') {
    return progressRunningButtons(locale, sessionKey);
  }
  return taskSummaryButtonsForSurface(surface, locale);
}

export function taskSummaryButtonsForSurface(
  surface: ConversationSurface,
  locale: Locale,
): Button[] | undefined {
  return surface === 'topic' ? topicDoneButtons(locale) : undefined;
}
