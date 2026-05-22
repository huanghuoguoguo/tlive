/**
 * Centralized button factories - locale-aware, using CALLBACK_PREFIXES.
 * All UI components should use these instead of defining buttons inline.
 */

import type { Button } from './types.js';
import type { Locale, TranslationKey } from '../i18n/index.js';
import type { AgentProviderKind } from '../providers/kinds.js';
import { t } from '../i18n/index.js';
import {
  CALLBACK_PREFIXES,
  actionCallback,
  routedActionCallback,
  type ActionCallbackRoute,
} from '../core/callbacks.js';
import {
  DEFAULT_DONE_BUTTONS,
  QUICK_BUTTONS,
  encodeButtonAction,
  type QuickButtonName,
} from './button-registry.js';

export { DEFAULT_DONE_BUTTONS, type QuickButtonName } from './button-registry.js';

// ---------------------------------------------------------------------------
// Internal navigation button helpers
// ---------------------------------------------------------------------------

function quickButton(
  locale: Locale,
  name: QuickButtonName,
  options: Pick<Button, 'row' | 'style'> & { labelKey?: TranslationKey } = {},
): Button {
  const definition = QUICK_BUTTONS[name];
  return {
    label: t(locale, options.labelKey ?? definition.labelKey),
    callbackData: encodeButtonAction(definition.action),
    style: options.style ?? 'default',
    row: options.row,
  };
}

function navHome(locale: Locale): Button {
  return quickButton(locale, 'home', { row: 0 });
}

export function navNew(locale: Locale): Button {
  return quickButton(locale, 'new', { row: 1 });
}

export interface NewSessionButtonProvider {
  kind: AgentProviderKind;
  displayName: string;
  isDefault?: boolean;
}

function navNewForProvider(
  locale: Locale,
  provider: NewSessionButtonProvider,
  row: number,
): Button {
  const label =
    locale === 'zh' ? `🆕 新 ${provider.displayName} 会话` : `🆕 New ${provider.displayName}`;
  return {
    label,
    callbackData: actionCallback('new', provider.kind),
    style: provider.isDefault ? 'primary' : 'default',
    row,
  };
}

function navHelp(locale: Locale): Button {
  return quickButton(locale, 'help', { row: 1 });
}

function navStop(locale: Locale, sessionKey?: string): Button {
  return {
    label: t(locale, 'progress.btnStop'),
    callbackData: actionCallback('stop', sessionKey),
    style: 'danger',
    row: 0,
  };
}

function navSettings(locale: Locale): Button {
  return {
    label: t(locale, 'taskStart.btnSettings'),
    callbackData: actionCallback('home'),
    style: 'default',
    row: 0,
  };
}

function navPerm(locale: Locale): Button {
  return quickButton(locale, 'perm', { row: 0 });
}

function navQuick(locale: Locale, name: QuickButtonName, index: number): Button {
  return quickButton(locale, name, {
    style: index === 0 ? 'primary' : 'default',
    row: index < 2 ? 0 : 1,
  });
}

function quickButtons(
  locale: Locale,
  names: readonly QuickButtonName[] = DEFAULT_DONE_BUTTONS,
): Button[] {
  return names.map((name, index) => navQuick(locale, name, index));
}

// ---------------------------------------------------------------------------
// Internal permission button helpers
// ---------------------------------------------------------------------------

function permAllow(permId: string, locale: Locale): Button {
  return {
    label: t(locale, 'perm.decisionAllow'),
    callbackData: `${CALLBACK_PREFIXES.PERM_ALLOW}${permId}`,
    style: 'primary',
    row: 0,
  };
}

function permAllowSameCommand(permId: string, locale: Locale): Button {
  return {
    label: t(locale, 'perm.decisionAllowSameCommand'),
    callbackData: `${CALLBACK_PREFIXES.PERM_ALLOW_SAME}${permId}`,
    style: 'default',
    row: 0,
  };
}

function permAllowAllInSession(permId: string, locale: Locale): Button {
  return {
    label: t(locale, 'perm.decisionAllowSessionAll'),
    callbackData: `${CALLBACK_PREFIXES.PERM_ALLOW_ALL_SESSION}${permId}`,
    style: 'default',
    row: 1,
  };
}

