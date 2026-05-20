import { FLAGS, getNonFlagArg, hasFlag } from '../../core/args.js';
import type { ScannedSession } from '../../providers/session-scanner.js';
import { scanClaudeSessions } from '../../providers/session-scanner.js';
import type { CommandContext } from './types.js';

/** Result of parsing session index from command args. */
export type SessionParseResult =
  | { ok: false; error: 'invalid_index'; chatId: string }
  | { ok: false; error: 'index_out_of_range'; chatId: string; idx: number }
  | { ok: true; idx: number; sessions: ScannedSession[]; target: ScannedSession; showAll: boolean; currentCwd: string };

/**
 * Parse session index from command args and validate against scanned Claude Code sessions.
 * Shared helper for /session switching and detail commands.
 */
export async function parseSessionIndex(ctx: CommandContext): Promise<SessionParseResult> {
  const sessionArgs = ctx.parts.slice(1);
  const showAll = hasFlag(sessionArgs, FLAGS.ALL);
  const idxToken = getNonFlagArg(sessionArgs, [FLAGS.ALL]);
  const idx = parseInt(idxToken || '', 10);

  if (Number.isNaN(idx) || idx < 1) {
    return { ok: false, error: 'invalid_index', chatId: ctx.msg.chatId };
  }

  const binding = await ctx.services.store.getBinding(ctx.msg.channelType, ctx.scopeId);
  const currentCwd = binding?.cwd || ctx.services.defaultWorkdir;
  const sessions = scanClaudeSessions(10, showAll ? undefined : currentCwd);

  if (idx > sessions.length) {
    return { ok: false, error: 'index_out_of_range', chatId: ctx.msg.chatId, idx };
  }

  return { ok: true, idx, sessions, target: sessions[idx - 1], showAll, currentCwd };
}
