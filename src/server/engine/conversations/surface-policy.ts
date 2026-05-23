import type { InboundMessage } from '../../channels/types.js';
import {
  conversationSurfaceFor,
  type ConversationSurface,
} from '../../channels/conversation-context.js';
import type { Locale } from '../../../shared/i18n/index.js';
import { t } from '../../../shared/i18n/index.js';
import { progressRunningButtons, topicDoneButtons } from '../../../shared/ui/buttons.js';
import type { Button } from '../../../shared/ui/types.js';
import type { MessageRendererState } from '../messages/renderer-types.js';

export type { ConversationSurface } from '../../channels/conversation-context.js';

type SurfaceInput = Pick<InboundMessage, 'threadId' | 'scopeId'>;

const WORKBENCH_ONLY_COMMANDS = new Set(['tlive', 'home', 'continue']);

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
  _locale: Locale = 'zh',
): string | undefined {
  if (surface !== 'topic') return undefined;
  const cmd = normalizeCommandName(command);
  if (cmd === 'tlive') return t('surface.tliveRejection');
  if (cmd === 'home') return t('surface.homeRejection');
  if (cmd === 'continue') return t('surface.continueRejection');
  return undefined;
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
