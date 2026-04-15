/**
 * Session formatting utilities — shared across session commands.
 */

import type { Locale } from '../i18n/index.js';
import { t } from '../i18n/index.js';
import type { CommandContext } from '../engine/commands/types.js';
import type { ScannedSession } from '../providers/session-scanner.js';
import { scanClaudeSessions } from '../providers/session-scanner.js';
import { FLAGS, hasFlag, getNonFlagArg } from './constants.js';

/** Format file size in human-readable form */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** Format session modification date in localized form */
export function formatSessionDate(mtime: number, locale: Locale): string {
  return new Date(mtime).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Format timestamp as relative time (e.g., "5分钟前", "2小时前") */
export function formatRelativeTime(timestamp: number, locale: Locale): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return t(locale, 'format.justNow');
  if (diffMin < 60) return `${diffMin}${locale === 'zh' ? '分钟前' : ' min ago'}`;
  if (diffHour < 24) return `${diffHour}${locale === 'zh' ? '小时前' : 'h ago'}`;
  if (diffDay < 7) return `${diffDay}${locale === 'zh' ? '天前' : 'd ago'}`;
  return new Date(timestamp).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric' });
}

/** Result of parsing session index from command args */
export type SessionParseResult =
  | { ok: false; error: 'invalid_index'; chatId: string }
  | { ok: false; error: 'index_out_of_range'; chatId: string; idx: number }
  | { ok: true; idx: number; sessions: ScannedSession[]; target: ScannedSession; showAll: boolean; currentCwd: string };

/**
 * Parse session index from command args and validate.
 * Shared helper for /session and /sessioninfo commands.
 */
export async function parseSessionIndex(ctx: CommandContext): Promise<SessionParseResult> {
  const sessionArgs = ctx.parts.slice(1);
  const showAll = hasFlag(sessionArgs, FLAGS.ALL);
  const idxToken = getNonFlagArg(sessionArgs, [FLAGS.ALL]);
  const idx = parseInt(idxToken || '', 10);

  if (Number.isNaN(idx) || idx < 1) {
    return { ok: false, error: 'invalid_index', chatId: ctx.msg.chatId };
  }

  const binding = await ctx.services.store.getBinding(ctx.msg.channelType, ctx.msg.chatId);
  const currentCwd = binding?.cwd || ctx.services.defaultWorkdir;
  const sessions = scanClaudeSessions(10, showAll ? undefined : currentCwd);

  if (idx > sessions.length) {
    return { ok: false, error: 'index_out_of_range', chatId: ctx.msg.chatId, idx };
  }

  return { ok: true, idx, sessions, target: sessions[idx - 1], showAll, currentCwd };
}