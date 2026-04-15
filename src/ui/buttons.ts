/**
 * Centralized button factories — locale-aware, using CALLBACK_PREFIXES.
 * All UI components should use these instead of defining buttons inline.
 */

import type { Button } from './types.js';
import type { Locale } from '../i18n/index.js';
import { CALLBACK_PREFIXES } from '../utils/constants.js';

// ---------------------------------------------------------------------------
// Internal navigation button helpers
// ---------------------------------------------------------------------------

function navHome(locale: Locale): Button {
  return { label: locale === 'zh' ? '🏠 首页' : '🏠 Home', callbackData: `${CALLBACK_PREFIXES.CMD}home`, style: 'default', row: 0 };
}

export function navNew(locale: Locale): Button {
  return { label: locale === 'zh' ? '🆕 新会话' : '🆕 New', callbackData: `${CALLBACK_PREFIXES.CMD}new`, style: 'default', row: 1 };
}

function navHelp(locale: Locale): Button {
  return { label: locale === 'zh' ? '❓ 帮助' : '❓ Help', callbackData: `${CALLBACK_PREFIXES.CMD}help`, style: 'default', row: 1 };
}

function navSessions(locale: Locale): Button {
  return { label: locale === 'zh' ? '📋 会话列表' : '📋 Sessions', callbackData: `${CALLBACK_PREFIXES.CMD}sessions`, style: 'default', row: 0 };
}

function navSessionsAll(locale: Locale): Button {
  return { label: locale === 'zh' ? '🕘 最近会话' : '🕘 Recent', callbackData: `${CALLBACK_PREFIXES.CMD}sessions --all`, style: 'primary', row: 0 };
}

function navStop(locale: Locale): Button {
  return { label: locale === 'zh' ? '⏹ 停止执行' : '⏹ Stop', callbackData: `${CALLBACK_PREFIXES.CMD}stop`, style: 'danger', row: 0 };
}

function navSettings(locale: Locale): Button {
  return { label: locale === 'zh' ? '🏠 调整配置' : '⚡ Settings', callbackData: `${CALLBACK_PREFIXES.CMD}home`, style: 'default', row: 0 };
}

function navPerm(locale: Locale): Button {
  return { label: locale === 'zh' ? '🔐 权限设置' : '🔐 Permissions', callbackData: `${CALLBACK_PREFIXES.CMD}perm`, style: 'default', row: 0 };
}

// ---------------------------------------------------------------------------
// Internal permission button helpers
// ---------------------------------------------------------------------------

function permAllow(permId: string, locale: Locale): Button {
  return { label: locale === 'zh' ? '✅ 允许本次' : '✅ Allow', callbackData: `${CALLBACK_PREFIXES.PERM_ALLOW}${permId}`, style: 'primary', row: 0 };
}

function permAlwaysInSession(permId: string, locale: Locale): Button {
  return { label: locale === 'zh' ? '📌 本会话始终允许' : '📌 Always in Session', callbackData: `${CALLBACK_PREFIXES.PERM_ALLOW_SESSION}${permId}`, style: 'default', row: 0 };
}

function permDeny(permId: string, locale: Locale): Button {
  return { label: locale === 'zh' ? '❌ 拒绝' : '❌ Deny', callbackData: `${CALLBACK_PREFIXES.PERM_DENY}${permId}`, style: 'danger', row: 1 };
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
  return { label: locale === 'zh' ? '✅ 提交' : '✅ Submit', callbackData: `${CALLBACK_PREFIXES.DEFERRED_SUBMIT}${permId}`, style: 'primary', row: 0 };
}

export function deferredSkip(permId: string, locale: Locale): Button {
  return { label: locale === 'zh' ? '⏭ 跳过' : '⏭ Skip', callbackData: `${CALLBACK_PREFIXES.DEFERRED_SKIP}${permId}`, style: 'default', row: 0 };
}

export function homeButtons(locale: Locale): Button[] {
  return [
    navSessionsAll(locale),
    navPerm(locale),
    { ...navNew(locale), row: 1 },
    navHelp(locale),
  ];
}

export function progressDoneButtons(locale: Locale): Button[] {
  return [
    navSessionsAll(locale),
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
    { ...navSessionsAll(locale), style: 'default' as const },
  ];
}

export function helpButtons(locale: Locale): Button[] {
  return [
    { ...navNew(locale), style: 'primary' as const, row: 0 },
    { ...navSessions(locale), row: 0 },
  ];
}

export function permStatusButtons(mode: 'on' | 'off', locale: Locale): Button[] {
  const toggle: Button = mode === 'on'
    ? { label: locale === 'zh' ? '⚡ 关闭审批' : '⚡ Turn Off', callbackData: `${CALLBACK_PREFIXES.CMD}perm off`, style: 'danger', row: 0 }
    : { label: locale === 'zh' ? '🔐 开启审批' : '🔐 Turn On', callbackData: `${CALLBACK_PREFIXES.CMD}perm on`, style: 'primary', row: 0 };
  return [toggle, navHome(locale)];
}