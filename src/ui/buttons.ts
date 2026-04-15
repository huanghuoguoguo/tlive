/**
 * Centralized button factories — locale-aware, using CALLBACK_PREFIXES.
 * All UI components should use these instead of defining buttons inline.
 */

import type { Button } from './types.js';
import type { Locale } from '../i18n/index.js';
import { t } from '../i18n/index.js';
import { CALLBACK_PREFIXES } from '../utils/constants.js';

// ---------------------------------------------------------------------------
// Internal navigation button helpers
// ---------------------------------------------------------------------------

function navHome(locale: Locale): Button {
  return { label: t(locale, 'perm.btnHome'), callbackData: `${CALLBACK_PREFIXES.CMD}home`, style: 'default', row: 0 };
}

export function navNew(locale: Locale): Button {
  return { label: t(locale, 'home.btnNew'), callbackData: `${CALLBACK_PREFIXES.CMD}new`, style: 'default', row: 1 };
}

function navHelp(locale: Locale): Button {
  return { label: t(locale, 'home.btnHelp'), callbackData: `${CALLBACK_PREFIXES.CMD}help`, style: 'default', row: 1 };
}

function navSessionsList(locale: Locale): Button {
  return { label: t(locale, 'sessions.btnList'), callbackData: `${CALLBACK_PREFIXES.CMD}sessions`, style: 'default', row: 0 };
}

function navSessionsRecent(locale: Locale): Button {
  return { label: t(locale, 'home.btnSessions'), callbackData: `${CALLBACK_PREFIXES.CMD}sessions`, style: 'primary', row: 0 };
}

function navStop(locale: Locale): Button {
  return { label: t(locale, 'progress.btnStop'), callbackData: `${CALLBACK_PREFIXES.CMD}stop`, style: 'danger', row: 0 };
}

function navSettings(locale: Locale): Button {
  return { label: t(locale, 'taskStart.btnSettings'), callbackData: `${CALLBACK_PREFIXES.CMD}home`, style: 'default', row: 0 };
}

function navPerm(locale: Locale): Button {
  return { label: t(locale, 'home.btnPermissions'), callbackData: `${CALLBACK_PREFIXES.CMD}perm`, style: 'default', row: 0 };
}

// ---------------------------------------------------------------------------
// Internal permission button helpers
// ---------------------------------------------------------------------------

function permAllow(permId: string, locale: Locale): Button {
  return { label: t(locale, 'perm.decisionAllow'), callbackData: `${CALLBACK_PREFIXES.PERM_ALLOW}${permId}`, style: 'primary', row: 0 };
}

function permAlwaysInSession(permId: string, locale: Locale): Button {
  return { label: t(locale, 'perm.decisionAlwaysAllow'), callbackData: `${CALLBACK_PREFIXES.PERM_ALLOW_SESSION}${permId}`, style: 'default', row: 0 };
}

function permDeny(permId: string, locale: Locale): Button {
  return { label: t(locale, 'perm.decisionDeny'), callbackData: `${CALLBACK_PREFIXES.PERM_DENY}${permId}`, style: 'danger', row: 1 };
}

// ---------------------------------------------------------------------------
// Exported button factories
// ---------------------------------------------------------------------------

export function permissionButtons(permId: string, locale: Locale): Button[] {
  return [
    permAllow(permId, locale),
    permAlwaysInSession(permId, locale),
    permDeny(permId, locale),
  ];
}

export function deferredSubmit(permId: string, locale: Locale): Button {
  return { label: t(locale, 'deferred.btnSubmit'), callbackData: `${CALLBACK_PREFIXES.DEFERRED_SUBMIT}${permId}`, style: 'primary', row: 0 };
}

export function deferredSkip(permId: string, locale: Locale): Button {
  return { label: t(locale, 'deferred.btnSkip'), callbackData: `${CALLBACK_PREFIXES.DEFERRED_SKIP}${permId}`, style: 'default', row: 0 };
}

export function homeButtons(locale: Locale): Button[] {
  return [
    navSessionsRecent(locale),
    navPerm(locale),
    { ...navNew(locale), row: 1 },
    navHelp(locale),
  ];
}

export function progressDoneButtons(locale: Locale): Button[] {
  return [
    navSessionsRecent(locale),
    { ...navNew(locale), row: 0 },
    navHelp(locale),
  ];
}

export function progressRunningButtons(locale: Locale): Button[] {
  return [
    navStop(locale),
    navHelp(locale),
  ];
}

export function taskStartButtons(locale: Locale): Button[] {
  return [
    navSettings(locale),
    { ...navNew(locale), row: 0 },
  ];
}

export function taskSummaryButtons(locale: Locale): Button[] {
  return [
    { ...navHome(locale), style: 'primary' as const },
    { ...navSessionsRecent(locale), style: 'default' as const },
  ];
}

export function helpButtons(locale: Locale): Button[] {
  return [
    { ...navNew(locale), style: 'primary' as const, row: 0 },
    { ...navSessionsList(locale), row: 0 },
  ];
}

export function permStatusButtons(mode: 'on' | 'off', locale: Locale): Button[] {
  const toggle: Button = mode === 'on'
    ? { label: t(locale, 'perm.btnTurnOff'), callbackData: `${CALLBACK_PREFIXES.CMD}perm off`, style: 'danger', row: 0 }
    : { label: t(locale, 'perm.btnTurnOn'), callbackData: `${CALLBACK_PREFIXES.CMD}perm on`, style: 'primary', row: 0 };
  return [toggle, navHome(locale)];
}