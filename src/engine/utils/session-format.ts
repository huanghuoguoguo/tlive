/**
 * Session formatting utilities — shared across session commands.
 */

import type { CommandContext } from '../commands/types.js';
import type { ScannedSession } from '../../session-scanner.js';
import { scanClaudeSessions } from '../../session-scanner.js';
import { FLAGS, hasFlag, getNonFlagArg } from '../../utils/constants.js';

/** Format file size in human-readable form */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** Format session modification date in localized form */
export function formatSessionDate(mtime: number): string {
  return new Date(mtime).toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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