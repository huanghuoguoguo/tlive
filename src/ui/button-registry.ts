import { CALLBACK_PREFIXES } from '../core/callbacks.js';
import type { TranslationKey } from '../i18n/index.js';

export type ButtonAction = { kind: 'cmd'; command: string };

export interface QuickButtonDefinition {
  labelKey: TranslationKey;
  action: ButtonAction;
}

export const QUICK_BUTTONS = {
  home: { labelKey: 'perm.btnHome', action: { kind: 'cmd', command: 'home' } },
  sessions: { labelKey: 'home.btnSessions', action: { kind: 'cmd', command: 'sessions' } },
  new: { labelKey: 'home.btnNew', action: { kind: 'cmd', command: 'new' } },
  help: { labelKey: 'home.btnHelp', action: { kind: 'cmd', command: 'help' } },
  perm: { labelKey: 'home.btnPermissions', action: { kind: 'cmd', command: 'perm' } },
} as const satisfies Record<string, QuickButtonDefinition>;

export type QuickButtonName = keyof typeof QUICK_BUTTONS;

export const DEFAULT_DONE_BUTTONS: QuickButtonName[] = ['home'];

const QUICK_BUTTON_ALIASES: Record<string, QuickButtonName | 'none'> = {
  home: 'home',
  workbench: 'home',
  sessions: 'sessions',
  session: 'sessions',
  recent: 'sessions',
  new: 'new',
  'new-session': 'new',
  help: 'help',
  perm: 'perm',
  permission: 'perm',
  permissions: 'perm',
  none: 'none',
  off: 'none',
};

export function encodeButtonAction(action: ButtonAction): string {
  switch (action.kind) {
    case 'cmd':
      return `${CALLBACK_PREFIXES.CMD}${action.command}`;
  }
}

function supportedQuickButtonsText(): string {
  return `${Object.keys(QUICK_BUTTONS).join(',')},none`;
}

export function normalizeQuickButtonNames(
  value: string | undefined,
  defaultButtons: readonly QuickButtonName[] = DEFAULT_DONE_BUTTONS,
): QuickButtonName[] {
  const rawItems = value?.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) ?? [];
  const items = rawItems.length ? rawItems : [...defaultButtons];
  const buttons: QuickButtonName[] = [];

  for (const item of items) {
    const normalized = QUICK_BUTTON_ALIASES[item];
    if (!normalized) {
      throw new Error(
        `Config error: TL_DONE_BUTTONS contains unsupported button '${item}'. ` +
        `Supported: ${supportedQuickButtonsText()}`,
      );
    }
    if (normalized === 'none') {
      return [];
    }
    if (!buttons.includes(normalized)) {
      buttons.push(normalized);
    }
  }

  return buttons;
}