function permDeny(permId: string, locale: Locale): Button {
  return {
    label: t(locale, 'perm.decisionDeny'),
    callbackData: `${CALLBACK_PREFIXES.PERM_DENY}${permId}`,
    style: 'danger',
    row: 1,
  };
}

// ---------------------------------------------------------------------------
// Exported button factories
// ---------------------------------------------------------------------------

export function permissionButtons(permId: string, locale: Locale): Button[] {
  return [
    permAllow(permId, locale),
    permAllowSameCommand(permId, locale),
    permAllowAllInSession(permId, locale),
    permDeny(permId, locale),
  ];
}

export function deferredSubmit(permId: string, locale: Locale): Button {
  return {
    label: t(locale, 'deferred.btnSubmit'),
    callbackData: `${CALLBACK_PREFIXES.DEFERRED_SUBMIT}${permId}`,
    style: 'primary',
    row: 0,
  };
}

export function deferredSkip(permId: string, locale: Locale): Button {
  return {
    label: t(locale, 'deferred.btnSkip'),
    callbackData: `${CALLBACK_PREFIXES.DEFERRED_SKIP}${permId}`,
    style: 'default',
    row: 0,
  };
}

export function newSessionButtons(
  locale: Locale,
  providers: readonly NewSessionButtonProvider[] = [],
  row = 1,
): Button[] {
  if (providers.length === 0) {
    return [{ ...navNew(locale), row }];
  }
  return providers.map((provider) => navNewForProvider(locale, provider, row));
}

export function homeButtons(
  locale: Locale,
  providers: readonly NewSessionButtonProvider[] = [],
): Button[] {
  return [navPerm(locale), ...newSessionButtons(locale, providers, 1), navHelp(locale)];
}

export function progressDoneButtons(
  locale: Locale,
  names: readonly QuickButtonName[] = DEFAULT_DONE_BUTTONS,
): Button[] {
  return quickButtons(locale, names);
}

export function progressRunningButtons(locale: Locale, sessionKey?: string): Button[] {
  return [navStop(locale, sessionKey)];
}

export function taskStartButtons(locale: Locale): Button[] {
  return [navSettings(locale), { ...navNew(locale), row: 0 }];
}

export function taskSummaryButtons(
  locale: Locale,
  names: readonly QuickButtonName[] = DEFAULT_DONE_BUTTONS,
): Button[] {
  return quickButtons(locale, names);
}

export function topicDoneButtons(_locale: Locale): Button[] {
  return [];
}

export function topicCommandPaletteButtons(
  locale: Locale,
  options: {
    isActive?: boolean;
    interactivePermissions?: boolean;
    route?: ActionCallbackRoute;
  } = {},
): Button[] {
  const action = (name: string, ...args: Array<string | undefined>) =>
    options.route
      ? routedActionCallback(name, options.route, ...args)
      : actionCallback(name, ...args);
  const buttons: Button[] = [];

  if (options.interactivePermissions) {
    buttons.push({
      label: locale === 'zh' ? '🔐 工具审批' : t(locale, 'home.btnPermissions'),
      callbackData: action('perm'),
      style: 'default',
      row: 0,
    });
  }

  if (options.isActive) {
    buttons.push({
      ...navStop(locale),
      callbackData: action('stop'),
      row: 0,
    });
  }

  return buttons;
}

export function helpButtons(locale: Locale): Button[] {
  return [{ ...navNew(locale), style: 'primary' as const, row: 0 }];
}

export function permStatusButtons(
  mode: 'on' | 'off',
  locale: Locale,
  route?: ActionCallbackRoute,
): Button[] {
  const action = (name: string, ...args: Array<string | undefined>) =>
    route ? routedActionCallback(name, route, ...args) : actionCallback(name, ...args);
  const toggle: Button =
    mode === 'on'
      ? {
          label: t(locale, 'perm.btnTurnOff'),
          callbackData: action('perm', 'off'),
          style: 'danger',
          row: 0,
        }
      : {
          label: t(locale, 'perm.btnTurnOn'),
          callbackData: action('perm', 'on'),
          style: 'primary',
          row: 0,
        };
  return route ? [toggle] : [toggle, navHome(locale)];
}
